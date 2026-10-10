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
  assert.deepEqual(rows.map(m => m.id), ['glm-5.3-fast', 'deepseek-v4.1-flash-fast']);
  assert.ok(rows.every((m) => m.provider === 'coralbricks'));
  const glm = rows.find((m) => m.id === 'glm-5.3-fast');
  assert.equal(glm.name, 'GLM 5.3');
  assert.equal(glm.org, 'z-ai');
  assert.equal(glm.quantization, 'nvfp4');
  assert.equal(glm.context_length, 1000000);
  assert.equal(glm.max_completion_tokens, null);
  assert.deepEqual(glm.pricing, {
    input: 1.12, output: 4.4, cache_read: 0, cache_write: 1.68, cache_write_addon: 0.56, input_billing: 'cache_write',
  });

  const flash = rows.find((m) => m.id === 'deepseek-v4.1-flash-fast');
  assert.equal(flash.org, 'deepseek');
  assert.equal(flash.quantization, 'mxfp4');
  assert.deepEqual(flash.pricing, {
    input: 0.01, output: 1.2, cache_read: 0, cache_write: 0.09, cache_write_addon: 0.08, input_billing: 'cache_write',
  });
  assert.equal(flash.discount, 0);
});

test('CoralBricks cache write is charged on top of input, matching its published one-shot price', () => {
  // coralbricks.ai/pricing: GLM 5.3 one-shot (0% cached, 6.7% output as a share of input) = $1.851/M.
  const {pricing} = parseCoralbricks(FIXTURE).find(m => m.id === 'glm-5.3-fast');
  const inputShare = 1 / 1.067;
  const blended = pricing.cache_write * inputShare + pricing.output * (1 - inputShare);
  assert.equal(Number(blended.toFixed(3)), 1.851);
});

test('parseCoralbricks leaves unpublished limits and cache-write add-ons unknown', () => {
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
  assert.equal(rows[0].pricing.cache_write_addon, null);
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
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pricing.input, 1.12);
  assert.equal(rows[1].id, 'deepseek-v4.1-flash-fast');
});

test('authenticated CoralBricks prices, context and capability flags are authoritative', () => {
  const rows = parseCoralbricks(AUTH_FIXTURE);
  const glm = rows.find(m => m.id === 'glm-5.3-fast');
  assert.equal(glm.context_length, 1048576);
  assert.deepEqual(glm.pricing, {
    input: 1.12, output: 4.4, cache_read: 0, cache_write: 1.68, cache_write_addon: 0.56, input_billing: 'cache_write',
  });
  assert.deepEqual(glm.capabilities, {chat: true, image_input: false, tool_call: true});
  const flash = rows.find(m => m.id === 'deepseek-v4.1-flash-fast');
  assert.equal(flash.pricing.cache_write, 0.09);
  assert.equal(flash.capabilities.image_input, true);
  assert.ok(rows.every(m => m.max_completion_tokens === null));
});

test('retired CoralBricks alias slugs collapse into their current SKU instead of duplicating it', () => {
  const rows = parseCoralbricks(AUTH_FIXTURE);
  assert.equal(AUTH_FIXTURE.data.length, 4);
  assert.deepEqual(rows.map(m => m.id).sort(), ['deepseek-v4.1-flash-fast', 'glm-5.3-fast']);

  // An alias whose target is absent is listed once under the current slug and name.
  const alias = AUTH_FIXTURE.data.find(m => m.id === 'glm-5.3-fp4');
  const [renamed, ...rest] = parseCoralbricks({data: [alias, {...alias}]});
  assert.equal(rest.length, 0);
  assert.equal(renamed.id, 'glm-5.3-fast');
  assert.equal(renamed.name, 'GLM 5.3');
});

test('authenticated CoralBricks write add-ons are never derived or invented', () => {
  const model = AUTH_FIXTURE.data.find(m => m.id === 'glm-5.3-fast');
  const parsePricing = pricing => parseCoralbricks({data: [{...model, pricing} ]})[0].pricing;
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: 0.217, cache_write_multiple: 8}).cache_write, 1.337);
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: 0}).cache_write, 1.12);
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: undefined}).cache_write, null);
  assert.equal(parsePricing({...model.pricing, cached_input_per_m: undefined}).cache_read, null);
  assert.equal(parsePricing({...model.pricing, cache_write_per_m: -1}).cache_write, null);
  assert.equal(parsePricing({...model.pricing, input_per_m: undefined}).cache_write, null);
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
  assert.equal(rows.length, 2);
  const glm = rows.find(m => m.id === 'glm-5.3-fast');
  assert.equal(glm.name, 'GLM 5.3');
  assert.equal(glm.quantization, 'nvfp4');
  assert.equal(glm.context_length, 1048576);
  assert.equal(glm.pricing.cache_write, 1.68);
});

test('public deprecatedSlugs collapse retired slugs the authenticated API leaves unmarked', async () => {
  const unmarked = {...AUTH_FIXTURE, data: AUTH_FIXTURE.data.map(({alias_target, ...m}) => m)};
  const data = await providerLib.fetchCoralbricksCatalog('test-key', async url =>
    url.includes('inference.') ? unmarked : FIXTURE);
  assert.deepEqual(parseCoralbricks(data).map(m => m.id).sort(), ['deepseek-v4.1-flash-fast', 'glm-5.3-fast']);
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
  const rows = parseCoralbricks(data);
  assert.deepEqual(rows.map(m => m.id).sort(), ['deepseek-v4.1-flash-fast', 'glm-5.3-fast']);
  assert.equal(rows.find(m => m.id === 'glm-5.3-fast').pricing.cache_write, 1.68);
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
