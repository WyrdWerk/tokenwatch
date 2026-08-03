import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

// Import the API handler (ES module with named exports)
const api = await import('../functions/api/v1/[[route]].js');
const { onRequestGet, onRequestOptions } = api;

// ── Mock env.ASSETS — serves fixture JSON files ───────────────────────────────

function makeAssets() {
  return {
    async fetch(url) {
      const u = new URL(url);
      let filePath;
      if (u.pathname === '/pricing.json') filePath = join(FIXTURES, 'pricing.json');
      else if (u.pathname === '/image-pricing.json') filePath = join(FIXTURES, 'image-pricing.json');
      else if (u.pathname === '/video-pricing.json') filePath = join(FIXTURES, 'video-pricing.json');
      else return new Response('Not found', { status: 404 });
      try {
        const body = await readFile(filePath, 'utf-8');
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}

function makeContext(pathname, search = '') {
  const url = `https://tokenwatch.test${pathname}${search}`;
  return {
    request: new Request(url),
    env: { ASSETS: makeAssets() },
  };
}

async function getJson(ctx) {
  const res = await onRequestGet(ctx);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

// ── CORS ──────────────────────────────────────────────────────────────────────

test('CORS headers present on all responses', async () => {
  const { headers } = await getJson(makeContext('/api/v1/'));
  assert.equal(headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(headers.get('Content-Type'), 'application/json');
});

test('onRequestOptions returns empty body with CORS headers', async () => {
  const res = await onRequestOptions();
  assert.equal(res.status, 200);
  assert.equal(headers_get(res, 'Access-Control-Allow-Origin'), '*');
  const text = await res.text();
  assert.equal(text, '');
});

function headers_get(res, name) {
  return res.headers.get(name);
}

// ── Cost computation (mix-aware sort on /models/:id/providers) ─────────────────

test('/api/v1/models/:id/providers orders by mix-aware cost (inversion proves mix is applied)', async () => {
  // Fixture rows matching canonical gemini-3.1-pro:
  //   deepinfra (google/gemini-3.1-pro):        input=1.25, output=5,   cache_read=0.31
  //   google    (google/gemini-3.1-pro-preview): input=0.10, output=7,   cache_read=0.10  (-preview stripped)
  // Default (input+output) ranking: deepinfra 6.25 < google 7.10  → deepinfra first.
  // 30/50/20 mix ranking INVERTS it:
  //   deepinfra = (1.25*300)+(0.31*500)+(5*200)   = 375+155+1000 = 1530
  //   google    = (0.10*300)+(0.10*500)+(7*200)   = 30+50+1400   = 1480  → google first.
  // Asserting google-then-deepinfra proves the handler actually applied the mix weighting
  // (a default-cost or no-op sort would put deepinfra first and fail here).
  const { status, body } = await getJson(makeContext(
    '/api/v1/models/gemini-3.1-pro/providers?tokens=1000&mix=30,50,20'
  ));
  assert.equal(status, 200);
  assert.equal(body.model_count, 2);
  assert.deepEqual(body.providers.map(p => p.provider), ['google', 'deepinfra'],
    'mix-aware sort must rank google (1480) before deepinfra (1530)');
});

test('/api/v1/models/:id/providers mix-aware cost formula (formula-data coverage, not sort)', async () => {
  // Pins the documented hand-computed cost for the deepinfra row. This validates the
  // cost FORMULA against known pricing — it does NOT exercise ordering (see the test above).
  const { body } = await getJson(makeContext(
    '/api/v1/models/gemini-3.1-pro/providers?tokens=1000&mix=30,50,20'
  ));
  const deepinfra = body.providers.find(p => p.provider === 'deepinfra');
  assert.ok(deepinfra, 'deepinfra row should be present');
  const p = deepinfra.pricing;
  const total = 1000 * 1e6;
  let expected = 0;
  if (p.input != null) expected += (p.input * total * 0.30) / 1e6;
  const crPrice = p.cache_read != null ? p.cache_read : p.input;
  if (crPrice != null) expected += (crPrice * total * 0.50) / 1e6;
  if (p.output != null) expected += (p.output * total * 0.20) / 1e6;
  // input=1.25, cache_read=0.31, output=5 → 375 + 155 + 1000 = 1530.
  assert.equal(Math.round(expected), 1530, `expected mix-aware cost 1530, got ${expected}`);
});

// ── /api/v1/ (root) ───────────────────────────────────────────────────────────

test('/api/v1/ returns API info + endpoint directory', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/'));
  assert.equal(status, 200);
  assert.equal(body.model_count, 5); // fixture has 5 models
  assert.ok(Array.isArray(body.endpoints));
  assert.ok(body.endpoints.length >= 8);
  assert.ok(body.endpoints.some(e => e.includes('/models')));
});

// ── /api/v1/stats ─────────────────────────────────────────────────────────────

test('/api/v1/stats returns correct counts', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/stats'));
  assert.equal(status, 200);
  assert.equal(body.model_count, 5);
  assert.equal(body.zdr_count, 2); // gemini-3.1-pro + claude-sonnet-5
  assert.equal(body.subscription_count, 1); // gemini-3.1-pro-preview-customtools
  assert.ok(body.providers);
  assert.ok(body.orgs);
  assert.ok(body.quantizations);
});

// ── /api/v1/models (filters + sort) ───────────────────────────────────────────

test('/api/v1/models returns all models by default', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models'));
  assert.equal(status, 200);
  assert.equal(body.total, 5);
  assert.equal(body.models.length, 5);
});

test('?org=google filters to google models', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?org=google'));
  assert.equal(body.total, 3); // gemini-3.1-pro, gemini-3.1-pro-preview, gemini-3.1-pro-preview-customtools
  for (const m of body.models) assert.equal(m.org, 'google');
});

test('?provider=deepinfra filters by provider', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?provider=deepinfra'));
  assert.equal(body.total, 1);
  assert.equal(body.models[0].provider, 'deepinfra');
});

test('?zdr=true filters to ZDR models', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?zdr=true'));
  assert.equal(body.total, 2);
  for (const m of body.models) assert.equal(m.zdr, true);
});

test('?promo=true filters to discounted models', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?promo=true'));
  assert.equal(body.total, 1);
  assert.ok(body.models[0].discount > 0);
});

test('?sub=true filters to subscription models', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?sub=true'));
  assert.equal(body.total, 1);
  assert.equal(body.models[0].subscription, true);
});

test('?search=claude matches across fields', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?search=claude'));
  assert.equal(body.total, 1);
  assert.equal(body.models[0].id, 'anthropic/claude-sonnet-5');
});

test('?sort=input orders by input price ascending', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?sort=input&order=asc'));
  const prices = body.models.map(m => m.pricing.input);
  for (let i = 1; i < prices.length; i++) {
    assert.ok(prices[i] >= prices[i - 1], `not ascending at ${i}: ${prices[i-1]} > ${prices[i]}`);
  }
});

test('?sort=output&order=desc orders descending', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?sort=output&order=desc'));
  const prices = body.models.map(m => m.pricing.output);
  for (let i = 1; i < prices.length; i++) {
    assert.ok(prices[i] <= prices[i - 1], `not descending at ${i}: ${prices[i-1]} < ${prices[i]}`);
  }
});

test('?sort=<invalid> silently falls back to id (documented behavior)', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?sort=price'));
  // Invalid sort → falls back to 'id' (alphabetical) — no error, HTTP 200
  // This documents the silent-fallback behavior noted in the issue analysis.
  const ids = body.models.map(m => m.id);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
});

test('?sort=intelligence orders by benchmark index desc (nulls last)', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?sort=intelligence&order=desc'));
  // Claude Sonnet 5 (53.4) > Gemini 3.1 Pro (48.2) > unscored models (null, pushed last)
  const scored = body.models.filter(m => m.benchmarks?.intelligence_index != null);
  assert.equal(scored.length, 2, 'two fixture models have AA indices');
  assert.equal(scored[0].id, 'anthropic/claude-sonnet-5');
  assert.equal(scored[1].id, 'google/gemini-3.1-pro');
});

test('?sort=coding orders by coding index desc (nulls last)', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?sort=coding&order=desc'));
  const scored = body.models.filter(m => m.benchmarks?.coding_index != null);
  // Claude (72.4) > Gemini (60.1)
  assert.equal(scored[0].id, 'anthropic/claude-sonnet-5');
  assert.equal(scored[1].id, 'google/gemini-3.1-pro');
});

test('?benchmarked=true filters to scored models only', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?benchmarked=true'));
  // Only gemini-3.1-pro and claude-sonnet-5 have benchmarks blocks in the fixture
  assert.equal(body.models.length, 2);
  for (const m of body.models) {
    assert.ok(m.benchmarks, `model ${m.id} should have benchmarks block`);
  }
});

test('?limit=2 paginates results', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?limit=2'));
  assert.equal(body.total, 5);
  assert.equal(body.models.length, 2);
  assert.equal(body.limit, 2);
});

test('?limit=2&offset=2 returns the next page', async () => {
  const page1 = (await getJson(makeContext('/api/v1/models', '?limit=2&offset=0'))).body.models;
  const page2 = (await getJson(makeContext('/api/v1/models', '?limit=2&offset=2'))).body.models;
  assert.equal(page2.length, 2);
  const page1Ids = new Set(page1.map(m => m.id));
  for (const m of page2) assert.ok(!page1Ids.has(m.id), 'no overlap between pages');
});

test('?limit=-5 clamps to the default (negative limit must not drop trailing rows)', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?limit=-5'));
  assert.equal(body.limit, 100); // invalid → default
  assert.equal(body.models.length, 5); // fixture has 5; a negative slice would have returned 0
});

test('?limit=0 and ?limit=abc fall back to the default limit', async () => {
  for (const raw of ['0', 'abc']) {
    const { body } = await getJson(makeContext('/api/v1/models', `?limit=${raw}`));
    assert.equal(body.limit, 100, `limit=${raw} should default to 100`);
  }
});

test('?limit=2&offset=-1 clamps offset to 0 (negative offset must not slice from the end)', async () => {
  const clamped = (await getJson(makeContext('/api/v1/models', '?limit=2&offset=-1'))).body;
  const normal = (await getJson(makeContext('/api/v1/models', '?limit=2&offset=0'))).body;
  assert.equal(clamped.offset, 0);
  assert.deepEqual(clamped.models.map(m => m.id), normal.models.map(m => m.id),
    'offset=-1 must behave like offset=0, not return the last page');
});

test('?min_context=500000 filters by context length', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?min_context=500000'));
  for (const m of body.models) {
    assert.ok(m.context_length >= 500000);
  }
});
test('?min_intelligence=50 filters out models with intelligence_index < 50 and excludes null', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?min_intelligence=50'));
  for (const m of body.models) {
    assert.ok(m.benchmarks?.intelligence_index != null, `${m.id} should have non-null intelligence_index`);
    assert.ok(m.benchmarks.intelligence_index >= 50, `${m.id} should have intelligence_index >= 50`);
  }
});

test('?min_intelligence=0 returns all models (0 means no filter)', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?min_intelligence=0'));
  const withNull = body.models.filter(m => m.benchmarks?.intelligence_index == null);
  assert.ok(withNull.length > 0, '0 should not filter — null intelligence_index models included');
});

test('?min_intelligence=100 excludes all models (no model has IQ ≥ 100)', async () => {
  const { body } = await getJson(makeContext('/api/v1/models', '?min_intelligence=100'));
  assert.equal(body.models.length, 0, 'no model should have intelligence_index >= 100');
});

test('?min_intelligence without filter returns all models including null', async () => {
  const { body } = await getJson(makeContext('/api/v1/models'));
  const withNull = body.models.filter(m => m.benchmarks?.intelligence_index == null);
  assert.ok(withNull.length > 0, 'fixture has models with null intelligence_index');
});

// ── /api/v1/models/:id/providers (the regression fix) ─────────────────────────

test('/models/gemini-3.1-pro/providers returns pro + pro-preview (not customtools)', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models/gemini-3.1-pro/providers'));
  assert.equal(status, 200);
  assert.equal(body.canonical_id, 'gemini-3.1-pro');
  // gemini-3.1-pro-preview canonicalizes to gemini-3.1-pro (bare -preview stripped)
  // gemini-3.1-pro-preview-customtools does NOT (preserved as distinct)
  assert.equal(body.model_count, 2);
  const providerNames = body.providers.map(p => p.provider);
  assert.ok(providerNames.includes('deepinfra'));
  assert.ok(providerNames.includes('google'));
});

test('/models/gemini-3.1-pro-preview-customtools/providers returns ONLY the customtools variant', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models/gemini-3.1-pro-preview-customtools/providers'));
  assert.equal(status, 200);
  assert.equal(body.canonical_id, 'gemini-3.1-pro-preview-customtools');
  assert.equal(body.model_count, 1);
  assert.equal(body.providers[0].provider, 'google');
});

test('/models/gemini-3.1-pro-preview/providers folds into pro (bare -preview stripped)', async () => {
  const { body } = await getJson(makeContext('/api/v1/models/gemini-3.1-pro-preview/providers'));
  assert.equal(body.canonical_id, 'gemini-3.1-pro');
  assert.equal(body.model_count, 2);
});

test('/models/claude-sonnet-5/providers accepts bare canonical ID', async () => {
  const { body } = await getJson(makeContext('/api/v1/models/claude-sonnet-5/providers'));
  assert.equal(body.model_count, 1);
  assert.equal(body.providers[0].provider, 'anthropic');
});

test('/models/anthropic/claude-sonnet-5/providers accepts full org/model ID', async () => {
  const { body } = await getJson(makeContext('/api/v1/models/anthropic/claude-sonnet-5/providers'));
  assert.equal(body.model_count, 1);
});

test('/models/:id/providers with ?tokens=&mix= does mix-aware cost sort', async () => {
  const { body } = await getJson(makeContext('/api/v1/models/gemini-3.1-pro/providers', '?tokens=100&mix=50,0,50'));
  assert.equal(body.model_count, 2);
  // 50/0/50 mix (no cache): cost = 0.5*input + 0.5*output (per-token halves of input+output).
  //   deepinfra = (1.25*50)+(5*50)   = 62.5+250 = 312.5
  //   google    = (0.10*50)+(7*50)   = 5+350    = 355.0
  // Ranking matches default input+output order here (deepinfra first) — unlike the 30/50/20
  // cache-heavy mix above, which inverts it. Both providers present; deepinfra is cheapest.
  assert.equal(body.providers.length, 2);
  assert.equal(body.providers[0].provider, 'deepinfra', 'deepinfra (312.5) should outrank google (355) at 50/0/50');
});

test('/models/nonexistent/providers returns 404', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models/nonexistent/providers'));
  assert.equal(status, 404);
  assert.equal(body.error, 'Model not found');
});

// ── /api/v1/models routing contract (shape gate) ──────────────────────────────

test('/api/v1/models and /api/v1/models/ both return the list', async () => {
  const a = await getJson(makeContext('/api/v1/models'));
  const b = await getJson(makeContext('/api/v1/models/'));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.total, b.body.total);
});

test('/models/:id with a non-providers suffix returns 404 (not the list)', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models/foo'));
  assert.equal(status, 404);
  assert.equal(body.error, 'Not found');
});

test('/models/:id/sub (extra segment, no providers) returns 404', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models/foo/bar'));
  assert.equal(status, 404);
  assert.equal(body.error, 'Not found');
});

test('/models/providers (empty id) returns 404', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models/providers'));
  assert.equal(status, 404);
  assert.equal(body.error, 'Not found');
});

test('/models/models returns 404 (bare models path must not masquerade as list)', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/models/models'));
  assert.equal(status, 404);
  assert.equal(body.error, 'Not found');
});

test('/models/:id/providers with malformed %-encoding returns 400 JSON, not an uncaught URIError', async () => {
  const res = await onRequestGet(makeContext('/api/v1/models/%E0%A4%A/providers'));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  const body = await res.json();
  assert.equal(body.error, 'Invalid model id encoding');
});

test('/api/v1/images/:id with malformed %-encoding returns 400 JSON, not an uncaught URIError', async () => {
  const res = await onRequestGet(makeContext('/api/v1/images/%E0%A4%A'));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  const body = await res.json();
  assert.equal(body.error, 'Invalid model id encoding');
});

test('/api/v1/videos/:id with malformed %-encoding returns 400 JSON, not an uncaught URIError', async () => {
  const res = await onRequestGet(makeContext('/api/v1/videos/%E0%A4%A'));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  const body = await res.json();
  assert.equal(body.error, 'Invalid model id encoding');
});

// ── /api/v1/orgs ──────────────────────────────────────────────────────────────

test('/api/v1/orgs returns orgs sorted by count desc', async () => {
  const { body } = await getJson(makeContext('/api/v1/orgs'));
  assert.ok(Array.isArray(body.orgs));
  assert.ok(body.orgs.length >= 3); // google, anthropic, openai
  // google has 3 models — should be first
  assert.equal(body.orgs[0].org, 'google');
  assert.equal(body.orgs[0].model_count, 3);
});

// ── /api/v1/providers ─────────────────────────────────────────────────────────

test('/api/v1/providers returns provider metadata', async () => {
  const { body } = await getJson(makeContext('/api/v1/providers'));
  assert.ok(body.providers_meta.deepinfra);
  assert.equal(body.providers_meta.deepinfra.retains_prompts, false);
});

test('/api/v1/providers?zdr=true filters to ZDR-compliant providers', async () => {
  const { body } = await getJson(makeContext('/api/v1/providers', '?zdr=true'));
  const keys = Object.keys(body.providers_meta);
  assert.ok(keys.includes('deepinfra')); // retains_prompts: false
  assert.ok(keys.includes('anthropic')); // retains_prompts: false
  assert.ok(!keys.includes('google')); // retains_prompts: true
});

// ── /api/v1/images ────────────────────────────────────────────────────────────

test('/api/v1/images returns all image models', async () => {
  const { body } = await getJson(makeContext('/api/v1/images'));
  assert.equal(body.total, 2);
});

test('/api/v1/images/gemini-3.1-flash-lite-image returns full record with pricing', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/images/gemini-3.1-flash-lite-image'));
  assert.equal(status, 200);
  assert.equal(body.model.id, 'google/gemini-3.1-flash-lite-image');
  assert.ok(Array.isArray(body.model.pricing));
  assert.equal(body.model.pricing[0].unit, 'token');
});

test('/api/v1/images accepts full org/model ID too', async () => {
  const { body } = await getJson(makeContext('/api/v1/images/google/gemini-3.1-flash-lite-image'));
  assert.equal(body.model.id, 'google/gemini-3.1-flash-lite-image');
});

test('/api/v1/images/nonexistent returns 404', async () => {
  const { status } = await getJson(makeContext('/api/v1/images/nonexistent'));
  assert.equal(status, 404);
});

test('/api/v1/images/:id with malformed %-encoding returns 400 JSON, not an uncaught URIError', async () => {
  const res = await onRequestGet(makeContext('/api/v1/images/%E0%A4%A'));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  const body = await res.json();
  assert.equal(body.error, 'Invalid model id encoding');
});

// ── /api/v1/videos ────────────────────────────────────────────────────────────

test('/api/v1/videos returns all video models', async () => {
  const { body } = await getJson(makeContext('/api/v1/videos'));
  assert.equal(body.total, 2);
});

test('/api/v1/videos/sora-2-pro returns full record with pricing variants', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/videos/sora-2-pro'));
  assert.equal(status, 200);
  assert.equal(body.model.id, 'openai/sora-2-pro');
  assert.ok(Array.isArray(body.model.pricing));
  assert.equal(body.model.pricing.length, 2); // 720p + 1080p
});

test('/api/v1/videos/openai/sora-2-pro accepts full org/model ID', async () => {
  const { body } = await getJson(makeContext('/api/v1/videos/openai/sora-2-pro'));
  assert.equal(body.model.id, 'openai/sora-2-pro');
});

test('/api/v1/videos/:id with malformed %-encoding returns 400 JSON, not an uncaught URIError', async () => {
  const res = await onRequestGet(makeContext('/api/v1/videos/%E0%A4%A'));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  const body = await res.json();
  assert.equal(body.error, 'Invalid model id encoding');
});

// ── 404 ───────────────────────────────────────────────────────────────────────

test('unknown path returns 404', async () => {
  const { status, body } = await getJson(makeContext('/api/v1/nonexistent'));
  assert.equal(status, 404);
  assert.equal(body.error, 'Not found');
});
