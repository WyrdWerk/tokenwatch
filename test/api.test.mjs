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

test('API success, errors, optional history, and preflight expose noindex without blocking data access', async () => {
  for (const [path, status] of [
    ['/api/v1/stats', 200], ['/api/v1/unknown', 404],
    ['/api/v1/models/gemini-3.1-pro/history', 503],
  ]) {
    const response = await onRequestGet(makeContext(path));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  }
  assert.equal((await onRequestOptions()).headers.get('X-Robots-Tag'), 'noindex');
  const advisor = await import('../functions/api/advisor.js');
  assert.equal((await advisor.onRequestOptions()).headers.get('X-Robots-Tag'), 'noindex');
  const error = await advisor.onRequestPost({
    request: new Request('https://tokenwatch.test/api/advisor', { method: 'POST', body: 'not json' }),
    env: {},
  });
  assert.ok(error.status >= 400);
  assert.equal(error.headers.get('X-Robots-Tag'), 'noindex');
});

test('Advisor evidence preserves zero scores, labels unknowns, and states its price mix', async (t) => {
  const advisor = await import('../functions/api/advisor.js');
  let prompt;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    prompt = JSON.parse(options.body).messages[0].content;
    return Response.json({ choices: [{ message: { content: 'Fixture reply' } }] });
  });
  const response = await advisor.onRequestPost({
    request: new Request('https://tokenwatch.test/api/advisor', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '198.51.100.200', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Compare these offerings.' }] }),
    }),
    env: {
      INFERX_BASE_URL: 'https://advisor.invalid/v1', INFERX_API_KEY: 'test-placeholder',
      ASSETS: { fetch: async (url) => {
        assert.equal(new URL(url).pathname, '/advisor-knowledge.json');
        return Response.json({
          stats: { total_text_models: 3, total_zdr_models: 3, total_providers: 2 },
          top_zdr_models: [
            { name: 'Unknown model', provider: 'a', blended: 0.1, scores: null },
            { name: 'Zero model', provider: 'a', blended: 0.2, scores: { intelligence: 0, coding: 0 } },
            { name: 'Partial model', provider: 'b', blended: 0.3, scores: { intelligence: 61 } },
          ],
          providers: [{ id: 'a', zdr: true }, { id: 'b', zdr: false }],
        });
      } },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal((await response.json()).reply, 'Fixture reply');
  assert.match(prompt, /Unknown model[^\n]+Intel:unknown, Coding:unknown/);
  assert.match(prompt, /Zero model[^\n]+Intel:0, Coding:0/);
  assert.match(prompt, /Partial model[^\n]+Intel:61, Coding:unknown/);
  assert.match(prompt, /- a[^\n]+ZDR:Yes/);
  assert.match(prompt, /- b[^\n]+ZDR:Not confirmed/);
  assert.match(prompt, /Total Live Text Offerings: 3/);
  assert.match(prompt, /50% input, 0% cached input, 50% output/);
  assert.match(prompt, /Acknowledge missing or unavailable data/);
  assert.doesNotMatch(prompt, /Intel:58\+|Coding:75\+|Do not state you lack data/);
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

test('/models/:id/providers applies higher write tariffs only in the mix-aware ranking', async () => {
  const catalog = { models: [
    { id: 'cache-tariff-test', provider: 'alpha', pricing: { input: 1, cache_write: 10, cache_read: 0.1, output: 1 } },
    { id: 'cache-tariff-test', provider: 'beta', pricing: { input: 2, cache_write: 0, cache_read: 0.2, output: 1 } },
  ] };
  const ctx = makeContext('/api/v1/models/cache-tariff-test/providers', '?tokens=2&mix=20,50,30');
  ctx.env.ASSETS = { fetch: async () => new Response(JSON.stringify(catalog)) };
  const { status, body } = await getJson(ctx);
  assert.equal(status, 200);
  // Alpha: (10×0.2 + 0.1×0.5 + 1×0.3)×2 = $4.70; beta: $1.60.
  assert.deepEqual(body.providers.map(p => p.provider), ['beta', 'alpha']);
  assert.equal(body.providers[1].pricing.input, 1, 'published input price is never replaced');
  ctx.request = new Request('https://tokenwatch.test/api/v1/models/cache-tariff-test/providers');
  const raw = await getJson(ctx);
  assert.deepEqual(raw.body.providers.map(p => p.provider), ['alpha', 'beta'], 'no-mix sorting keeps raw-price semantics');
});

test('/models/:id/providers ranks explicit lower write billing ahead of cheaper raw input', async () => {
  const catalog = { models: [
    { id: 'default-billing-test', provider: 'coralbricks', pricing: { input: 0.3, cache_write: 0.09, cache_read: 0, output: 1.2, input_billing: 'cache_write' } },
    { id: 'default-billing-test', provider: 'other', pricing: { input: 0.12, cache_read: 0, output: 1.2 } },
  ] };
  const ctx = makeContext('/api/v1/models/default-billing-test/providers', '?tokens=1000&mix=2.5,97,0.5');
  ctx.env.ASSETS = { fetch: async () => new Response(JSON.stringify(catalog)) };
  const { status, body } = await getJson(ctx);
  assert.equal(status, 200);
  // CoralBricks: $8.25; other: $9. Raw-input comparison would invert the winner.
  assert.deepEqual(body.providers.map(p => p.provider), ['coralbricks', 'other']);
  assert.equal(body.providers[0].pricing.input_billing, 'cache_write');
  assert.equal(body.providers[0].pricing.input, 0.3);
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
  assert.ok(body.endpoints.some(e => e.includes('open_weights')));
});

test('/api/v1/use-cases lists the shared recommendation presets and marks mixes as assumed', async () => {
  const { status, body, headers } = await getJson(makeContext('/api/v1/use-cases'));
  assert.equal(status, 200);
  assert.equal(headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(body.use_cases.length, 9);
  const agentic = body.use_cases.find((useCase) => useCase.id === 'agentic-coding');
  assert.deepEqual(agentic.mix, { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5, assumed: true });
  assert.ok(agentic.weights.benchmark.coding_index > 0);
  assert.ok(agentic.weights.provider.throughput > 0);
  assert.deepEqual(agentic.requirements, { needsToolCalling: true, needsStructuredOutput: false, minContext: 32768 });
  assert.deepEqual(agentic.floors, { field: 'coding_index', min: 25 });
});

function recommendationAssets(catalog, arenaSource = null) {
  const benchmarkRows = catalog.models.map((model, index) => ({
    id: model.id,
    scores: model.benchmarks || (index === 3 ? {} : {
      aa_agentic: 50 + index,
      aa_coding: 45 + index,
      aa_intelligence: 55 + index,
      livebench_agentic_coding: 60 + index,
    }),
  }));
  const performance = Object.fromEntries(catalog.models.map((model, index) => [
    `${model.id.split('/').at(-1)}|${model.provider}`,
    { source: 'openrouter', latency: { p50: 1000 - index * 100 }, throughput: { p50: 50 + index * 10 } },
  ]));
  return {
    async fetch(url) {
      const pathname = new URL(url).pathname;
      if (pathname === '/pricing.json') return Response.json(catalog);
      if (pathname === '/benchmarks.json') return Response.json({
        generated_at: '2026-10-04T00:00:00Z',
        ...(arenaSource ? { sources: { arena: arenaSource } } : {}),
        models: benchmarkRows,
      });
      if (pathname === '/performance.json') return Response.json({ ...performance, _meta: { generated_at: '2026-10-04T00:00:00Z' } });
      return new Response('Not found', { status: 404 });
    },
  };
}

function recommendationCatalog() {
  const model = (id, provider, extra = {}) => ({
    id: `open/${id}`,
    name: id,
    org: 'open',
    provider,
    provider_display: provider === 'beta-provider' ? 'Beta Provider' : provider,
    open_weights: true,
    open_weights_source: 'fixture',
    supported_parameters: ['tools'],
    context_length: 65536,
    quantization: 'fp8',
    zdr: true,
    headquarters: provider === 'cn-provider' ? 'CN' : 'US',
    pricing: { input: 1, output: 2, cache_read: 0.1, cache_write: null },
    benchmarks: {
      agentic_index: 50,
      coding_index: 45,
      intelligence_index: 55,
      livebench_agentic_coding: 60,
    },
    ...extra,
  });
  return {
    generated_at: '2026-10-04T00:00:00Z',
    providers_meta: { 'cn-provider': { headquarters: 'CN' }, 'us-provider': { headquarters: 'US' } },
    models: [
      model('agent-alpha', 'us-provider'),
      model('agent-beta', 'cn-provider'),
      model('partly-scored', 'us-provider', { benchmarks: { intelligence_index: 30 } }),
      model('not-scored', 'us-provider', { benchmarks: null }),
    ],
  };
}

test('/api/v1/recommend uses shared shortlist groups with explanations, confidence, and supported constraints', async () => {
  const context = makeContext('/api/v1/recommend', '?use_case=agentic-coding&priority=fastest&zdr=true&exclude_hq=CN');
  context.env.ASSETS = recommendationAssets(recommendationCatalog());
  const { status, body, headers } = await getJson(context);
  assert.equal(status, 200);
  assert.equal(headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(body.useCase, 'agentic-coding');
  assert.equal(body.priority, 'fastest');
  assert.deepEqual(body.mix, { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5, assumed: true });
  assert.ok(body.picks.bestQuality.explanation);
  assert.ok(body.picks.bestQuality.confidence);
  for (const group of [body.alsoConsidered, body.partiallyBenchmarked, body.unbenchmarked, body.unverified]) {
    assert.ok(Number.isInteger(group.totalCount));
    assert.ok(Array.isArray(group.items));
    assert.ok(group.items.length <= 10);
    assert.ok(group.items.every((candidate) => {
      assert.deepEqual(Object.keys(candidate).sort(), ['blendedRate', 'coverage', 'id', 'name', 'reason', 'score']);
      return true;
    }));
  }
  assert.ok(body.partiallyBenchmarked.items.some((candidate) => candidate.id === 'partly-scored'));
  assert.ok(body.unbenchmarked.items.some((candidate) => candidate.id === 'not-scored'));
  assert.ok(!JSON.stringify(body).includes('cn-provider'), 'exclude_hq filters known CN provider offerings');
});

test('/api/v1/recommend exposes the Arena favorite separately from chat capability picks with attribution metadata', async () => {
  const catalog = recommendationCatalog();
  const base = catalog.models[0];
  const model = (id, provider, intelligence, language, instruction, text, creative) => ({
    ...base,
    id: `open/${id}`,
    name: id,
    provider,
    provider_display: provider === 'beta-provider' ? 'Beta Provider' : provider,
    benchmarks: {
      intelligence_index: intelligence,
      livebench_language: language,
      livebench_instruction_following: instruction,
      arena_text: text,
      arena_creative_writing: creative,
    },
  });
  catalog.models = [
    model('capability-winner', 'alpha-provider', 80, 90, 80, 1400, 1400),
    model('arena-favorite', 'beta-provider', 20, 80, 70, 1600, 1600),
  ];
  catalog.providers = [
    { key: 'alpha-provider', name: 'Alpha Provider' },
    { key: 'beta-provider', name: 'Beta Provider' },
  ];
  const arenaSource = {
    name: 'Arena (LMArena)',
    url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
    license: 'CC-BY-4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Arena (LMArena), Leaderboard Dataset; licensed under CC BY 4.0.',
    rating_dates: { arena_text: '2026-10-02', arena_creative_writing: '2026-10-02' },
  };
  const context = makeContext('/api/v1/recommend', '?use_case=chat-assistant');
  context.env.ASSETS = recommendationAssets(catalog, arenaSource);

  const chat = await getJson(context);
  assert.equal(chat.status, 200);
  assert.equal(chat.body.picks.bestQuality.id, 'capability-winner');
  assert.equal(chat.body.preference.favorite.id, 'arena-favorite');
  assert.equal(chat.body.preference.favorite.rating, 1600);
  assert.equal(chat.body.preference.board, 'Text overall');
  assert.equal(chat.body.preference.source.license, 'CC-BY-4.0');
  assert.equal(chat.body.preference.source.rating_date, '2026-10-02');
  assert.equal(chat.body.preference.source.attribution, arenaSource.attribution);
  assert.equal(chat.body.preference.favorite.providers[0].name, 'Beta Provider');

  context.request = new Request('https://tokenwatch.test/api/v1/recommend?use_case=creative-writing');
  const writing = await getJson(context);
  assert.equal(writing.body.preference.favorite.id, 'arena-favorite');
  assert.equal(writing.body.preference.board, 'Creative writing');
  assert.equal(writing.body.preference.source.rating_date, '2026-10-02');
});

test('/api/v1/recommend supports full detail and a validated limit for candidate groups', async () => {
  const context = makeContext('/api/v1/recommend', '?use_case=agentic-coding&detail=full&limit=1');
  context.env.ASSETS = recommendationAssets(recommendationCatalog());
  const { status, body } = await getJson(context);
  assert.equal(status, 200);
  assert.ok(body.picks.bestQuality.recommendedProvider.explanation);
  for (const group of [body.alsoConsidered, body.partiallyBenchmarked, body.unbenchmarked, body.unverified]) {
    assert.equal(group.items.length, Math.min(group.totalCount, 1));
    assert.ok(group.items.every((candidate) => candidate.explanation));
  }
});

test('/api/v1/recommend returns compact JSON unless pretty=1, with short unverified provider rows', async () => {
  const catalog = recommendationCatalog();
  catalog.models.push({ ...catalog.models[0], provider: 'mystery-provider', supported_parameters: null, context_length: null });
  const context = makeContext('/api/v1/recommend', '?use_case=agentic-coding');
  context.env.ASSETS = recommendationAssets(catalog);
  const compact = await onRequestGet(context);
  const compactText = await compact.text();
  assert.equal(compact.status, 200);
  assert.ok(!compactText.includes('\n'), 'default recommendation JSON has no indentation');
  const body = JSON.parse(compactText);
  const unverified = body.picks.bestQuality.unverifiedProviders;
  assert.ok(unverified.length >= 1, 'fixture produces an unverified provider');
  for (const row of unverified) {
    assert.deepEqual(Object.keys(row).sort(), ['blendedRate', 'offeringId', 'provider', 'reason']);
  }

  context.request = new Request('https://tokenwatch.test/api/v1/recommend?use_case=agentic-coding&pretty=1');
  const prettyText = await (await onRequestGet(context)).text();
  assert.match(prettyText, /^\{\n  "/);
  assert.deepEqual(JSON.parse(prettyText), body);

  context.request = new Request('https://tokenwatch.test/api/v1/recommend?use_case=agentic-coding&detail=full');
  const full = JSON.parse(await (await onRequestGet(context)).text());
  assert.ok(Array.isArray(full.picks.bestQuality.unverifiedProviders[0].unknowns));

  context.request = new Request('https://tokenwatch.test/api/v1/recommend/providers?use_case=agentic-coding&model=agent-alpha');
  const providersText = await (await onRequestGet(context)).text();
  assert.ok(!providersText.includes('\n'));
  const providers = JSON.parse(providersText);
  assert.ok(providers.unverified.totalCount >= 1);
  assert.deepEqual(Object.keys(providers.unverified.items[0]).sort(), ['blendedRate', 'offeringId', 'provider', 'reason']);

  context.request = new Request('https://tokenwatch.test/api/v1/recommend?use_case=agentic-coding&pretty=yes');
  const invalid = await onRequestGet(context);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).parameter, 'pretty');
});

test('/api/v1/recommend default response stays under 50 KB with the committed catalogs', async () => {
  const publicDir = join(__dirname, '..', 'public');
  const catalogFiles = Object.fromEntries(await Promise.all(
    ['pricing.json', 'benchmarks.json', 'performance.json'].map(async (filename) => [
      filename,
      JSON.parse(await readFile(join(publicDir, filename), 'utf8')),
    ]),
  ));
  const assets = {
    async fetch(url) {
      const filename = new URL(url).pathname.slice(1);
      return catalogFiles[filename]
        ? Response.json(catalogFiles[filename])
        : new Response('Not found', { status: 404 });
    },
  };
  const response = await onRequestGet({
    request: new Request('https://tokenwatch.test/api/v1/recommend?use_case=agentic-coding'),
    env: { ASSETS: assets },
  });
  const serialized = await response.text();
  const body = JSON.parse(serialized);
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(serialized) < 50 * 1024, `default response was ${Buffer.byteLength(serialized)} bytes`);
  assert.ok(body.picks.bestQuality.explanation);
  for (const pick of Object.values(body.picks)) {
    if (!pick) continue;
    assert.ok(!pick.recommendedProvider?.explanation);
    assert.ok(!pick.cheapestProvider?.explanation);
  }
  for (const group of [body.alsoConsidered, body.partiallyBenchmarked, body.unbenchmarked, body.unverified]) {
    assert.ok(group.items.length <= 10);
    assert.ok(group.totalCount >= group.items.length);
    assert.ok(group.items.every((candidate) => !candidate.explanation));
  }
});

test('/api/v1/recommend validates use case, priority, booleans, and HQ codes', async () => {
  for (const query of [
    '',
    '?use_case=unknown',
    '?use_case=agentic-coding&priority=quickest',
    '?use_case=agentic-coding&zdr=yes',
    '?use_case=agentic-coding&include_proprietary=1',
    '?use_case=agentic-coding&exclude_hq=CN,',
    '?use_case=agentic-coding&detail=verbose',
    '?use_case=agentic-coding&limit=0',
    '?use_case=agentic-coding&limit=101',
  ]) {
    const context = makeContext('/api/v1/recommend', query);
    context.env.ASSETS = recommendationAssets(recommendationCatalog());
    const { status } = await getJson(context);
    assert.equal(status, 400, query || 'missing use_case');
  }
});

test('/api/v1/recommend/providers ranks a canonical model and returns 400/404 for invalid requests', async () => {
  const catalog = recommendationCatalog();
  const context = makeContext('/api/v1/recommend/providers', '?use_case=agentic-coding&model=agent-alpha&exclude_hq=CN');
  context.env.ASSETS = recommendationAssets(catalog);
  const { status, body } = await getJson(context);
  assert.equal(status, 200);
  assert.deepEqual(body.mix, { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5, assumed: true });
  assert.deepEqual(body.ranked.items.map((provider) => provider.provider), ['us-provider']);
  assert.equal(body.ranked.totalCount, 1);
  assert.ok(body.ranked.items[0].explanation);
  assert.ok(body.ranked.items[0].confidence);

  context.request = new Request('https://tokenwatch.test/api/v1/recommend/providers?use_case=agentic-coding');
  assert.equal((await getJson(context)).status, 400);
  context.request = new Request('https://tokenwatch.test/api/v1/recommend/providers?use_case=agentic-coding&model=missing');
  assert.equal((await getJson(context)).status, 404);
  context.request = new Request('https://tokenwatch.test/api/v1/recommend/providers?use_case=agentic-coding&model=agent-alpha&priority=balancedish');
  assert.equal((await getJson(context)).status, 400);
});

test('/api/v1/recommend/providers explains the top three, compacts the rest, and limits provider groups', async () => {
  const catalog = recommendationCatalog();
  const original = catalog.models[0];
  const providers = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  catalog.models = providers.map((provider, index) => ({
    ...original,
    provider,
    pricing: { ...original.pricing, input: 1 + index, output: 2 + index },
  }));
  const context = makeContext('/api/v1/recommend/providers', '?use_case=agentic-coding&model=agent-alpha&limit=4');
  context.env.ASSETS = recommendationAssets(catalog);
  const { status, body } = await getJson(context);
  assert.equal(status, 200);
  assert.equal(body.ranked.totalCount, 6);
  assert.equal(body.ranked.items.length, 4);
  assert.ok(body.ranked.items.slice(0, 3).every((provider) => provider.explanation));
  assert.ok(!body.ranked.items[3].explanation);
  assert.equal(body.unverified.totalCount, 0);
  assert.deepEqual(Object.keys(body.ranked.items[3]).sort(), ['blendedRate', 'confidence', 'name', 'provider', 'reason', 'score']);

  context.request = new Request('https://tokenwatch.test/api/v1/recommend/providers?use_case=agentic-coding&model=agent-alpha&detail=full&limit=4');
  const full = await getJson(context);
  assert.ok(full.body.ranked.items.every((provider) => provider.explanation));
});

test('recommendation assets are required and unknown canonical models return 404 before asset loading', async () => {
  const requestedAssets = [];
  const context = makeContext('/api/v1/recommend?use_case=agentic-coding');
  context.env.ASSETS = {
    async fetch(url) {
      const path = new URL(url).pathname;
      requestedAssets.push(path);
      if (path === '/pricing.json') return Response.json(recommendationCatalog());
      return new Response('Not found', { status: 404 });
    },
  };
  assert.equal((await getJson(context)).status, 503, 'missing benchmarks/performance must not silently degrade recommendations');
  assert.ok(requestedAssets.includes('/benchmarks.json'));
  assert.ok(requestedAssets.includes('/performance.json'));

  requestedAssets.length = 0;
  context.request = new Request('https://tokenwatch.test/api/v1/recommend/providers?use_case=agentic-coding&model=missing-model');
  assert.equal((await getJson(context)).status, 404);
  assert.deepEqual(requestedAssets, ['/pricing.json'], 'unknown model is known before required recommender assets load');
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

test('/api/v1/models filters on resolved open-weight status and providers exposes the contract', async () => {
  const catalog = { models: [
    {
      id: 'open-model', org: 'deepseek', provider: 'alpha', open_weights: true,
      open_weights_source: 'override', license: 'mit', pricing: { input: 1, output: 2 },
      supported_parameters: ['tools'], supports_tool_choice: true,
      supports_implicit_caching: false, max_prompt_tokens: 12000, uptime_1d: 99.5,
    },
    {
      id: 'closed-model', org: 'anthropic', provider: 'beta', open_weights: false,
      open_weights_source: 'org_prior', license: null, pricing: { input: 1, output: 2 },
    },
    { id: 'unknown-model', org: 'google', provider: 'gamma', open_weights: null, pricing: { input: 1, output: 2 } },
  ] };
  const context = makeContext('/api/v1/models', '?open_weights=true');
  context.env.ASSETS = { fetch: async () => Response.json(catalog) };

  const open = await getJson(context);
  assert.equal(open.body.total, 1);
  assert.equal(open.body.models[0].open_weights, true);
  context.request = new Request('https://tokenwatch.test/api/v1/models?open_weights=false');
  const closed = await getJson(context);
  assert.equal(closed.body.total, 1);
  assert.equal(closed.body.models[0].open_weights, false);

  context.request = new Request('https://tokenwatch.test/api/v1/models/open-model/providers');
  const providers = await getJson(context);
  assert.deepEqual({
    open_weights: providers.body.providers[0].open_weights,
    open_weights_source: providers.body.providers[0].open_weights_source,
    license: providers.body.providers[0].license,
    supported_parameters: providers.body.providers[0].supported_parameters,
    supports_tool_choice: providers.body.providers[0].supports_tool_choice,
    supports_implicit_caching: providers.body.providers[0].supports_implicit_caching,
    max_prompt_tokens: providers.body.providers[0].max_prompt_tokens,
    uptime_1d: providers.body.providers[0].uptime_1d,
  }, {
    open_weights: true,
    open_weights_source: 'override',
    license: 'mit',
    supported_parameters: ['tools'],
    supports_tool_choice: true,
    supports_implicit_caching: false,
    max_prompt_tokens: 12000,
    uptime_1d: 99.5,
  });

  context.request = new Request('https://tokenwatch.test/api/v1/models/unknown-model/providers');
  const unknown = await getJson(context);
  const unknownProvider = unknown.body.providers[0];
  for (const field of [
    'open_weights', 'open_weights_source', 'license', 'supported_parameters',
    'supports_tool_choice', 'supports_implicit_caching', 'max_prompt_tokens', 'uptime_1d',
  ]) {
    assert.equal(unknownProvider[field], null, `${field} should be explicit null when unavailable`);
  }
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
