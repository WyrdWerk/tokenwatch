import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blendedRate, freshInputRate } from '../shared/cost.mjs';

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
});
