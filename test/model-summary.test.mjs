import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  canonicalSummary,
  rankOfferings,
  priceDistribution,
  MIN_PROVIDER_ROWS,
} from '../shared/model-summary.mjs';
import { blendedRate } from '../shared/cost.mjs';

const MIX = { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 };

const offerings = [
  // cheapest at the cache-heavy mix (cache_read 0.018)
  { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', org: 'deepseek', provider: 'deepinfra', quantization: null, pricing: { input: 0.09, output: 0.18, cache_read: 0.018, cache_write: null } },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', org: 'deepseek', provider: 'hyper', quantization: null, pricing: { input: 0.2, output: 0.4, cache_read: 0.04, cache_write: null } },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', org: 'deepseek', provider: 'zro', quantization: null, discount: 0.5, pricing: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: null } },
  // a quantized sibling offering — must remain a separate row, never merged
  { id: 'deepseek-v4-flash-fp8', name: 'DeepSeek V4 Flash FP8', org: 'deepseek', provider: 'sference', quantization: 'fp8', pricing: { input: 0.28, output: 0.56, cache_read: 0.07, cache_write: null } },
];

const perfByKey = {
  'deepseek-v4-flash|deepinfra': { latency: { p50: 400 }, throughput: { p50: 60 } },
  'deepseek-v4-flash|hyper': { latency: { p50: 700 }, throughput: { p50: 40 } },
  'deepseek-v4-flash|zro': { latency: { p50: 250 }, throughput: { p50: 80 } },
};

test('canonicalSummary groups offerings for exactly one canonical id', () => {
  const summary = canonicalSummary(offerings, { canonical: 'deepseek-v4-flash', mix: MIX, perfByKey });
  assert.ok(summary, 'summary produced');
  assert.equal(summary.canonical, 'deepseek-v4-flash');
  assert.equal(summary.providerCount, 3);
  assert.equal(summary.rows.length, 3, 'quantized sibling canonical is excluded from this group');
});

test('canonicalSummary returns null unless the selection resolves to exactly one canonical id', () => {
  assert.equal(canonicalSummary([], { canonical: 'deepseek-v4-flash', mix: MIX }), null);
  assert.equal(canonicalSummary(offerings, { canonical: '', mix: MIX }), null);
  assert.equal(canonicalSummary(offerings, { canonical: 'not-a-model', mix: MIX }), null);
});

test('canonicalSummary resolves space-separated queries the same way the results filter does', () => {
  // The results filter normalizes spaces and hyphens to the same separator, so
  // "deepseek v4 flash" must produce the same summary as "deepseek-v4-flash"
  // instead of filtering the table but silently showing no summary.
  const hyphen = canonicalSummary(offerings, { canonical: 'deepseek-v4-flash', mix: MIX, perfByKey });
  const spaced = canonicalSummary(offerings, { canonical: 'DeepSeek V4 Flash', mix: MIX, perfByKey });
  assert.ok(spaced, 'space-separated query must resolve');
  assert.equal(spaced.canonical, 'deepseek-v4-flash');
  assert.deepEqual(spaced, hyphen, 'spaced and hyphenated queries yield the same summary');

  // Mixed separators and case fold to the same result too.
  const mixed = canonicalSummary(offerings, { canonical: '  DEEPSEEK  v4-Flash ', mix: MIX, perfByKey });
  assert.ok(mixed, 'mixed case/separator query must resolve');
  assert.equal(mixed.canonical, 'deepseek-v4-flash');
});

test('canonicalSummary does not guess when a spaced query is ambiguous', () => {
  // Two distinct canonical ids normalize to the same spaced query → no summary
  // rather than silently picking one. Neither id is the query itself.
  const ambiguous = [
    { id: 'acme-model-x', provider: 'p1', pricing: { input: 1, output: 1, cache_read: null } },
    { id: 'acme-model--x', provider: 'p2', pricing: { input: 2, output: 2, cache_read: null } },
  ];
  assert.equal(canonicalSummary(ambiguous, { canonical: 'acme model x', mix: MIX }), null);
  // …but naming one exact id still resolves it.
  assert.equal(canonicalSummary(ambiguous, { canonical: 'acme-model-x', mix: MIX }).canonical, 'acme-model-x');
});

test('canonicalSummary keeps :batch and quant variants exact when queried by id', () => {
  const withBatch = [
    ...offerings,
    { id: 'deepseek-v4-flash:batch', name: 'DeepSeek V4 Flash batch', org: 'deepseek', provider: 'openai', pricing: { input: 0.05, output: 0.1, cache_read: null } },
  ];
  const batch = canonicalSummary(withBatch, { canonical: 'deepseek-v4-flash:batch', mix: MIX });
  assert.ok(batch, ':batch query resolves to the batch canonical');
  assert.equal(batch.canonical, 'deepseek-v4-flash:batch');
  assert.equal(batch.rows.length, 1);
});

test('rankOfferings ranks by the visitor mix using shared blended-cost semantics', () => {
  const ranked = rankOfferings(offerings.filter((o) => o.provider !== 'sference'), MIX, perfByKey);
  assert.equal(ranked.length, 3);
  // zro (cache 0.003) < deepinfra (0.018) < hyper (0.04) at a 97%-cached mix
  assert.deepEqual(ranked.map((r) => r.model.provider), ['zro', 'deepinfra', 'hyper']);
  for (const row of ranked) {
    assert.equal(row.eff, blendedRate(row.model.pricing, MIX));
  }
});

test('rankOfferings reorders when the mix changes (workload-specific, not fixed)', () => {
  const inputHeavy = { inputPct: 97, cacheReadPct: 2.5, outputPct: 0.5 };
  const ranked = rankOfferings(offerings.filter((o) => o.provider !== 'sference'), inputHeavy, perfByKey);
  // deepinfra input 0.09 is cheapest when input dominates
  assert.equal(ranked[0].model.provider, 'deepinfra');
});

test('rankOfferings keeps quantized SKUs as separate rows and labels them', () => {
  const ranked = rankOfferings(offerings, MIX, perfByKey);
  const quant = ranked.find((r) => r.model.quantization === 'fp8');
  assert.ok(quant, 'fp8 offering present as its own row');
  assert.equal(ranked.filter((r) => r.model.provider === 'sference').length, 1);
});

test('rankOfferings falls back to input price when cache_read is null', () => {
  const rows = rankOfferings([
    { id: 'x/model', provider: 'a', pricing: { input: 1, output: 2, cache_read: null, cache_write: null } },
    { id: 'x/model', provider: 'b', pricing: { input: 0.5, output: 2, cache_read: null, cache_write: null } },
  ], MIX, {});
  assert.equal(rows[0].model.provider, 'b');
  // cache_read null → the cached leg is charged at the input rate, so the
  // blend is input*(2.5% + 97%) + output*0.5%.
  const expected = 0.5 * (2.5 + 97) / 100 + 2 * 0.5 / 100;
  assert.ok(Math.abs(rows[0].eff - expected) < 1e-12, `expected ${expected}, got ${rows[0].eff}`);
});

test('rankOfferings excludes offerings that cannot serve the mix', () => {
  const rows = rankOfferings([
    { id: 'x/model', provider: 'a', pricing: { input: 1, output: null, cache_read: null, cache_write: null } },
    { id: 'x/model', provider: 'b', pricing: { input: 1, output: 2, cache_read: null, cache_write: null } },
  ], MIX, {});
  assert.deepEqual(rows.map((r) => r.model.provider), ['b']);
});

test('priceDistribution summarizes provider-offering ranges, not an intrinsic model price', () => {
  const dist = priceDistribution(offerings.filter((o) => o.provider !== 'sference'));
  assert.deepEqual(dist.input, { min: 0.09, max: 0.2, count: 3 });
  assert.deepEqual(dist.output, { min: 0.18, max: 0.6, count: 3 });
  assert.equal(dist.cacheRead.count, 3);
  assert.equal(dist.cacheRead.min, 0.003);
  assert.equal(dist.cacheRead.max, 0.04);
  assert.equal(dist.total, 3);
});

test('priceDistribution reports null ranges when nothing is priced', () => {
  const dist = priceDistribution([{ id: 'x', provider: 'a', pricing: {} }]);
  assert.equal(dist.input, null);
  assert.equal(dist.output, null);
  assert.equal(dist.cacheRead, null);
  assert.equal(dist.total, 1);
});

test('canonicalSummary includes cheapest provider, price ranges, and provider-price distribution', () => {
  const summary = canonicalSummary(offerings, { canonical: 'deepseek-v4-flash', mix: MIX, perfByKey });
  assert.equal(summary.cheapest.provider, 'zro');
  assert.ok(Math.abs(summary.cheapestEff - blendedRate(offerings[2].pricing, MIX)) < 1e-12);
  assert.deepEqual(summary.distribution.input, { min: 0.09, max: 0.2, count: 3 });
  assert.equal(summary.distribution.total, 3);
  assert.equal(summary.rows.length, 3, 'full sortable offering table');
});

test('canonicalSummary preserves batch and variant SKU distinctions', () => {
  const withBatch = [
    ...offerings,
    { id: 'deepseek-v4-flash:batch', name: 'DeepSeek V4 Flash (batch)', org: 'deepseek', provider: 'openai', pricing: { input: 0.05, output: 0.1, cache_read: null, cache_write: null } },
  ];
  const summary = canonicalSummary(withBatch, { canonical: 'deepseek-v4-flash', mix: MIX, perfByKey });
  assert.equal(summary.rows.length, 3, ':batch is a distinct canonical id, not merged');
  const batchSummary = canonicalSummary(withBatch, { canonical: 'deepseek-v4-flash:batch', mix: MIX, perfByKey });
  assert.ok(batchSummary, ':batch canonical resolves independently');
  assert.equal(batchSummary.rows[0].model.provider, 'openai');
});

test('MIN_PROVIDER_ROWS exposes the single-provider floor used for summary mode', () => {
  assert.ok(MIN_PROVIDER_ROWS >= 1);
});

// ── source-aware label accuracy ───────────────────────────────────────────────

test('canonicalSummary labels metrics with their real source/window (no generic cache-hit or 1-day uptime)', async () => {
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(src, /UP 1D|one-day uptime|1-day uptime/i, 'no one-day uptime claim');
  assert.doesNotMatch(src, /Hit rate used/i, 'no generic cache-hit-rate claim');
  assert.match(src, /Uptime \(30m\)/, 'uptime must be labelled with its 30-minute window');
  assert.match(src, /Latency|TTFT/i, 'latency/TTFT labelling present');
});

test('canonicalSummary does not invent performance data when none exists', () => {
  const summary = canonicalSummary(offerings, { canonical: 'deepseek-v4-flash', mix: MIX, perfByKey: {} });
  for (const row of summary.rows) {
    assert.equal(row.perf, null, 'missing performance must stay null, never fabricated');
  }
  assert.equal(summary.perfCoverage, 0);
});

test('canonicalSummary attaches performance from the canonical|provider key only', () => {
  const summary = canonicalSummary(offerings, { canonical: 'deepseek-v4-flash', mix: MIX, perfByKey });
  const zro = summary.rows.find((r) => r.model.provider === 'zro');
  assert.equal(zro.perf.throughput.p50, 80);
  assert.equal(summary.perfCoverage, 3);
});

test('canonicalSummary joins performance on canonical id + provider, never leaking across quants', () => {
  const perf = { 'deepseek-v4-flash-fp8|sference': { throughput: { p50: 10 } } };
  const summary = canonicalSummary(offerings, { canonical: 'deepseek-v4-flash', mix: MIX, perfByKey: perf });
  for (const row of summary.rows) assert.equal(row.perf, null);
});

// ── app.js mirror parity ──────────────────────────────────────────────────────

test('app.js mirrors shared/model-summary.mjs summary math (drift guard)', async () => {
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');

  // The mirror must exist and be used by the renderer + computeAndRender.
  assert.match(src, /function rankCanonicalOfferings\(/, 'app.js must define rankCanonicalOfferings');
  assert.match(src, /function canonicalSummary\(/, 'app.js must define canonicalSummary');
  assert.match(src, /renderModelSummary\(matchingOfferings\(\), tokens\)/, 'computeAndRender must render the canonical summary');
  assert.match(src, /const MIN_PROVIDER_ROWS = 1;/, 'app.js must carry MIN_PROVIDER_ROWS');

  // Extract and execute the app.js mirror, then compare its output to the
  // shared module on the same inputs. This is the same drift-guard pattern as
  // the canonicalModelId parity test.
  const start = src.indexOf('function rankCanonicalOfferings(');
  const end = src.indexOf('\nfunction renderModelSummary(', start);
  const block = src.slice(start, end);
  // Minimal stand-ins for app.js's dependencies.
  const helpers = `
    const canonicalModelId = (id) => {
      let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
      return k.replace(/:free$/, '').replace(/:thinking$/, '')
        .replace(/-(\\d{4})-(\\d{2})-(\\d{2})$/, '').replace(/-preview-(\\d{2})-(\\d{4})$/, '')
        .replace(/-preview-(\\d{4})-(\\d{2})-(\\d{2})$/, '').replace(/-preview-(\\d{2})-(\\d{2})$/, '')
        .replace(/-preview$/, '').replace(/-(\\d{8})$/, '').replace(/-(\\d{6})$/, '')
        .toLowerCase().trim();
    };
    const blendedCostFor = (pricing, tokens) => {
      const inRate = pricing.input != null ? pricing.input * tokens.inputPct / 100 : null;
      const outRate = pricing.output != null ? pricing.output * tokens.outputPct / 100 : null;
      const crPrice = pricing.cache_read != null ? pricing.cache_read : pricing.input;
      const crRate = crPrice != null ? crPrice * tokens.cacheReadPct / 100 : null;
      if (tokens.inputPct > 0 && inRate === null) return null;
      if (tokens.outputPct > 0 && outRate === null) return null;
      return (inRate || 0) + (outRate || 0) + (crRate || 0);
    };
  `;
  // eslint-disable-next-line no-new-func
  const appSummary = new Function(`${helpers}${block}; return canonicalSummary;`)();

  for (const canonical of ['deepseek-v4-flash', 'deepseek-v4-flash-fp8', 'DeepSeek V4 Flash', 'deepseek v4-flash', 'missing-model']) {
    const appResult = appSummary(offerings, { canonical, mix: MIX, perfByKey });
    const sharedResult = canonicalSummary(offerings, { canonical, mix: MIX, perfByKey });
    assert.deepEqual(appResult, sharedResult, `app.js and shared summary must agree for ${canonical}`);
  }
});