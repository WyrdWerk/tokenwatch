import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blendedRate, freshInputRate } from '../shared/cost.mjs';
import { buildBenchmarkOffering } from '../scripts/fetch-benchmarks.mjs';

test('higher finite cache-write tariff prices fresh input while reads use cache_read', () => {
  const pricing = { input: 2, cache_write: 5, cache_read: 0.2, output: 7 };
  assert.equal(freshInputRate(pricing), 5);
  assert.equal(blendedRate(pricing, { inputPct: 20, cacheReadPct: 50, outputPct: 30 }), 3.2);
  assert.equal(blendedRate({ ...pricing, cache_read: null }, { inputPct: 20, cacheReadPct: 50, outputPct: 30 }), 4.1);
  assert.equal(pricing.input, 2, 'raw catalog input remains unchanged');
});

test('cache-write only prices fresh input for a strictly higher finite numeric tariff', () => {
  for (const cache_write of [0, null, '', 1, 2, Infinity, NaN, '5']) {
    const pricing = { input: 2, cache_write, cache_read: 0.2, output: 7 };
    assert.equal(freshInputRate(pricing), 2, `cache_write=${String(cache_write)}`);
    assert.equal(blendedRate(pricing, { inputPct: 20, cacheReadPct: 50, outputPct: 30 }), 2.6);
  }
  assert.equal(freshInputRate({ input: 0, cache_write: 1 }), 1);
  assert.equal(freshInputRate({ input: 1, cache_write: 0 }), 1);
  assert.equal(freshInputRate({ input: null, cache_write: 5 }), null);
  assert.equal(blendedRate({ input: null, cache_write: 5, output: 7 }, { inputPct: 20, cacheReadPct: 50, outputPct: 30 }), null);
});

test('effective fresh-input rate can reverse the blended-cost winner', () => {
  const mix = { inputPct: 20, cacheReadPct: 50, outputPct: 30 };
  const first = { input: 1, cache_write: 10, cache_read: 0.1, output: 1 };
  const second = { input: 2, cache_read: 0.2, output: 1 };
  assert.ok(1 * 0.2 + 0.1 * 0.5 + 1 * 0.3 < 2 * 0.2 + 0.2 * 0.5 + 1 * 0.3);
  assert.ok(blendedRate(second, mix) < blendedRate(first, mix));
});

test('explicit cache-write billing uses the published write rate even when lower or zero', () => {
  const pricing = { input: 0.3, cache_write: 0.09, cache_read: 0, output: 1.2, input_billing: 'cache_write' };
  const mix = { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 };
  assert.equal(freshInputRate(pricing), 0.09);
  assert.equal(blendedRate(pricing, mix), 0.00825); // 0.09 × 0.025 + 1.2 × 0.005
  assert.equal(freshInputRate({ ...pricing, input_billing: undefined }), 0.3);
  assert.equal(freshInputRate({ ...pricing, cache_write: 0 }), 0);
  assert.equal(freshInputRate({ ...pricing, cache_write: 0.6 }), 0.6);
  for (const cache_write of [null, undefined, -0.1, '0.09', Infinity, NaN]) {
    assert.equal(freshInputRate({ ...pricing, cache_write }), null);
    assert.equal(blendedRate({ ...pricing, cache_write }, mix), null);
    assert.equal(blendedRate({ ...pricing, cache_write }, { inputPct: 0, cacheReadPct: 90, outputPct: 10 }), 0.12);
  }
  assert.equal(pricing.input, 0.3, 'raw input price is not replaced by the default billable rate');
});

test('calculator total, blended rate and affordability honor explicit lower write billing', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const extract = name => {
    const start = src.indexOf(`function ${name}(`);
    return src.slice(start, src.indexOf('\n}', start) + 2);
  };
  const helpers = new Function(`${['freshInputRate', 'costBreakdown', 'costFor', 'blendedCostFor', 'affordabilityFor'].map(extract).join('\n')}
    return {costBreakdown, costFor, blendedCostFor, affordabilityFor};`)();
  const pricing = { input: 0.3, cache_write: 0.09, cache_read: 0, output: 1.2, input_billing: 'cache_write' };
  const tokens = { input: 25000000, cacheRead: 970000000, output: 5000000, inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 };
  assert.deepEqual(helpers.costBreakdown(pricing, tokens), { input: 2.25, output: 6, cacheRead: 0, total: 8.25, excluded: false });
  assert.equal(helpers.costFor(pricing, tokens), 8.25);
  assert.equal(helpers.blendedCostFor(pricing, tokens), 0.00825);
  assert.equal(helpers.affordabilityFor(pricing, tokens, 8.25), 1000);
  assert.equal(helpers.costFor({ ...pricing, cache_write: null }, tokens), null);
});

test('embed widget uses the same fresh-input estimate, not a second amortized write charge', async () => {
  const src = await readFile(new URL('../public/widget/embed.js', import.meta.url), 'utf8');
  const start = src.indexOf('  function computeCost(');
  const end = src.indexOf('\n  }', start);
  const computeCost = new Function(`${src.slice(start, end + 4)}; return computeCost;`)();
  const pricing = { input: 2, cache_write: 5, cache_read: 0.2, output: 7 };
  assert.equal(computeCost(pricing, 2, '20,50,30', 100, 10), 6.4);
  assert.equal(computeCost({ ...pricing, cache_read: null }, 2, '20,50,30'), 8.2);
  for (const cache_write of [0, 1, 2, null, '', '5', Infinity, NaN]) {
    assert.equal(computeCost({ ...pricing, cache_write }, 2, '20,50,30'), 5.2);
  }
  assert.equal(computeCost({ input: null, cache_write: 5, output: 7 }, 2, '20,50,30'), null);
  const coral = { input: 0.3, cache_write: 0.09, cache_read: 0, output: 1.2, input_billing: 'cache_write' };
  assert.equal(computeCost(coral, 1000, '2.5,97,0.5'), 8.25);
  assert.equal(computeCost({ ...coral, cache_write: null }, 1000, '2.5,97,0.5'), null);
  assert.equal(computeCost({ ...coral, cache_write: 0 }, 1000, '2.5,97,0.5'), 6);
});

test('benchmark client computes the same write-adjusted mix without changing cached-read fallback', async () => {
  const src = await readFile(new URL('../public/benchmarks-app.js', import.meta.url), 'utf8');
  const extract = name => {
    const start = src.indexOf(`  function ${name}(`);
    return src.slice(start, src.indexOf('\n  }', start) + 4);
  };
  const rate = new Function(`${extract('freshInputRate')}\n${extract('blendedRate')}\nreturn blendedRate;`)();
  const mix = { inputPct: 20, cacheReadPct: 50, outputPct: 30 };
  const pricing = { input: 2, cache_write: 5, cache_read: 0.2, output: 7 };
  assert.equal(rate(pricing, mix), 3.2);
  assert.equal(rate({ ...pricing, cache_read: null }, mix), 4.1);
  assert.equal(rate({ ...pricing, cache_write: 1 }, mix), 2.6);
  const coral = { input: 0.3, cache_write: 0.09, cache_read: 0, output: 1.2, input_billing: 'cache_write' };
  assert.equal(rate(coral, { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 }), 0.00825);
  assert.equal(rate({ ...coral, cache_write: null }, mix), null);
});

test('benchmark feed preserves the billing rule when projecting raw offering prices', async () => {
  const pricing = { input: 0.3, cache_write: 0.09, cache_read: 0, output: 1.2, input_billing: 'cache_write' };
  const offering = buildBenchmarkOffering({
    id: 'org/coralbricks-model',
    provider: 'coralbricks',
    provider_display: 'CoralBricks',
    pricing,
  }, {});
  assert.equal(offering.input_billing, 'cache_write');
  assert.equal(blendedRate(offering, { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 }), 0.00825);
});
