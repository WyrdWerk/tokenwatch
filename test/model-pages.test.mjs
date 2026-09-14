import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectModelPages,
  renderModelPage,
  MODEL_MIN_PROVIDERS,
  modelPageSlug,
} from '../scripts/seo-pages.mjs';

const models = [
  // 3 distinct priced providers → eligible
  { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', org: 'deepseek', provider: 'deepinfra', quantization: null, pricing: { input: 0.09, output: 0.18, cache_read: 0.018, cache_write: null } },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', org: 'deepseek', provider: 'hyper', quantization: null, pricing: { input: 0.2, output: 0.4, cache_read: 0.04, cache_write: null } },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', org: 'deepseek', provider: 'zro', quantization: null, discount: 0.5, pricing: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: null } },
  // Only 2 providers → ineligible (thin page)
  { id: 'org/two-provider', name: 'Two Provider', org: 'org', provider: 'alpha', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/two-provider', name: 'Two Provider', org: 'org', provider: 'beta', pricing: { input: 1.5, output: 3, cache_read: null } },
  // :batch variant with 3 providers → excluded by default
  { id: 'org/batch-model:batch', name: 'Batch Model', org: 'org', provider: 'alpha', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/batch-model:batch', name: 'Batch Model', org: 'org', provider: 'beta', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/batch-model:batch', name: 'Batch Model', org: 'org', provider: 'gamma', pricing: { input: 1, output: 2, cache_read: null } },
  // Quantized variants stay distinct canonical IDs, each with 3 providers
  { id: 'org/glm-5.2-fp8', name: 'GLM 5.2 FP8', org: 'org', provider: 'alpha', quantization: 'fp8', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/glm-5.2-fp8', name: 'GLM 5.2 FP8', org: 'org', provider: 'beta', quantization: 'fp8', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/glm-5.2-fp8', name: 'GLM 5.2 FP8', org: 'org', provider: 'gamma', quantization: 'fp8', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/glm-5.2-nvfp4', name: 'GLM 5.2 NVFP4', org: 'org', provider: 'alpha', quantization: 'nvfp4', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/glm-5.2-nvfp4', name: 'GLM 5.2 NVFP4', org: 'org', provider: 'beta', quantization: 'nvfp4', pricing: { input: 1, output: 2, cache_read: null } },
  { id: 'org/glm-5.2-nvfp4', name: 'GLM 5.2 NVFP4', org: 'org', provider: 'gamma', quantization: 'nvfp4', pricing: { input: 1, output: 2, cache_read: null } },
];

const pricing = { models, providers: [], providers_meta: {} };

test('collectModelPages requires at least three distinct priced providers', () => {
  const pages = collectModelPages({ pricing });
  const slugs = pages.map((p) => p.slug).sort();
  assert.deepEqual(slugs, ['deepseek-v4-flash', 'glm-5.2-fp8', 'glm-5.2-nvfp4']);
  assert.equal(MODEL_MIN_PROVIDERS, 3);
  assert.equal(pages.find((p) => p.slug === 'deepseek-v4-flash').providerCount, 3);
  assert.equal(pages.some((p) => p.slug === 'two-provider'), false, 'thin models excluded');
});

test('collectModelPages excludes :batch pages by default but keeps quantized ids distinct', () => {
  const pages = collectModelPages({ pricing });
  assert.equal(pages.some((p) => p.slug.includes('batch')), false);
  const quantized = pages.filter((p) => p.slug.startsWith('glm-5.2-')).map((p) => p.slug);
  assert.deepEqual(quantized.sort(), ['glm-5.2-fp8', 'glm-5.2-nvfp4']);
});

test('collectModelPages can opt batch variants back in', () => {
  const pages = collectModelPages({ pricing }, { excludeBatch: false });
  assert.ok(pages.some((p) => p.slug.includes('batch')));
});

test('modelPageSlug sanitizes canonical ids safely', () => {
  assert.equal(modelPageSlug('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(modelPageSlug('glm-5.2-fp8'), 'glm-5.2-fp8');
  assert.equal(modelPageSlug('GLM 5.2/FP8'), 'glm-5.2-fp8');
  assert.throws(() => modelPageSlug(''), /empty/i);
});

test('renderModelPage server-renders the provider table, canonical URL, breadcrumbs, and JSON-LD', () => {
  const page = collectModelPages({ pricing }).find((p) => p.slug === 'deepseek-v4-flash');
  const html = renderModelPage(page, { lastmod: '2026-09-14' });
  // server-rendered provider rows
  assert.match(html, /DeepInfra/);
  assert.match(html, /Hyper/);
  assert.match(html, /Zro/);
  assert.match(html, /<tbody>[\s\S]*<tr>/);
  // canonical URL
  assert.match(html, /<link rel="canonical" href="https:\/\/tokenwatch\.wyrdwerk\.com\/models\/deepseek-v4-flash\/" \/>/);
  // breadcrumbs
  assert.match(html, /class="breadcrumbs"/);
  assert.match(html, /href="\/models\/"/);
  // JSON-LD
  assert.match(html, /id="seo-structured-data"/);
  assert.match(html, /BreadcrumbList/);
  // calculator deep link
  assert.match(html, /href="\/#model=deepseek-v4-flash"/);
  // exactly one title / h1
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.equal((html.match(/<link rel="canonical"/g) || []).length, 1);
});

test('renderModelPage labels provider-offering ranges and does not claim intrinsic model price', () => {
  const page = collectModelPages({ pricing }).find((p) => p.slug === 'deepseek-v4-flash');
  const html = renderModelPage(page, { lastmod: '2026-09-14' });
  assert.match(html, /provider offering/i);
  assert.doesNotMatch(html, /uptime 1d|one-day uptime|UP 1D/i);
  assert.doesNotMatch(html, /cache hit rate/i);
});

test('renderModelPage is byte-idempotent', () => {
  const page = collectModelPages({ pricing }).find((p) => p.slug === 'deepseek-v4-flash');
  const once = renderModelPage(page, { lastmod: '2026-09-14' });
  const twice = renderModelPage(page, { lastmod: '2026-09-14' });
  assert.equal(twice, once);
});

test('renderModelPage keeps quantized canonical ids separate in title and slug', () => {
  const pages = collectModelPages({ pricing });
  const fp8 = renderModelPage(pages.find((p) => p.slug === 'glm-5.2-fp8'), { lastmod: '2026-09-14' });
  const nvfp4 = renderModelPage(pages.find((p) => p.slug === 'glm-5.2-nvfp4'), { lastmod: '2026-09-14' });
  assert.match(fp8, /fp8/i);
  assert.match(nvfp4, /nvfp4/i);
  assert.notEqual(fp8, nvfp4);
});