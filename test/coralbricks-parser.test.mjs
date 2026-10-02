import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCoralbricks, normalizeProvider, dedupModels } from '../scripts/lib.mjs';
import * as providerLib from '../scripts/lib.mjs';

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/coralbricks-models.json', import.meta.url), 'utf8')
);
const AUTH_FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/coralbricks-auth-models.json', import.meta.url), 'utf8')
);

test('parseCoralbricks uses its own USD/M prices, not the OpenRouter comparison', () => {
  const rows = parseCoralbricks(FIXTURE);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((m) => m.provider === 'coralbricks'));
  const glm = rows.find((m) => m.id === 'glm-5.3-fp4');
  assert.equal(glm.name, 'GLM 5.3');
  assert.equal(glm.org, 'z-ai');
  assert.equal(glm.quantization, 'nvfp4');
  assert.equal(glm.context_length, 1000000);
  assert.equal(glm.max_completion_tokens, null);
  assert.deepEqual(glm.pricing, { input: 1.12, output: 4.4, cache_read: 0, cache_write: 1.68, input_billing: 'cache_write' });
  assert.equal(rows.find((m) => m.id === 'glm-5.3-flash-fp4').pricing.cache_write, 0.23);

  const flash = rows.find((m) => m.id === 'deepseek-v4.1-flash-fast-fp4');
  assert.equal(flash.org, 'deepseek');
  assert.equal(flash.quantization, 'mxfp4');
  assert.deepEqual(flash.pricing, { input: 0.3, output: 1.2, cache_read: 0, cache_write: 0.09, input_billing: 'cache_write' });
  assert.equal(flash.discount, 0);
});

test('parseCoralbricks prefers the live cache-write multiplier over published defaults', () => {
  const rows = parseCoralbricks({ models: [{
    ...FIXTURE.models[0], inputPerM: 0.41, cacheWriteMultiplier: 2.5, contextWindow: '128K',
  }] });
  assert.equal(rows[0].pricing.cache_write, 1.025);
  assert.equal(rows[0].context_length, 128000);
});

test('parseCoralbricks leaves unpublished limits and new-model cache writes unknown', () => {
  const rows = parseCoralbricks({ models: [{
    slug: 'qwen-new-fp4', inputPerM: 0.21, outputPerM: 0.67, products: { tokenApi: true },
  }] });
  assert.equal(rows[0].name, 'qwen-new-fp4');
  assert.equal(rows[0].org, 'qwen');
  assert.equal(rows[0].quantization, null);
  assert.equal(rows[0].context_length, null);
  assert.equal(rows[0].max_completion_tokens, null);
  assert.equal(rows[0].pricing.cache_read, 0);
  assert.equal(rows[0].pricing.cache_write, null);
});

test('parseCoralbricks excludes private-only, free, unpriced and malformed entries', () => {
  const model = FIXTURE.models[0];
  assert.deepEqual(parseCoralbricks({ models: [
    { ...model, products: { tokenApi: false, privateEndpoint: true } },
    { ...model, inputPerM: 0, outputPerM: 0 },
    { ...model, inputPerM: null, outputPerM: null },
    { ...model, inputPerM: -1 },
    { ...model, slug: null },
    null,
  ] }), []);
  assert.deepEqual(parseCoralbricks({}), []);
  assert.deepEqual(parseCoralbricks({ models: null }), []);
});

test('CoralBricks provider aliases deduplicate without stripping native quant/SKU IDs', () => {
  assert.equal(normalizeProvider('Coral Bricks'), 'coralbricks');
  const direct = parseCoralbricks(FIXTURE);
  const router = { ...direct[0], provider: 'Coral Bricks', pricing: { input: 9, output: 9 } };
  const rows = dedupModels([...direct, router]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].pricing.input, 1.12);
  assert.equal(rows[2].id, 'deepseek-v4.1-flash-fast-fp4');
});

test('authenticated CoralBricks prices, context and capability flags are authoritative', () => {
  const rows = parseCoralbricks(AUTH_FIXTURE);
  assert.equal(rows.length, 3);
  const flash = rows.find(m => m.id === 'glm-5.3-flash-fp4');
  assert.equal(flash.context_length, 1048576);
  assert.deepEqual(flash.pricing, {input: 0.15, output: 0.5, cache_read: 0, cache_write: 0.23, input_billing: 'cache_write'});
  assert.deepEqual(flash.capabilities, {chat: true, image_input: true, tool_call: true});
  assert.equal(rows.find(m => m.id === 'glm-5.3-fp4').capabilities.image_input, false);
  assert.equal(rows.find(m => m.id === 'deepseek-v4.1-flash-fast-fp4').pricing.cache_write, 0.09);
  assert.ok(rows.every(m => m.max_completion_tokens === null));
});

test('authenticated tariffs do not derive explicit write prices or invent missing cache rates', () => {
  const model = AUTH_FIXTURE.data[1];
  const parsePricing = pricing => parseCoralbricks({data: [{...model, pricing} ]})[0].pricing;
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: 0.217, cache_write_multiple: 8}).cache_write, 0.217);
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: 0}).cache_write, 0);
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: undefined}).cache_write, null);
  assert.equal(parsePricing({...model.pricing, cached_input_per_m: undefined}).cache_read, null);
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: -1}).cache_write, null);
  assert.deepEqual(parseCoralbricks({data: [{...model, supports_chat: false}, {...model, pricing: {input_per_m: -1, output_per_m: 1}}, null]}), []);
});

test('CoralBricks fetch uses auth tariffs and public metadata without forwarding the key', async () => {
  const calls = [];
  const data = await providerLib.fetchCoralbricksCatalog('test-key', async (url, opts) => {
    calls.push({url, opts});
    return url.includes('inference.') ? AUTH_FIXTURE : FIXTURE;
  });
  assert.equal(calls[0].url, 'https://inference.coralbricks.ai/v1/models');
  assert.equal(calls[0].opts.apiKey, 'test-key');
  assert.equal(calls[1].url, 'https://www.coralbricks.ai/api/public/models');
  assert.equal(calls[1].opts?.apiKey, undefined);
  const rows = parseCoralbricks(data);
  const glm = rows.find(m => m.id === 'glm-5.3-fp4');
  assert.equal(glm.name, 'GLM 5.3');
  assert.equal(glm.quantization, 'nvfp4');
  assert.equal(glm.context_length, 1048576);
  assert.equal(rows.find(m => m.id === 'glm-5.3-flash-fp4').pricing.cache_write, 0.23);
});

test('CoralBricks fetch falls back publicly for missing keys, auth outages or empty catalogs', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const mode of ['missing-key', 'auth-failure', 'empty-auth']) {
    const calls = [];
    const data = await providerLib.fetchCoralbricksCatalog(mode === 'missing-key' ? undefined : 'test-key', async (url, opts) => {
      calls.push({url, opts});
      if (url.includes('inference.')) {
        if (mode === 'auth-failure') throw new Error('HTTP 401');
        return {data: []};
      }
      return FIXTURE;
    });
    assert.deepEqual(data, FIXTURE);
    assert.equal(calls.length, mode === 'missing-key' ? 1 : 2);
    assert.equal(calls.at(-1).opts?.apiKey, undefined);
  }
});

test('CoralBricks public metadata outage does not discard authenticated prices', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const data = await providerLib.fetchCoralbricksCatalog('test-key', async url => {
    if (url.includes('inference.')) return AUTH_FIXTURE;
    throw new Error('HTTP 503');
  });
  assert.equal(parseCoralbricks(data).length, 3);
  assert.equal(parseCoralbricks(data)[1].pricing.cache_write, 0.23);
});

test('fetch-pricing wires CoralBricks auth with a public fallback and conservative policy metadata', async () => {
  const src = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  const registry = src.match(/\{\s*key: 'coralbricks',[\s\S]*?\n  \}/)?.[0];
  assert.ok(registry);
  assert.match(registry, /name: 'CoralBricks'/);
  assert.match(registry, /fetch:.*fetchCoralbricksCatalog\(process.env.CORAL_API_KEY\)/);
  assert.match(registry, /parse: parseCoralbricks/);
  assert.doesNotMatch(registry, /apiKeyEnv/);

  const metadata = src.match(/  coralbricks: \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(metadata);
  assert.match(metadata, /retains_prompts: true/);
  assert.match(metadata, /may_train: false/);
  assert.match(metadata, /retention_days: 30/);
  assert.match(metadata, /status_page_url: 'https:\/\/www.coralbricks.ai\/status'/);
});
