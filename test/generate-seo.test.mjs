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
  renderProviderPage,
  renderProviderDirectoryPage,
  collectModelPages,
  renderModelPage,
  providerPageSlugs,
  renderMethodologyPage,
  renderExploreLinks,
  renderBenchmarksSeoSection,
  renderApiDocsPage,
  buildOpenApiDocument,
  buildSitemap,
  buildRobots,
  buildLlmsTxt,
  renderFaqPage,
  chooseFaqItems,
} from '../scripts/seo-pages.mjs';
import { USE_CASES } from '../shared/use-cases.mjs';
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

test('SEO ranks explicit lower cache-write billing using the default billable rate', () => {
  const rows = cheapestModels([
    { id: 'deepseek-flash', provider: 'coralbricks', pricing: { input: 0.3, cache_write: 0.09, cache_read: 0, output: 1.2, input_billing: 'cache_write' } },
    { id: 'other-flash', provider: 'other', pricing: { input: 0.12, cache_read: 0, output: 1.2 } },
  ]);
  assert.equal(rows[0].m.provider, 'coralbricks');
  assert.equal(rows[0].eff, 0.00825);
  assert.ok(Math.abs(rows[1].eff - 0.009) < 1e-12);
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

test('website structured data names the product and publisher rather than a changing headline', () => {
  const website = calculatorStructuredData({ page: 'text', title: 'Keyword headline with counts', description: 'Pricing', rows: [] })['@graph'][0];
  assert.equal(website.name, 'TokenWatch');
  assert.equal(website.publisher.name, 'WyrdWerk');
  assert.equal(website.publisher.url, 'https://wyrdwerk.com');
  const image = calculatorStructuredData({ page: 'image', title: 'Image pricing', description: 'Images', rows: [] })['@graph'][0];
  assert.equal(image.name, 'Image pricing', 'non-website page titles stay specific');
});

test('benchmark structured data describes the collection and benchmark breadcrumb without rating claims', () => {
  const data = calculatorStructuredData({ page: 'benchmarks', title: 'LLM benchmarks by use case', description: 'Model evaluations' });
  const page = data['@graph'][0];
  assert.equal(page['@type'], 'CollectionPage');
  assert.equal(page.url, 'https://tokenwatch.wyrdwerk.com/benchmarks');
  const breadcrumb = data['@graph'].find(node => node['@type'] === 'BreadcrumbList');
  assert.equal(breadcrumb.itemListElement[1].name, 'Benchmarks');
  assert.equal(breadcrumb.itemListElement[1].item, page.url);
  assert.equal(data['@graph'].length, 2, 'no unsupported ratings or offer schema');
});

test('llms manifest distinguishes offerings and freshness and exposes model and API discovery', () => {
  const manifest = buildLlmsTxt({
    modelCount: 23, providerCount: 7, imageCount: 11, videoCount: 5,
    generatedAt: '2026-10-01T03:04:05.000Z',
  });
  assert.match(manifest, /23 provider-specific text offerings across 7 inference providers, 11 image models, 5 video models/);
  assert.match(manifest, /Text catalog generated 2026-10-01T03:04:05\.000Z/);
  for (const path of ['/models/', '/providers/', '/docs/methodology/', '/docs/api/', '/openapi.json', '/skill.md']) {
    assert.ok(manifest.includes(`](https://tokenwatch.wyrdwerk.com${path})`), `missing discovery link: ${path}`);
  }
  assert.match(manifest, /2\.5% input, 97% cached input, 0\.5% output/);
  assert.match(manifest, /input_billing/);
  assert.match(manifest, /not an exact invoice/);
  assert.match(manifest, /Established comparison URLs remain available/);
  assert.match(manifest, /Missing coverage is not a zero price or proof of retirement/);
});

test('homepage metadata uses current offering counts in search, social, and visible copy', () => {
  const stale = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>LLM API Pricing Comparison — Compare 1180 Models Across 82 Providers | TokenWatch</title>
  <meta name="description" content="Know what your AI actually costs before the bill arrives. Compare pay-as-you-go LLM API pricing across 82 providers and 1180 models — text, image, and video. Enter your token mix or budget and find the cheapest option for your agentic workload." />
  <link rel="canonical" href="https://tokenwatch.wyrdwerk.com/" />
  <meta property="og:title" content="LLM API Pricing Comparison — Know What Your AI Actually Costs | TokenWatch" />
  <meta property="og:description" content="Compare pay-as-you-go LLM API pricing across 82 providers and 1180 models. Enter your token mix or budget and find the cheapest option for your agentic workload." />
  <meta name="twitter:title" content="Stale title" />
  <meta name="twitter:description" content="1180 models across 82 providers" />
</head>
<body>
  <header><h2 class="tagline">Know what your AI actually costs before the bill arrives</h2><p class="subtitle">Compare pay-as-you-go LLM API pricing across 82 providers and 1180 models. Enter your token mix or set a budget — see exactly what your agents cost before you commit.</p></header>
</body>
</html>`;
  const refreshed = renderHomepageMeta(stale, 1181, 83);
  assert.match(refreshed, /<title>LLM API Pricing Comparison &amp; Open Model Finder \| TokenWatch<\/title>/);
  for (const field of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
    assert.ok(refreshed.includes(`<meta ${field} content="Compare 1,181 LLM API prices across 83 providers, updated every 2 hours. Find the cheapest provider for your workload`));
  }
  for (const field of ['property="og:title"', 'name="twitter:title"']) {
    assert.ok(refreshed.includes(`<meta ${field} content="LLM API Pricing Comparison &amp; Open Model Finder | TokenWatch"`));
  }
  assert.match(refreshed, /<p class="subtitle">Compare pay-as-you-go LLM API pricing across 83 providers and 1181 text-model offerings\./);
  assert.doesNotMatch(refreshed, /1180|82 providers|1181 models|Stale title/);
  assert.match(refreshed, /<link rel="canonical" href="https:\/\/tokenwatch\.wyrdwerk\.com\/" \/>/);
  assert.match(refreshed, /<h2 class="tagline">Know what your AI actually costs before the bill arrives<\/h2>/);
  assert.equal(renderHomepageMeta(refreshed, 1181, 83), refreshed);
});

test('renderHomepageMeta overwrites placeholder homepage fields after token substitution', () => {
  const templated = `<title>LLM API Pricing Comparison — Compare {{modelCount}} Models Across {{providerCount}} Providers | TokenWatch</title>
<meta name="description" content="Compare across {{providerCount}} providers and {{modelCount}} models." />
<p class="subtitle">Compare across {{providerCount}} providers and {{modelCount}} models.</p>`;
  const refreshed = renderHomepageMeta(renderCounts(templated, 1181, 82), 1181, 82);
  assert.match(refreshed, /LLM API Pricing Comparison &amp; Open Model Finder \| TokenWatch/);
  assert.match(refreshed, /<meta name="description" content="Compare 1,181 LLM API prices across 82 providers[^"]*" \/>/);
  assert.match(refreshed, /<p class="subtitle">Compare pay-as-you-go LLM API pricing across 82 providers and 1181 text-model offerings\./);
  assert.doesNotMatch(refreshed, /{{/);
});

test('pricing and provider tables link only models and providers with generated pages', () => {
  const linkedModelPages = new Map([['cheap', 'cheap']]);
  const rows = cheapestModels(textModels);
  const table = renderSeoTable(rows, '2026-10-01', { linkedModelPages, linkedProviderSlugs: new Set(['alpha']) });
  assert.match(table, /<a href="\/models\/cheap\/">Cheap &lt;Model&gt;<\/a>/);
  assert.match(table, /<a href="\/providers\/alpha\/">alpha<\/a>/);
  assert.doesNotMatch(table, /href="\/(?:models\/(?:expensive|other)|providers\/beta)\//);
  assert.match(table, /<td>Other<\/td>/);
  const provider = collectProviderPages({ pricing: { models: textModels }, imagePricing: { models: imageModels }, videoPricing: { models: videoModels } })[0];
  const html = renderProviderPage(provider, { text: '2026-10-01', image: '2026-09-30', video: '2026-09-29' }, { linkedModelPages });
  assert.match(html, /href="\/models\/cheap\//);
  assert.match(html, /href="\/models\/">Models<\/a>/);
  assert.match(renderExploreLinks(), /href="\/models\//);
});

test('benchmark snapshot links eligible models and names its own date and workload', () => {
  const bench = { generated_at: '2026-09-29T04:05:06Z', model_count: 2, models: [
    { id: 'org/cheap', name: 'Cheap <Model>', org: 'org', scores: { aa_intelligence: 80 }, from: { blended_per_m: 0.04 } },
    { id: 'other', name: 'Other', org: 'org', scores: { aa_intelligence: 90 }, from: { blended_per_m: 1.2 } },
  ] };
  const html = renderBenchmarksSeoSection(bench, new Map([['cheap', 'cheap']]));
  assert.match(html, /href="\/models\/cheap\/">Cheap &lt;Model&gt;<\/a>/);
  assert.doesNotMatch(html, /href="\/models\/other\//);
  assert.match(html, /2026-09-29T04:05:06Z/);
  assert.match(html, /2\.5% input, 97% cached input, 0\.5% output/);
});

test('methodology gives attributed, workload-specific examples without conflating offerings and models', () => {
  const models = [
    { id: 'cache', name: 'Cache', provider: 'a', pricing: { input: 1, cache_read: 0.01, output: 12 } },
    { id: 'output', name: 'Output', provider: 'b', pricing: { input: 3, cache_read: 1, output: 1 } },
    { id: 'rag', name: 'RAG', provider: 'c', pricing: { input: 0.5, cache_read: 2, output: 5 } },
  ];
  const html = renderMethodologyPage({
    modelCount: 3,
    providerCount: 3,
    generatedAt: '2026-10-01T01:02:03Z',
    models,
    arenaSource: {
      url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset',
      license: 'CC-BY-4.0',
      license_url: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: 'Arena (LMArena), Leaderboard Dataset; ratings are unchanged.',
      rating_dates: { arena_text: '2026-10-02', arena_creative_writing: '2026-10-02' },
    },
  });
  assert.match(html, /Cache-heavy agents[\s\S]*?<td>Cache[\s\S]*?\$0\.095/);
  assert.match(html, /Uncached retrieval\/RAG[\s\S]*?<td>RAG[\s\S]*?\$1\.40/);
  assert.match(html, /Balanced uncached[\s\S]*?<td>Output[\s\S]*?\$2\.00/);
  assert.match(html, /Output-heavy generation[\s\S]*?<td>Output[\s\S]*?\$1\.20/);
  assert.match(html, /Yash Jain/);
  assert.match(html, /https:\/\/github\.com\/WyrdWerk\/tokenwatch\/issues/);
  assert.match(html, /href="\/pricing\.json"/);
  assert.match(html, /provider-specific offerings/);
  assert.match(html, /Creative Writing ratings are dated 2026-10-02/);
  assert.match(html, /CC BY 4\.0/);
  assert.match(html, /Arena \(LMArena\), Leaderboard Dataset/);
  const article = JSON.parse(html.match(/id="seo-structured-data" type="application\/ld\+json">(.*?)<\/script>/)[1])['@graph'][0];
  assert.equal(article.author.name, 'Yash Jain');
  assert.equal(article.publisher.name, 'WyrdWerk');
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

test('published provider URLs survive missing coverage without admitting new landing pages', () => {
  const pricing = {
    providers: [{ key: 'missing', name: 'Missing Provider' }], providers_meta: {},
    models: [textModels[0], ...[1, 2, 3].map(n => ({ ...textModels[0], id: `new-${n}`, provider: 'new' }))],
  };
  const pages = collectProviderPages({ pricing, imagePricing: { models: [] }, videoPricing: { models: [] }, publishedProviders: new Set(['alpha', 'missing']) });
  assert.deepEqual(pages.map(p => p.key).sort(), ['alpha', 'missing']);
  assert.equal(pages.find(p => p.key === 'alpha').modelCount, 1);
  const missing = pages.find(p => p.key === 'missing');
  assert.equal(missing.modelCount, 0);
  const html = renderProviderPage(missing, { text: '2026-10-02' });
  assert.match(html, /data-catalog-unavailable/);
  assert.match(html, /No current priced offerings/);
  assert.doesNotMatch(html, /\$0|<tbody>[\s\S]*?<tr>/);
});

test('published model URLs survive low or absent coverage and do not authorize new models', () => {
  const pricing = { models: [textModels[0], ...['a', 'b', 'c'].map(provider => ({ ...textModels[0], id: 'new-model', provider }))] };
  const pages = collectModelPages({ pricing }, { publishedModels: new Set(['cheap', 'missing-model']) });
  assert.deepEqual(pages.map(p => p.canonical), ['cheap', 'missing-model']);
  assert.equal(pages[0].providerCount, 1);
  const thinHtml = renderModelPage(pages[0], { historyEnabled: false });
  assert.match(thinHtml, /<title>[^<]* API Pricing: 1 Provider from \$[\d.]+\/M[^<]*<\/title>/);
  assert.match(thinHtml, /API pricing across 1 provider\./);
  assert.match(thinHtml, /1 tracked provider; 1 priced offering/);
  assert.equal(pages[1].cheapestEff, null);
  const html = renderModelPage(pages[1], { historyEnabled: false });
  assert.match(html, /data-catalog-unavailable/);
  assert.match(html, /No current priced offerings/);
  assert.doesNotMatch(html, /\$0|<tbody>\s*<tr>/);
});

test('provider slug collisions fail instead of overwriting generated pages', () => {
  const records = (provider) => [1, 2, 3].map((n) => ({ id: `org/model-${provider}-${n}`, provider, pricing: { input: 1, output: 1 } }));
  const pricing = { providers: [], providers_meta: {}, models: [...records('a b'), ...records('a-b')] };
  assert.throws(() => collectProviderPages({ pricing, imagePricing: { models: [] }, videoPricing: { models: [] } }), /slug collision/);
});

test('API documentation renders from the same endpoint metadata as API discovery', () => {
  const docs = renderApiDocsPage();
  const openApi = buildOpenApiDocument();
  const directory = endpointDirectory();
  const discoverable = API_ENDPOINTS.filter((endpoint) => endpoint.path !== '/api/v1/');
  assert.equal(directory.length, discoverable.length);
  for (const endpoint of API_ENDPOINTS) assert.ok(docs.includes(endpoint.path));
  for (const endpoint of discoverable) {
    assert.ok(directory.some((line) => line.startsWith(endpoint.path + ' —')));
  }
  assert.match(docs, /min_intelligence/);
  assert.match(docs, /open_weights=true/);
  assert.match(docs, /benchmarked/);
  assert.match(docs, /assumed workload defaults/);
  assert.match(docs, /recommend\?use_case=agentic-coding/);
  assert.match(docs, /<code>source<\/code> metadata/);
  assert.match(docs, /CC BY 4\.0/);
  assert.match(docs, /href="\/openapi\.json"/);
  assert.equal(openApi.openapi, '3.1.0');
  assert.equal(openApi.servers[0].url, 'https://tokenwatch.wyrdwerk.com');
  for (const endpoint of API_ENDPOINTS) {
    const path = endpoint.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    assert.ok(openApi.paths[path]?.get, `missing OpenAPI operation for ${endpoint.path}`);
    assert.match(openApi.paths[path].get.operationId, /^[A-Za-z][A-Za-z0-9]*$/, `operationId must be identifier-safe for ${endpoint.path}`);
  }
  const openWeights = openApi.paths['/api/v1/models'].get.parameters.find((parameter) => parameter.name === 'open_weights');
  assert.deepEqual(openWeights.schema, { type: 'boolean' });
  assert.match(openWeights.description, /unknown statuses are excluded/);
  const recommend = openApi.paths['/api/v1/recommend'].get.parameters;
  assert.match(openApi.paths['/api/v1/recommend'].get.responses[200].description, /Arena preference\.favorite/);
  assert.equal(recommend.find((parameter) => parameter.name === 'use_case').required, true);
  assert.deepEqual(recommend.find((parameter) => parameter.name === 'priority').schema.enum,
    ['balanced', 'cheapest', 'fastest', 'most-reliable']);
  assert.deepEqual(recommend.find((parameter) => parameter.name === 'zdr').schema, { type: 'boolean' });
  assert.equal(recommend.find((parameter) => parameter.name === 'exclude_hq').schema.pattern,
    '^[A-Za-z]{2}(,[A-Za-z]{2})*$');
  assert.deepEqual(recommend.find((parameter) => parameter.name === 'include_proprietary').schema,
    { type: 'boolean' });
  assert.deepEqual(recommend.find((parameter) => parameter.name === 'detail').schema,
    { type: 'string', enum: ['compact', 'full'], default: 'compact' });
  assert.deepEqual(recommend.find((parameter) => parameter.name === 'limit').schema,
    { type: 'integer', minimum: 1, maximum: 100, default: 10 });
  assert.match(recommend.find((parameter) => parameter.name === 'detail').description, /compact/);
  const providers = openApi.paths['/api/v1/recommend/providers'].get.parameters;
  assert.equal(providers.find((parameter) => parameter.name === 'model').required, true);
  assert.equal(providers.find((parameter) => parameter.name === 'include_proprietary').schema.type, 'boolean');
  assert.equal(providers.find((parameter) => parameter.name === 'limit').schema.maximum, 100);
  assert.match(docs, /full explanations on the three model picks/);
  assert.match(docs, /limit=1\.\.100/);
  assert.equal(openApi.paths['/api/v1/use-cases'].get.summary.includes('assumed mixes'), true);
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
  assert.match(buildRobots(), /User-agent: \*\nAllow: \//);
  assert.doesNotMatch(buildRobots(), /Disallow:/, 'crawlers must be able to read public API noindex responses');
});

/** A three-provider model, eligible at the PR 1 parity threshold of 3. */
function eligibleModel(extra = {}) {
  // A three-provider model, eligible at MODEL_MIN_PROVIDERS = 3.
  return ['alpha', 'beta', 'gamma'].map((provider) => ({
    id: 'org/model', name: 'Model', org: 'org', provider, quantization: null,
    discount: 0, pricing: { input: 1, output: 2, cache_read: 0.1 }, ...extra,
  }));
}

/** Build a collected model page from a plain model list. */
function collectOne(models) {
  const [page] = collectModelPages({ pricing: { models } });
  assert.ok(page, 'expected an eligible model page');
  return page;
}

// ── Model-page price history (this PR) ───────────────────────────────────────
//
// The renderer basics (eligibility, :batch exclusion, slug sanitization,
// provider table, ranges, byte-idempotence) are covered by PR #18's
// test/model-pages.test.mjs. These tests cover only the history layer this PR
// adds on top.

test('a model page mounts the price-history sparkline with real wiring', () => {
  const page = collectOne(eligibleModel());
  const html = renderModelPage(page, { lastmod: '2026-09-14' });

  // Mount point + container the client script looks for.
  assert.match(html, /data-price-history="model"/);
  assert.match(html, /data-price-history-chart/);
  assert.match(html, /data-price-history-note/);
  // Both client scripts must actually be loaded, or the chart never renders.
  assert.match(html, /src="\/price-sparkline\.js\?v=dev" defer/);
  assert.match(html, /src="\/model-history\.js\?v=dev" defer/);
  // The chart starts in a loading state — it must never be server-rendered with
  // fabricated points, because history lives in D1 and is unavailable at build.
  assert.match(html, /Loading price history/);
  assert.doesNotMatch(html, /<circle|<path d=/);
  // A noscript fallback so the page is still useful without JavaScript.
  assert.match(html, /<noscript>/);
});

test('a model page with history disabled omits the chart entirely', () => {
  const page = collectOne(eligibleModel());
  const html = renderModelPage(page, { lastmod: '2026-09-14', historyEnabled: false });
  assert.doesNotMatch(html, /data-price-history/);
  assert.doesNotMatch(html, /model-history\.js/);
  assert.doesNotMatch(html, /price-sparkline\.js/);
  // The page must not promise a chart it cannot serve.
  assert.doesNotMatch(html, /Loading price history/);
  assert.doesNotMatch(html, /up to 90 days/);
});

test('model-page wording says history is retained for up to 90 days, not guaranteed', () => {
  const page = collectOne(eligibleModel());
  const html = renderModelPage(page, { lastmod: '2026-09-14' });

  // Day-one pages must not claim 90 days of data exist.
  assert.match(html, /retained for up to 90 days/);
  assert.match(html, /history begins with the first recorded snapshot/);
  assert.doesNotMatch(html, /90-day price history/i);
  assert.doesNotMatch(html, /90 days of/i);
  assert.doesNotMatch(html, /90-Day History/);

  // The panel heading is the neutral "Daily price history".
  assert.match(html, /<h2 id="price-history-heading">Daily price history<\/h2>/);
});

test('model pages link only providers that have a generated page', () => {
  const page = collectOne(eligibleModel());
  // Only 'alpha' has a generated provider page; beta and gamma do not.
  const html = renderModelPage(page, { lastmod: '2026-09-14', linkedProviderSlugs: new Set(['alpha']) });

  assert.match(html, /<a href="\/providers\/alpha\/">Alpha<\/a>/);
  // Unlinked providers still appear as text — the row is never dropped.
  assert.match(html, />Beta</);
  assert.match(html, />Gamma</);
  assert.doesNotMatch(html, /href="\/providers\/beta\/"/);
  assert.doesNotMatch(html, /href="\/providers\/gamma\/"/);
  // Every emitted provider link resolves against the allowed set.
  for (const match of html.matchAll(/href="\/providers\/([^/"]+)\//g)) {
    assert.equal(match[1], 'alpha', `unexpected provider link: ${match[1]}`);
  }
});

test('providerPageSlugs derives link eligibility from the generated provider set', () => {
  const providerPages = collectProviderPages({
    pricing: {
      providers: [{ key: 'alpha', name: 'Alpha' }],
      providers_meta: {},
      models: [
        // Three distinct canonical identities from 'alpha' → a provider page exists.
        { id: 'org/model-a', provider: 'alpha', pricing: { input: 1, output: 2 } },
        { id: 'org/model-b', provider: 'alpha', pricing: { input: 1, output: 2 } },
        { id: 'org/model-c', provider: 'alpha', pricing: { input: 1, output: 2 } },
        // 'thin' has one identity → no provider page → must not be linked.
        { id: 'org/thin', provider: 'thin', pricing: { input: 1, output: 2 } },
      ],
    },
    imagePricing: { models: [] },
    videoPricing: { models: [] },
  });
  const slugs = providerPageSlugs(providerPages);
  assert.equal(slugs.has('alpha'), true);
  assert.equal(slugs.has('thin'), false);
});

test('recommender discovery: llms.txt, FAQ, methodology, explore links, and model pages point to /choose/', () => {
  const manifest = buildLlmsTxt({ modelCount: 1, providerCount: 1, imageCount: 1, videoCount: 1, generatedAt: '2026-10-04T00:00:00Z' });
  assert.match(manifest.split('\n')[2], /use-case model finder/, 'summary line mentions the finder');
  assert.ok(manifest.indexOf('## Choose a model and provider for a use case') < manifest.indexOf('## Pages'), 'choose section is prominent');
  for (const id of Object.keys(USE_CASES)) {
    assert.ok(manifest.includes(`https://tokenwatch.wyrdwerk.com/choose/?useCase=${id}`), `deep link for ${id}`);
  }
  for (const needle of ['/api/v1/use-cases', '/api/v1/recommend?use_case=', '/api/v1/recommend/providers?use_case=', 'recommend_model', 'recommend_provider', 'CC BY 4.0']) {
    assert.ok(manifest.includes(needle), `llms.txt mentions ${needle}`);
  }

  const faqHtml = renderFaqPage({ modelCount: 1, providerCount: 1 });
  assert.match(faqHtml, /id="choosing-a-model"/);
  assert.match(faqHtml, /href="\/choose\/"/);
  const data = JSON.parse(faqHtml.match(/application\/ld\+json">(.*?)<\/script>/)[1]);
  const faq = data['@graph'].find((node) => node['@type'] === 'FAQPage');
  for (const [question] of chooseFaqItems()) {
    assert.ok(faq.mainEntity.some((item) => item.name === question), `JSON-LD carries: ${question}`);
  }
  assert.equal(faq.mainEntity.length, (faqHtml.match(/<details>/g) || []).length);

  const methodology = renderMethodologyPage({ modelCount: 1, providerCount: 1, generatedAt: '2026-10-04T00:00:00Z' });
  assert.match(methodology, /<h2 id="recommendations">How recommendations work<\/h2>/);
  for (const useCase of Object.values(USE_CASES)) {
    assert.ok(methodology.includes(`href="/choose/?useCase=${useCase.id}"`), `preset row for ${useCase.id}`);
    assert.ok(methodology.includes(`≥ ${useCase.qualityFloor.min}<`), `floor for ${useCase.id}`);
  }
  assert.match(methodology, /close call/);
  assert.match(methodology, /Pareto/);

  assert.match(renderExploreLinks(), /href="\/choose\/"/);
  const page = collectModelPages({ pricing: { models: [
    { id: 'm', name: 'M', provider: 'a', pricing: { input: 1, output: 2 } },
    { id: 'm', name: 'M', provider: 'b', pricing: { input: 1, output: 2 } },
    { id: 'm', name: 'M', provider: 'c', pricing: { input: 1, output: 2 } },
  ] } })[0];
  assert.match(renderModelPage(page, { historyEnabled: false }), /Is this the right model for your workload\? <a href="\/choose\/">/);
});

test('provider snippet: concrete title and description computed from the rendered records', async () => {
  const { catalogMonth, snippetPrice, fitTitle, providerPageTitle } = await import('../scripts/seo-pages.mjs');
  assert.equal(catalogMonth('2026-10-04T16:20:00.000Z'), 'Oct 2026');
  assert.equal(catalogMonth('2026-01-31'), 'Jan 2026');
  assert.equal(catalogMonth('garbage'), null);
  assert.equal(snippetPrice(0.05), '$0.05');
  assert.equal(snippetPrice(1.5), '$1.50');
  assert.equal(snippetPrice(0.0044), '$0.0044');
  assert.equal(snippetPrice(0), null);
  assert.equal(fitTitle(['x'.repeat(70), 'short']), 'short');
  assert.equal(fitTitle(['x'.repeat(70), 'y'.repeat(80)]), 'y'.repeat(80), 'last candidate is the fallback');

  const pricing = {
    providers: [{ key: 'alpha', name: 'Alpha' }],
    providers_meta: { alpha: { retains_prompts: false } },
    models: [
      { ...textModels[0], name: 'Org: Cheap Model', zdr: true },
      textModels[1],
      { id: 'org/third', name: 'Third', provider: 'alpha', pricing: { input: 3, output: 6, cache_read: null } },
    ],
  };
  const provider = collectProviderPages({ pricing, imagePricing: { models: [] }, videoPricing: { models: [] } })[0];
  const html = renderProviderPage(provider, { text: '2026-10-04' });
  const title = html.match(/<title>(.*?)<\/title>/)[1];
  assert.equal(title, 'Alpha API Pricing (Oct 2026): 3 Models from $1.00/M | TokenWatch');
  assert.ok(title.length <= 65);
  const description = html.match(/name="description" content="([^"]+)"/)[1];
  assert.match(description, /^Alpha API pricing \(Oct 2026\): 3 models tracked\. Cheapest: Cheap Model at \$1\.00\/M input, \$2\.00\/M output\./);
  assert.match(description, /Cache-read pricing on 2 of 3 text models\./);
  assert.match(description, /Zero data retention\./);
  for (const field of ['property="og:title"', 'name="twitter:title"']) assert.ok(html.includes(`<meta ${field} content="${title}"`), field);
  for (const field of ['property="og:description"', 'name="twitter:description"']) assert.ok(html.includes(`<meta ${field} content="${description}"`), field);
  // The snippet's cheapest model and price also appear in the page body.
  assert.match(html, /data-snippet-facts>Cheapest input price: Cheap Model at \$1\.00 per million input tokens/);

  // Long names fall back gracefully within the budget.
  const long = { ...provider, name: 'An Extremely Long Inference Provider Name' };
  const longTitle = providerPageTitle(long, 'Oct 2026');
  assert.ok(longTitle.length <= 65, longTitle);
  assert.match(longTitle, /^An Extremely Long Inference Provider Name API Pricing/);
});

test('model snippet: provider count, cheapest input, month, and readable model name', () => {
  const pricing = { models: ['a', 'b', 'c'].map((provider, index) => ({
    id: 'zai-org/GLM-9', name: 'zai-org/GLM-9', provider, pricing: { input: 0.5 + index, output: 2 + index, cache_read: index ? 0.1 : null },
  })).concat([{ id: 'z-ai/glm-9', name: 'Z.ai: GLM 9', provider: 'd', provider_display: 'Delta Cloud', pricing: { input: 0.2, output: 1, cache_read: 0.01 } }]) };
  const [page] = collectModelPages({ pricing }, { minProviders: 3 });
  assert.equal(page.name, 'GLM 9');
  const html = renderModelPage(page, { lastmod: '2026-10-04' });
  const title = html.match(/<title>(.*?)<\/title>/)[1];
  assert.equal(title, 'GLM 9 API Pricing: 4 Providers from $0.20/M (Oct 2026)', 'brand suffix dropped to fit 65 chars');
  const description = html.match(/name="description" content="([^"]+)"/)[1];
  assert.match(description, /^GLM 9 API pricing \(Oct 2026\) across 4 providers\. Input \$0\.20–\$2\.50\/M, output \$1\.00–\$4\.00\/M\./);
  assert.match(description, /Cheapest for cached agent workloads: Delta Cloud at \$[\d.]+\/M blended\./);
  assert.match(description, /Cache-read pricing on 3 of 4 offerings\./);
  assert.ok(html.includes(`<meta name="twitter:description" content="${description}"`));
});

test('homepage description leads with real offering and provider counts', () => {
  const html = renderHomepageMeta('<title>x</title><meta name="description" content="old" />', 1597, 101);
  assert.match(html, /content="Compare 1,597 LLM API prices across 101 providers, updated every 2 hours\./);
});
