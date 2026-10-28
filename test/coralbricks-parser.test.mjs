import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCoralbricks, normalizeProvider, dedupModels } from '../scripts/lib.mjs';
import * as providerLib from '../scripts/lib.mjs';

// Snapshot of https://www.coralbricks.ai/api/public/models, which backs coralbricks.ai/models.
const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/coralbricks-models.json', import.meta.url), 'utf8')
);

test('parseCoralbricks uses its own public USD/M prices, not the OpenRouter comparison', () => {
  const rows = parseCoralbricks(FIXTURE);
  assert.deepEqual(rows.map(m => m.id), ['deepseek-v4.1-flash-fast', 'deepseek-v4.1-flash']);
  assert.ok(rows.every((m) => m.provider === 'coralbricks'));
  const fast = rows.find((m) => m.id === 'deepseek-v4.1-flash-fast');
  assert.equal(fast.name, 'DeepSeek V4.1 Flash Fast');
  assert.equal(fast.org, 'deepseek');
  assert.equal(fast.quantization, null);
  assert.equal(fast.context_length, 1000000);
  assert.equal(fast.max_completion_tokens, null);
  assert.equal(fast.discount, 0);
  assert.deepEqual(fast.pricing, {
    input: 0.45, output: 1.8, cache_read: 0.009, cache_write: 0.45, cache_write_addon: 0, input_billing: 'cache_write',
  });

  const standard = rows.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.equal(standard.name, 'DeepSeek V4.1 Flash Standard');
  assert.deepEqual(standard.pricing, {
    input: 0.19, output: 0.6, cache_read: 0.008, cache_write: 0.19, cache_write_addon: 0, input_billing: 'cache_write',
  });
});

test('CoralBricks cache write is charged on top of input and never derived or invented', () => {
  const model = FIXTURE.models[0];
  const parsePricing = patch => parseCoralbricks({ models: [{ ...model, ...patch }] })[0].pricing;
  // coralbricks.ai/pricing: "Cache writes pay input plus the listed surcharge".
  assert.deepEqual(
    [parsePricing({ inputPerM: 1.12, cacheWritePerM: 0.56 })].map(p => [p.cache_write, p.cache_write_addon]),
    [[1.68, 0.56]],
  );
  assert.equal(parsePricing({ cacheWritePerM: undefined }).cache_write, null);
  assert.equal(parsePricing({ cacheWritePerM: undefined }).cache_write_addon, null);
  assert.equal(parsePricing({ cacheWritePerM: -1 }).cache_write, null);
  assert.equal(parsePricing({ inputPerM: undefined }).cache_write, null);
});

test('parseCoralbricks leaves unpublished limits, precision and cache prices unknown', () => {
  const rows = parseCoralbricks({ models: [{
    slug: 'qwen-new-fp4', inputPerM: 0.21, outputPerM: 0.67, products: { tokenApi: true },
  }] });
  assert.equal(rows[0].name, 'qwen-new-fp4');
  assert.equal(rows[0].org, 'qwen');
  assert.equal(rows[0].quantization, null);
  assert.equal(rows[0].context_length, null);
  assert.equal(rows[0].max_completion_tokens, null);
  assert.equal(rows[0].pricing.cache_read, null);
  assert.equal(rows[0].pricing.cache_write, null);
  assert.equal(rows[0].pricing.cache_write_addon, null);
  const model = FIXTURE.models[0];
  assert.equal(parseCoralbricks({ models: [{ ...model, cacheReadPerM: -1 }] })[0].pricing.cache_read, null);
  assert.equal(parseCoralbricks({ models: [{ ...model, precision: 'Native MXFP4' }] })[0].quantization, 'mxfp4');
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
  // The keyed /v1/models shape is no longer a pricing source.
  assert.deepEqual(parseCoralbricks({ data: [{ id: 'x', supports_chat: true, pricing: { input_per_m: 1, output_per_m: 1 } }] }), []);
});

test('CoralBricks provider aliases deduplicate without stripping native SKU IDs', () => {
  assert.equal(normalizeProvider('Coral Bricks'), 'coralbricks');
  const direct = parseCoralbricks(FIXTURE);
  const router = { ...direct[0], provider: 'Coral Bricks', pricing: { input: 9, output: 9 } };
  const rows = dedupModels([...direct, router]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(m => m.id === 'deepseek-v4.1-flash-fast').pricing.input, 0.45);
  assert.ok(rows.some(m => m.id === 'deepseek-v4.1-flash'));
});

test('deprecated CoralBricks slugs never become rows or swallow a current SKU', () => {
  const rows = parseCoralbricks(FIXTURE);
  const retired = FIXTURE.models.flatMap(m => m.deprecatedSlugs);
  assert.ok(rows.every(m => !retired.includes(m.id)));
  // Flash Standard's current slug was once a Fast alias; it must stay its own SKU.
  const legacy = { ...FIXTURE.models[0], deprecatedSlugs: ['deepseek-v4.1-flash-fast-fp4', 'deepseek-v4.1-flash'] };
  assert.deepEqual(parseCoralbricks({ models: [legacy, FIXTURE.models[1]] }).map(m => m.id),
    ['deepseek-v4.1-flash-fast', 'deepseek-v4.1-flash']);
  assert.equal(parseCoralbricks({ models: [FIXTURE.models[0], { ...FIXTURE.models[0] }] }).length, 1);
});

test('fetch-pricing reads the public CoralBricks catalog without a key and keeps conservative policy metadata', async () => {
  assert.equal(providerLib.fetchCoralbricksCatalog, undefined);
  const src = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  const registry = src.match(/\{\s*key: 'coralbricks',[\s\S]*?\n  \}/)?.[0];
  assert.ok(registry);
  assert.match(registry, /name: 'CoralBricks'/);
  assert.match(registry, /url: 'https:\/\/www\.coralbricks\.ai\/api\/public\/models'/);
  assert.match(registry, /parse: parseCoralbricks/);
  assert.doesNotMatch(registry, /apiKeyEnv|CORAL_API_KEY|fetch:/);

  const metadata = src.match(/  coralbricks: \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(metadata);
  assert.match(metadata, /retains_prompts: true/);
  assert.match(metadata, /may_train: false/);
  assert.match(metadata, /retention_days: 30/);
  assert.match(metadata, /status_page_url: 'https:\/\/www.coralbricks.ai\/status'/);
});
