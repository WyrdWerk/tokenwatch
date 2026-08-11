import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cheapestModels,
  cheapestImageModels,
  cheapestVideoModels,
  renderSeoTable,
  renderImageSeoSection,
  renderVideoSeoSection,
  renderFaqSection,
  calculatorStructuredData,
  renderJsonLd,
  replaceStructuredData,
  replaceSection,
  renderCounts,
  renderHomepageMeta,
  collectProviderPages,
  providerSlug,
  renderProviderDirectoryPage,
  renderApiDocsPage,
  buildSitemap,
  buildRobots,
} from '../scripts/seo-pages.mjs';
import { AGENTIC_MIX, blendedRate } from '../shared/cost.mjs';
import { API_ENDPOINTS, endpointDirectory } from '../shared/api-meta.mjs';

const textModels = [
  { id: 'org/cheap', name: 'Cheap <Model>', org: 'org', provider: 'alpha', pricing: { input: 1, output: 2, cache_read: 0.1 } },
  { id: 'org/expensive', name: 'Expensive', org: 'org', provider: 'alpha', pricing: { input: 4, output: 8, cache_read: 1 } },
  { id: 'org/other', name: 'Other', org: 'org', provider: 'beta', pricing: { input: 2, output: 3, cache_read: null } },
];

const imageModels = [
  { id: 'org/a', name: 'Image A', provider: 'alpha', pricing: [
    { unit: 'image', variant: 'large', cost_per_unit: 0.08, cost_per_million: null },
    { unit: 'image', variant: 'small', cost_per_unit: 0.04, cost_per_million: null },
    { unit: 'megapixel', variant: 'mp', cost_per_unit: 0.02, cost_per_million: 0.02 },
  ] },
  { id: 'org/b', name: 'Image B', provider: 'beta', pricing: [
    { unit: 'token', variant: 'standard', cost_per_unit: null, cost_per_million: 5 },
  ] },
];

const videoModels = [
  { id: 'org/v1', name: 'Video One', provider: 'alpha', pricing: [
    { resolution: '1080p', audio: true, cost_per_second: 0.2 },
    { resolution: '720p', audio: false, cost_per_second: 0.1 },
  ] },
  { id: 'org/v2', name: 'Video Two', provider: 'beta', pricing: [{ resolution: '720p', audio: null, cost_per_second: 0.15 }] },
];

test('cheapestModels ranks by the shared Agentic blended-rate contract', () => {
  const rows = cheapestModels(textModels, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].m.id, 'org/cheap');
  assert.equal(rows[0].eff, blendedRate(textModels[0].pricing, AGENTIC_MIX));
});

test('renderSeoTable escapes data and exposes the price columns', () => {
  const html = renderSeoTable(cheapestModels(textModels), '2026-08-11');
  assert.match(html, /Cheap &lt;Model&gt;/);
  assert.match(html, /Input \$\/M/);
  assert.match(html, /Blended \$\/M/);
  assert.match(html, /2026-08-11/);
  assert.doesNotMatch(html, /Cheap <Model>/);
});

test('image rankings remain separated by billing unit and pick one cheapest variant per model', () => {
  const flat = cheapestImageModels(imageModels, 'image', 10);
  const megapixel = cheapestImageModels(imageModels, 'megapixel', 10);
  const token = cheapestImageModels(imageModels, 'token', 10);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].p.variant, 'small');
  assert.equal(megapixel[0].rate, 0.02);
  assert.equal(token[0].rate, 5);

  const html = renderImageSeoSection({ image: flat, megapixel, token }, '2026-08-11');
  assert.match(html, /flat per-image/i);
  assert.match(html, /per-megapixel/i);
  assert.match(html, /million image tokens/i);
  assert.ok(html.indexOf('flat per-image') < html.indexOf('per-megapixel'));
});

test('video ranking selects the cheapest variant once and shows a 30-second example', () => {
  const rows = cheapestVideoModels(videoModels);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].m.id, 'org/v1');
  assert.equal(rows[0].p.resolution, '720p');
  const html = renderVideoSeoSection(rows, '2026-08-11');
  assert.match(html, /\$3\.00/);
  assert.match(html, /No audio/);
  assert.equal((html.match(/Video One/g) || []).length, 1);
});

test('visible FAQ and FAQPage JSON-LD are generated from the same records', () => {
  const faq = [['Can I compare prices?', 'Yes, compare matching units.'], ['Is missing cache free?', 'No.']];
  const visible = renderFaqSection('Questions', faq);
  const data = calculatorStructuredData({ page: 'image', title: 'Image pricing', description: 'Compare.', faq, rows: [] });
  const faqGraph = data['@graph'].find((node) => node['@type'] === 'FAQPage');
  assert.deepEqual(faqGraph.mainEntity.map((item) => [item.name, item.acceptedAnswer.text]), faq);
  for (const [question, answer] of faq) {
    assert.ok(visible.includes(question));
    assert.ok(visible.includes(answer));
  }
  assert.match(renderJsonLd(data), /id="seo-structured-data"/);
});

test('section and structured-data replacement are byte-idempotent', () => {
  const section = '    <section class="seo-faq" id="faq"><h2>FAQ</h2></section>';
  const shell = '<html><head><script type="application/ld+json">{"old":true}</script></head><body><main></main></body></html>';
  const data = calculatorStructuredData({ page: 'text', title: 'Text', description: 'Compare', faq: [], rows: [] });
  const once = replaceStructuredData(replaceSection(shell, 'seo-faq', section), data);
  const twice = replaceStructuredData(replaceSection(once, 'seo-faq', section), data);
  assert.equal(twice, once);
  assert.equal((twice.match(/seo-structured-data/g) || []).length, 1);
  assert.equal((twice.match(/class="seo-faq"/g) || []).length, 1);
});

test('renderCounts substitutes all count tokens and rejects drifted placeholders', () => {
  assert.equal(renderCounts('{{modelCount}}/{{providerCount}}', 1180, 82), '1180/82');
  assert.throws(() => renderCounts('{{model_count}}', 1, 1), /unreplaced count placeholder/);
});

test('renderHomepageMeta refreshes stale literal homepage counts, preserves OG/canonical markup, and is byte-idempotent', () => {
  const stale = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>LLM API Pricing Comparison — Compare 1180 Models Across 82 Providers | TokenWatch</title>
  <meta name="description" content="Know what your AI actually costs before the bill arrives. Compare pay-as-you-go LLM API pricing across 82 providers and 1180 models — text, image, and video. Enter your token mix or budget and find the cheapest option for your agentic workload." />
  <link rel="canonical" href="https://tokenwatch.wyrdwerk.com/" />
  <meta property="og:title" content="LLM API Pricing Comparison — Know What Your AI Actually Costs | TokenWatch" />
  <meta property="og:description" content="Compare pay-as-you-go LLM API pricing across 82 providers and 1180 models. Enter your token mix or budget and find the cheapest option for your agentic workload." />
</head>
<body>
  <header><h2 class="tagline">Know what your AI actually costs before the bill arrives</h2><p class="subtitle">Compare pay-as-you-go LLM API pricing across 82 providers and 1180 models. Enter your token mix or set a budget — see exactly what your agents cost before you commit.</p></header>
</body>
</html>`;
  const refreshed = renderHomepageMeta(stale, 1181, 82);
  // title, meta description, and visible subtitle carry the current model count (1181)
  assert.match(refreshed, /<title>LLM API Pricing Comparison — Compare 1181 Models Across 82 Providers \| TokenWatch<\/title>/);
  assert.match(refreshed, /<meta name="description" content="[^"]*across 82 providers and 1181 models[^"]*" \/>/);
  assert.match(refreshed, /<p class="subtitle">Compare pay-as-you-go LLM API pricing across 82 providers and 1181 models\./);
  // stale 1180 is gone from the overwritten fields
  assert.doesNotMatch(refreshed, /Compare 1180 Models/);
  // canonical and OG metadata are preserved untouched (OG retains the stale 1180, proving it was not rewritten)
  assert.match(refreshed, /<link rel="canonical" href="https:\/\/tokenwatch\.wyrdwerk\.com\/" \/>/);
  assert.match(refreshed, /<meta property="og:title" content="LLM API Pricing Comparison — Know What Your AI Actually Costs \| TokenWatch" \/>/);
  assert.match(refreshed, /<meta property="og:description" content="[^"]*across 82 providers and 1180 models[^"]*" \/>/);
  // unrelated header markup survives intact
  assert.match(refreshed, /<h2 class="tagline">Know what your AI actually costs before the bill arrives<\/h2>/);
  // repeated application is byte-idempotent
  assert.equal(renderHomepageMeta(refreshed, 1181, 82), refreshed);
});

test('renderHomepageMeta overwrites placeholder homepage fields after token substitution', () => {
  const templated = `<title>LLM API Pricing Comparison — Compare {{modelCount}} Models Across {{providerCount}} Providers | TokenWatch</title>
<meta name="description" content="Compare across {{providerCount}} providers and {{modelCount}} models." />
<p class="subtitle">Compare across {{providerCount}} providers and {{modelCount}} models.</p>`;
  const refreshed = renderHomepageMeta(renderCounts(templated, 1181, 82), 1181, 82);
  assert.match(refreshed, /Compare 1181 Models Across 82 Providers/);
  assert.match(refreshed, /<meta name="description" content="Know what your AI actually costs[^"]*across 82 providers and 1181 models[^"]*" \/>/);
  assert.match(refreshed, /<p class="subtitle">Compare pay-as-you-go LLM API pricing across 82 providers and 1181 models\./);
  assert.doesNotMatch(refreshed, /{{/);
});

test('provider pages require three distinct priced model identities across catalogs', () => {
  const pricing = {
    providers: [{ key: 'alpha', name: 'Alpha API' }, { key: 'thin', name: 'Thin' }],
    providers_meta: { alpha: { retains_prompts: false } },
    models: [textModels[0], textModels[1], { ...textModels[0], id: 'org/cheap-fp8' }, { ...textModels[0], provider: 'thin' }],
  };
  const pages = collectProviderPages({ pricing, imagePricing: { models: imageModels }, videoPricing: { models: videoModels } });
  const alpha = pages.find((page) => page.key === 'alpha');
  assert.ok(alpha);
  assert.equal(alpha.name, 'Alpha API');
  assert.ok(alpha.modelCount >= 3);
  assert.equal(pages.some((page) => page.key === 'thin'), false);
  assert.equal(providerSlug('Alpha API'), 'alpha-api');

  const directory = renderProviderDirectoryPage(pages);
  assert.match(directory, /\/providers\/alpha\//);
  assert.match(directory, /Reviewed ZDR/);
  assert.equal((directory.match(/<link rel="canonical"/g) || []).length, 1);
  assert.match(directory, /<h1 class="tagline">Inference provider directory<\/h1>/);
  assert.equal((directory.match(/<h1\b/g) || []).length, 1);
});

test('provider slug collisions fail instead of overwriting generated pages', () => {
  const records = (provider) => [1, 2, 3].map((n) => ({ id: `org/model-${provider}-${n}`, provider, pricing: { input: 1, output: 1 } }));
  const pricing = { providers: [], providers_meta: {}, models: [...records('a b'), ...records('a-b')] };
  assert.throws(() => collectProviderPages({ pricing, imagePricing: { models: [] }, videoPricing: { models: [] } }), /slug collision/);
});

test('API documentation renders from the same endpoint metadata as API discovery', () => {
  const docs = renderApiDocsPage();
  const directory = endpointDirectory();
  const discoverable = API_ENDPOINTS.filter((endpoint) => endpoint.path !== '/api/v1/');
  assert.equal(directory.length, discoverable.length);
  for (const endpoint of API_ENDPOINTS) assert.ok(docs.includes(endpoint.path));
  for (const endpoint of discoverable) {
    assert.ok(directory.some((line) => line.startsWith(endpoint.path + ' —')));
  }
  assert.match(docs, /min_intelligence/);
  assert.match(docs, /benchmarked/);
});

test('dynamic sitemap rejects duplicates and includes generated routes', () => {
  const sitemap = buildSitemap([
    { path: '/', lastmod: '2026-08-11' },
    { path: '/image', lastmod: '2026-08-10' },
    { path: '/providers/alpha/', lastmod: '2026-08-11' },
  ]);
  assert.equal((sitemap.match(/<url>/g) || []).length, 3);
  assert.match(sitemap, /https:\/\/tokenwatch\.wyrdwerk\.com\/providers\/alpha\//);
  assert.throws(() => buildSitemap([{ path: '/' }, { path: '/' }]), /duplicate sitemap path/);
  assert.match(buildRobots(), /Disallow: \/api\//);
});
