import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePrimalabs, selectOpenRouterEndpoints, dropIndirectPrimalabsRows, dedupModels } from '../scripts/lib.mjs';

// Model-only snapshot of the authenticated catalog, 2026-11-05.
const fixture = JSON.parse(await readFile(new URL('./fixtures/primalabs-models.json', import.meta.url), 'utf8'));

test('Prima Labs live schema converts per-token prices and preserves direct limits', () => {
  const rows = parsePrimalabs(fixture);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((m) => m.provider === 'primalabs'));
  const kimi = rows.find((m) => m.id.endsWith('/Kimi-K3.1-Pro'));
  assert.ok(Math.abs(kimi.pricing.input - 1.8) < 1e-12);
  assert.equal(kimi.pricing.output, 9);
  assert.equal(kimi.pricing.cache_read, 0.18);
  assert.equal(kimi.pricing.cache_write, null);
  assert.equal(kimi.context_length, 1048576);
  assert.equal(kimi.max_completion_tokens, 1048576);
  assert.equal(kimi.org, 'moonshot');
  assert.equal(kimi.supports_tool_choice, true);
  assert.equal(kimi.supports_implicit_caching, true);
  assert.equal(rows.find((m) => m.id.includes('Nemotron')).org, 'nvidia');
  assert.equal(rows.find((m) => m.id.includes('Nemotron')).quantization, 'nvfp4');
  assert.equal(rows.find((m) => m.id.includes('GLM')).org, 'z-ai');
  const mimo = rows.find((m) => m.id.includes('MiMo'));
  assert.equal(mimo.org, 'xiaomi');
  assert.equal(mimo.max_completion_tokens, null);
  assert.equal(mimo.supports_tool_choice, null);
  assert.equal(mimo.supports_implicit_caching, null);
});

test('Prima Labs rejects malformed catalogs and skips malformed, free, and non-text offerings', () => {
  for (const value of [null, {}, { data: {} }]) assert.throws(() => parsePrimalabs(value), /data array/);
  assert.deepEqual(parsePrimalabs({ data: [] }), []);
  const model = { id: 'primalabs-ai/GLM-test', pricing: { prompt: '0.000001', completion: '0.000002' } };
  for (const bad of [null, {}, { ...model, output_modalities: ['image'] }, { ...model, pricing: { prompt: '-1', completion: '2' } }, { ...model, pricing: { prompt: 'oops', completion: '2' } }, { ...model, pricing: { prompt: 0, completion: 0 } }, { ...model, pricing: { prompt: '', completion: 1 } }, { ...model, pricing: { prompt: true, completion: 1 } }]) {
    assert.deepEqual(parsePrimalabs({ data: [bad] }), []);
  }
  const [row] = parsePrimalabs({ data: [{ ...model, pricing: { ...model.pricing, input_cache_read: '0', input_cache_write: '0.000003' } }] });
  assert.deepEqual(row.pricing, { input: 1, output: 2, cache_read: 0, cache_write: 3 });
});

test('Prima Labs OpenRouter rows, including service tiers, are excluded on every refresh', () => {
  const ep = (provider_name, tag = 'standard') => ({ provider_name, tag, pricing: { prompt: '0.000001', completion: '0.000002' } });
  for (const model of ['moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3.1-pro:batch']) {
    const selected = selectOpenRouterEndpoints([
      ep('PrimaLabs'), ep('Prima Labs'), ep('PrimaLabs AI'), ep('PrimaLabs', 'primalabs/fast'), ep('Together'),
    ], model);
    assert.deepEqual(selected.map((r) => r.endpoint.provider_name), ['Together']);
  }
});

test('direct-only source guard prevents fallback duplicates even after API failure and repeated refreshes', () => {
  const direct = parsePrimalabs(fixture);
  const indirect = [
    { ...direct[0], provider: 'Prima Labs', id: 'z-ai/glm-5.3-flash' },
    { ...direct[1], provider: 'primalabs' },
  ];
  const other = { ...direct[0], provider: 'together' };
  const sourceOf = (m) => direct.includes(m) ? 'direct' : 'openrouter';
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(dedupModels(dropIndirectPrimalabsRows([...direct, ...indirect, other], sourceOf)), [...direct, other]);
  }
  assert.deepEqual(dropIndirectPrimalabsRows([...indirect, other], sourceOf), [other]);
});

test('fetcher and both refresh workflows wire the Prima Labs secret and direct-only guard', async () => {
  const source = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  const entry = source.match(/\{\s*key: 'primalabs',[\s\S]*?\n  \}/)?.[0];
  assert.ok(entry, 'Prima Labs registry entry exists');
  assert.match(entry, /url: 'https:\/\/api\.primalabs\.ai\/v1\/models'/);
  assert.match(entry, /apiKeyEnv: 'PRIMALABS_API_KEY'/);
  assert.match(entry, /parse: parsePrimalabs/);
  assert.match(source, /tieredModels = dropIndirectPrimalabsRows\(tieredModels, \(m\) => pricingSource.get\(m\)\)/);
  for (const file of ['refresh-pricing.yml', 'refresh-aa.yml']) {
    assert.match(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'), /PRIMALABS_API_KEY: \$\{\{ secrets\.PRIMALABS_API_KEY \}\}/);
  }
});
