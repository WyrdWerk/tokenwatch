import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROVIDER_MAP } from '../shared/modelsdev.mjs';

test('retired Lilac is absent from pricing fetches, policy metadata, and coding plans', async () => {
  const source = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /key: 'lilac'/);
  assert.doesNotMatch(source, /api\.getlilac\.com/);
  assert.doesNotMatch(source, /parseLilac/);
  assert.doesNotMatch(source, /\blilac: \{/);
  const subscriptions = source.match(/const SUBSCRIPTION_PROVIDERS = new Set\(\[[\s\S]*?\]\)/)?.[0];
  assert.ok(subscriptions);
  assert.doesNotMatch(subscriptions, /'lilac'/);
});

test('performance refreshes no longer request the retired Lilac status API', async () => {
  const source = await readFile(new URL('../scripts/fetch-performance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /api\.getlilac\.com/);
  assert.doesNotMatch(source, /Fetching Lilac performance/);
  assert.match(source, /https:\/\/status\.umans\.ai\//);
  assert.match(source, /parseCoralbricksPerformance/);
});

test('models.dev enrichment no longer indexes Lilac as an active TokenWatch provider', () => {
  assert.equal(PROVIDER_MAP.lilac, undefined);
  assert.equal(PROVIDER_MAP.umans, 'umans-ai-coding-plan');
});

test('published catalogs and SEO no longer retain the discontinued Lilac provider', async () => {
  const catalog = JSON.parse(await readFile(new URL('../public/pricing.json', import.meta.url), 'utf8'));
  assert.ok(!catalog.providers.some((provider) => provider.key === 'lilac'));
  assert.ok(!catalog.models.some((model) => model.provider === 'lilac'));
  assert.equal(catalog.providers_meta.lilac, undefined);

  const published = JSON.parse(await readFile(new URL('../data/seo-published-pages.json', import.meta.url), 'utf8'));
  assert.ok(!published.providers.includes('lilac'));
  const sitemap = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
  assert.doesNotMatch(sitemap, /\/providers\/lilac\//);
  await assert.rejects(readFile(new URL('../public/providers/lilac/index.html', import.meta.url)), { code: 'ENOENT' });
});
