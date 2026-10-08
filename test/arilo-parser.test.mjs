import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as providerLib from '../scripts/lib.mjs';
import { blendedRate } from '../shared/cost.mjs';

// Public /v1/models response captured 2026-10-08; unrelated priced rows omitted.
const RESPONSE = JSON.parse(await readFile(new URL('./fixtures/arilo-models.json', import.meta.url), 'utf8'));

test('parseArilo lists only the exact DeepSeek model requested in issue #22', () => {
  assert.equal(typeof providerLib.parseArilo, 'function');
  const rows = providerLib.parseArilo(RESPONSE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'deepseek-v4.1-flash');
  assert.equal(rows[0].name, 'DeepSeek V4.1 Flash');
  assert.equal(rows[0].org, 'deepseek');
  assert.equal(rows[0].provider, 'arilo');
});

test('parseArilo uses live USD/M costs without token conversion or subscription discounts', () => {
  const [model] = providerLib.parseArilo(RESPONSE);
  assert.deepEqual(model.pricing, { input: 0.28, output: 0.6, cache_read: 0.01, cache_write: null });
  assert.equal(model.discount, 0);
  // 40% fresh × $0.28 + 35% cached × $0.01 + 25% output × $0.60.
  assert.ok(Math.abs(blendedRate(model.pricing, { inputPct: 40, cacheReadPct: 35, outputPct: 25 }) - 0.2655) < 1e-12);

  const changed = structuredClone(RESPONSE.data[1]);
  changed.cost = { input: '0.37', output: '0.91', cache_read: '0.023' };
  assert.deepEqual(providerLib.parseArilo({ data: [changed] })[0].pricing,
    { input: 0.37, output: 0.91, cache_read: 0.023, cache_write: null });
});

test('parseArilo keeps API context and provider-confirmed quantization/output limits', () => {
  const [model] = providerLib.parseArilo(RESPONSE);
  assert.equal(model.context_length, 1000000);
  assert.equal(model.max_completion_tokens, 60000);
  assert.equal(model.quantization, 'mxfp4');
  assert.notEqual(model.zdr, true);
});

test('parseArilo leaves missing tariffs and context unknown rather than inventing prices', () => {
  const [model] = providerLib.parseArilo({ data: [{ id: 'deepseek-v4.1-flash' }] });
  assert.equal(model.context_length, null);
  assert.deepEqual(model.pricing, { input: null, output: null, cache_read: null, cache_write: null });
  const [partial] = providerLib.parseArilo({ data: [{ id: 'deepseek-v4.1-flash', cost: { input: 0.31 } }] });
  assert.deepEqual(partial.pricing, { input: 0.31, output: null, cache_read: null, cache_write: null });
});

test('parseArilo handles missing catalogs and malformed records', () => {
  for (const input of [null, {}, { data: null }, { data: {} }, { data: [null, {}, { id: 22 }] }]) {
    assert.deepEqual(providerLib.parseArilo(input), []);
  }
});

test('Arilo aliases deduplicate under its direct-provider key without collapsing other hosts', () => {
  const [direct] = providerLib.parseArilo(RESPONSE);
  for (const name of ['Arilo', 'Arilo.id', 'arilo-id']) {
    assert.equal(providerLib.normalizeProvider(name), 'arilo');
    const rows = providerLib.dedupModels([
      direct,
      { ...direct, provider: name, pricing: { input: 9, output: 10 } },
      { ...direct, provider: 'deepinfra' },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0], direct);
    assert.equal(rows[1].provider, 'deepinfra');
  }
});

test('fetch-pricing registers keyless Arilo fetching, coding plans, and unconfirmed ZDR metadata', async () => {
  const src = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  const registry = src.match(/\{\s*key: 'arilo',[\s\S]*?\n  \}/)?.[0];
  assert.ok(registry, 'Arilo must be fetched by the pricing pipeline');
  assert.match(registry, /name: 'Arilo.id'/);
  assert.match(registry, /url: 'https:\/\/api.arilo.id\/v1\/models'/);
  assert.match(registry, /parse: parseArilo/);
  assert.doesNotMatch(registry, /apiKeyEnv/);

  const metadata = src.match(/  arilo: \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(metadata);
  assert.match(metadata, /privacy_policy_url: 'https:\/\/arilo.id\/privacy'/);
  assert.match(metadata, /terms_of_service_url: 'https:\/\/arilo.id\/terms'/);
  assert.match(metadata, /status_page_url: 'https:\/\/arilo.id\/status'/);
  assert.match(metadata, /headquarters: null/);
  assert.match(metadata, /datacenters: \['HK', 'IE'\]/);
  assert.match(metadata, /retains_prompts: null/);
  assert.match(metadata, /may_train: false/);
  assert.match(metadata, /retention_days: null/);
  const subscriptions = src.match(/const SUBSCRIPTION_PROVIDERS = new Set\(\[[\s\S]*?\]\)/)?.[0];
  assert.match(subscriptions, /'arilo'/);
});

test('the committed catalog and published-provider pages include Arilo', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/pricing.json', import.meta.url), 'utf8'));
  assert.equal(catalog.providers.find((provider) => provider.key === 'arilo')?.name, 'Arilo.id');
  assert.equal(catalog.providers_meta.arilo?.privacy_policy_url, 'https://arilo.id/privacy');
  assert.equal(catalog.providers_meta.arilo?.terms_of_service_url, 'https://arilo.id/terms');
  assert.equal(catalog.providers_meta.arilo?.retains_prompts, null);
  // A future upstream outage may legitimately yield zero rows; successful
  // fetches must never publish the unrelated or -alt SKUs.
  for (const model of catalog.models.filter((row) => row.provider === 'arilo')) {
    assert.equal(model.id, 'deepseek-v4.1-flash');
    assert.equal(model.subscription, true);
    assert.notEqual(model.zdr, true);
  }

  const published = JSON.parse(await readFile(new URL('../data/seo-published-pages.json', import.meta.url), 'utf8'));
  assert.ok(published.providers.includes('arilo'));
  const sitemap = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  assert.match(sitemap, /\/providers\/arilo\//);
  const page = await readFile(new URL('../public/providers/arilo/index.html', import.meta.url), 'utf8');
  assert.match(page, /Arilo\.id/);
});
