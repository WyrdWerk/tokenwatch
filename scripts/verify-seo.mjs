#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { findHtmlFiles } from './bust-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const SITE = 'https://tokenwatch.wyrdwerk.com';

function requireMatch(value, pattern, message) {
  if (!pattern.test(value)) throw new Error(`verify-seo: ${message}`);
}

function count(value, pattern) {
  return (value.match(pattern) || []).length;
}

function parseStructuredData(html, label) {
  const match = html.match(/<script id="seo-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`verify-seo: ${label} has no generated JSON-LD`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`verify-seo: ${label} has invalid JSON-LD: ${error.message}`);
  }
}

async function assertFile(path, label) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error('empty or not a file');
  } catch (error) {
    throw new Error(`verify-seo: missing ${label}: ${error.message}`);
  }
}

/** Parse Cloudflare Pages `_redirects` rules: `source target [status]`, `#` comments. */
export function parseRedirects(text) {
  return String(text || '').split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [source, target, status = '302', ...extra] = line.split(/\s+/);
      return { source, target, status, extra, line };
    });
}

/** Deployed file a Pages URL path serves, or null (pretty URLs: /x → x.html or x/index.html). */
export function servedFile(root, urlPath) {
  const clean = urlPath.replace(/^\/+|\/+$/g, '');
  const candidates = clean
    ? [join(root, clean, 'index.html'), join(root, `${clean}.html`), join(root, clean)]
    : [join(root, 'index.html')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) || null;
}

/**
 * Redirect rules must be static 301s from paths with no deployed page (so a
 * rule can never shadow a live route) to paths that do serve a page.
 */
export function assertRedirects(text, root) {
  const rules = parseRedirects(text);
  const seen = new Set();
  for (const rule of rules) {
    if (!rule.source?.startsWith('/') || !rule.target?.startsWith('/') || rule.extra.length) {
      throw new Error(`verify-seo: malformed _redirects rule: ${rule.line}`);
    }
    if (/[*:]/.test(rule.source) || /[*:]/.test(rule.target)) throw new Error(`verify-seo: _redirects must stay static (no splats/placeholders): ${rule.line}`);
    if (rule.status !== '301') throw new Error(`verify-seo: _redirects rule must be a 301: ${rule.line}`);
    if (seen.has(rule.source)) throw new Error(`verify-seo: duplicate _redirects source: ${rule.source}`);
    seen.add(rule.source);
    if (servedFile(root, rule.source)) throw new Error(`verify-seo: _redirects source ${rule.source} would shadow a deployed page`);
    if (!servedFile(root, rule.target)) throw new Error(`verify-seo: _redirects target ${rule.target} does not serve a page`);
  }
  return rules;
}

export function assertModelHistory(html, label) {
  // A disabled feature must not leave scripts or an unsupported history claim.
  if (!/data-price-history|model-history\.js|price-sparkline\.js|up to 90 days/.test(html)) return;
  requireMatch(html, /data-price-history="[^"]+"/, `${label} price-history mount point`);
  requireMatch(html, /data-price-history-chart/, `${label} chart container`);
  requireMatch(html, /src="[^"]*model-history\.js/, `${label} does not load model-history.js`);
  requireMatch(html, /src="[^"]*price-sparkline\.js/, `${label} does not load price-sparkline.js`);
  requireMatch(html, /Loading price history/, `${label} initial chart state`);
  requireMatch(html, /up to 90 days/, `${label} must describe history as retained for up to 90 days`);
}

function assertCalculatorPage(html, label, minFaqs) {
  for (const className of ['seo-models', 'seo-faq', 'seo-links']) {
    const marker = `<!-- TW:SEO:${className}:START -->`;
    if (count(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) !== 1) {
      throw new Error(`verify-seo: ${label} must contain exactly one ${className} marker`);
    }
  }
  requireMatch(html, /<section class="seo-models"[\s\S]*?<tbody>[\s\S]*?<tr>/, `${label} has no crawlable pricing rows`);
  // Full FAQ lists live on /faq/ — calculator pages carry a pointer section.
  requireMatch(html, /<section class="seo-faq"[\s\S]*?href="\/faq\//, `${label} FAQ section must link to /faq/`);
}

function assertChoosePage(html) {
  requireMatch(html, /<link rel="canonical" href="https:\/\/tokenwatch\.wyrdwerk\.com\/choose\/" \/>/, 'choose page canonical URL');
  requireMatch(html, /<h1 class="tagline">Which open model should you use, and where\?<\/h1>/, 'choose page heading');
  requireMatch(html, /href="\/choose\/" aria-current="page">Choose<\/a>/, 'choose page active navigation link');
  requireMatch(html, /id="seo-structured-data" type="application\/ld\+json"/, 'choose page structured data');
  requireMatch(html, /src="\/choose-app\.js\?v=dev"/, 'choose page cache-busted source script');
  if (count(html, /name="useCase"/g) !== 9) throw new Error('verify-seo: choose page must expose all nine use cases');
  requireMatch(html, /id="modelCards"[\s\S]*?id="providerRows"/, 'choose page recommendation and provider result containers');
}

// The consolidated FAQ page owns the FAQPage JSON-LD — visible details and
// schema entries must match 1:1 there.
function assertFaqPage(html) {
  const visibleFaqs = count(html, /<details>/g);
  if (visibleFaqs < 20) throw new Error(`verify-seo: faq page has ${visibleFaqs} FAQs; expected at least 20`);
  const data = parseStructuredData(html, 'faq page');
  const faq = data['@graph']?.find((node) => node['@type'] === 'FAQPage');
  if (!faq || faq.mainEntity?.length !== visibleFaqs) {
    throw new Error(`verify-seo: faq page visible FAQ (${visibleFaqs}) and FAQPage JSON-LD (${faq?.mainEntity?.length}) counts differ`);
  }
}

function localFileForUrl(url) {
  const parsed = new URL(url);
  if (parsed.origin !== SITE) throw new Error(`verify-seo: external sitemap URL ${url}`);
  if (parsed.pathname === '/') return join(PUBLIC, 'index.html');
  if (parsed.pathname === '/image') return join(PUBLIC, 'image.html');
  if (parsed.pathname === '/video') return join(PUBLIC, 'video.html');
  if (parsed.pathname === '/benchmarks') return join(PUBLIC, 'benchmarks.html');
  if (!parsed.pathname.endsWith('/')) throw new Error(`verify-seo: generated sitemap path must end in /: ${parsed.pathname}`);
  return join(PUBLIC, parsed.pathname.replace(/^\//, ''), 'index.html');
}

export async function main() {
  const [index, image, video, choosePage, faqPage, sitemap, providerEntries, modelEntries] = await Promise.all([
    readFile(join(PUBLIC, 'index.html'), 'utf8'),
    readFile(join(PUBLIC, 'image.html'), 'utf8'),
    readFile(join(PUBLIC, 'video.html'), 'utf8'),
    readFile(join(PUBLIC, 'choose', 'index.html'), 'utf8'),
    readFile(join(PUBLIC, 'faq', 'index.html'), 'utf8'),
    readFile(join(PUBLIC, 'sitemap.xml'), 'utf8'),
    readdir(join(PUBLIC, 'providers'), { withFileTypes: true }),
    readdir(join(PUBLIC, 'models'), { withFileTypes: true }),
  ]);
  assertFaqPage(faqPage);

  // /benchmarks interactive table is client-rendered — the generated crawlable
  // snapshot must be present or the page is an empty shell to crawlers.
  const benchmarksHtml = await readFile(join(PUBLIC, 'benchmarks.html'), 'utf8');
  requireMatch(benchmarksHtml, /<section class="seo-models"[\s\S]*?crawlable-benchmarks[\s\S]*?<tbody>[\s\S]*?<tr>/, 'benchmarks.html has no crawlable benchmark rows');
  requireMatch(benchmarksHtml, /href="\/faq\//, 'benchmarks.html must link the FAQ');

  assertCalculatorPage(index, 'index.html', 10);
  assertCalculatorPage(image, 'image.html', 6);
  assertCalculatorPage(video, 'video.html', 6);
  assertChoosePage(choosePage);
  requireMatch(image, /flat per-image[\s\S]*per-megapixel[\s\S]*image-token/i, 'image.html does not keep image units in separate groups');
  requireMatch(video, /Price per second[\s\S]*30-second cost/, 'video.html lacks per-second and example-duration columns');

  const providerDirs = providerEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  if (!providerDirs.length) throw new Error('verify-seo: no generated provider pages');
  const modelDirs = modelEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  if (!modelDirs.length) throw new Error('verify-seo: no generated model pages');
  await Promise.all([
    assertFile(join(PUBLIC, 'providers', 'index.html'), 'provider directory'),
    assertFile(join(PUBLIC, 'models', 'index.html'), 'model directory'),
    assertFile(join(PUBLIC, 'docs', 'methodology', 'index.html'), 'methodology page'),
    assertFile(join(PUBLIC, 'docs', 'api', 'index.html'), 'API documentation page'),
    ...providerDirs.map((entry) => assertFile(join(PUBLIC, 'providers', entry.name, 'index.html'), `provider page ${entry.name}`)),
    ...modelDirs.map((entry) => assertFile(join(PUBLIC, 'models', entry.name, 'index.html'), `model page ${entry.name}`)),
  ]);

  // Model pages need a provider table or an explicit unavailable state, plus a
  // canonical URL, breadcrumbs, JSON-LD, calculator link, and coherent optional
  // history wiring. Provider links must use the actual generated page set;
  // coverage thresholds no longer determine the established URL set.
  const providerSlugs = new Set(providerDirs.map((entry) => entry.name));
  const deadProviderLinks = [];
  for (const entry of modelDirs) {
    const html = await readFile(join(PUBLIC, 'models', entry.name, 'index.html'), 'utf8');
    const canonical = `${SITE}/models/${entry.name}/`;
    requireMatch(html, new RegExp(`<link rel="canonical" href="${canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" />`), `model page ${entry.name} canonical URL`);
    requireMatch(html, /class="breadcrumbs"/, `model page ${entry.name} breadcrumbs`);
    requireMatch(html, /id="seo-structured-data"/, `model page ${entry.name} JSON-LD`);
    if (html.includes('data-catalog-unavailable')) {
      requireMatch(html, /No current priced offerings/, `model page ${entry.name} must explain missing coverage`);
      if (/<tbody>\s*<tr>/.test(html)) throw new Error(`verify-seo: unavailable model page ${entry.name} must not advertise pricing rows`);
    } else {
      requireMatch(html, /<section class="seo-models"[\s\S]*?<tbody>[\s\S]*?<tr>/, `model page ${entry.name} provider rows`);
    }
    requireMatch(html, /href="\/#model=/, `model page ${entry.name} calculator deep link`);
    if (entry.name.includes(':batch')) throw new Error(`verify-seo: model page ${entry.name} must not be a :batch variant`);

    assertModelHistory(html, `model page ${entry.name}`);

    for (const match of html.matchAll(/href="\/providers\/([^/"]+)\/"/g)) {
      if (!providerSlugs.has(match[1])) deadProviderLinks.push(`${entry.name} → /providers/${match[1]}/`);
    }
  }
  if (deadProviderLinks.length) {
    throw new Error(`verify-seo: ${deadProviderLinks.length} model-page provider link(s) have no generated page, e.g. ${deadProviderLinks.slice(0, 3).join(', ')}`);
  }

  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  if (urls.length !== new Set(urls).size) throw new Error('verify-seo: sitemap contains duplicate URLs');
  const expectedUrls = providerDirs.length + modelDirs.length + 10;
  if (urls.length !== expectedUrls) throw new Error(`verify-seo: sitemap has ${urls.length} URLs; expected ${expectedUrls}`);
  await Promise.all(urls.map((url) => assertFile(localFileForUrl(url), `sitemap target ${url}`)));

  // Discovery is an HTML-link graph, not merely a valid sitemap. Starting at
  // the homepage must reach every submitted URL without executing JavaScript.
  const linkGraph = new Map();
  const titles = new Set();
  for (const url of urls) {
    const html = await readFile(localFileForUrl(url), 'utf8');
    parseStructuredData(html, url);
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    if (canonical !== url) throw new Error(`verify-seo: canonical mismatch for ${url}`);
    if (/<meta name="robots" content="[^"]*noindex/.test(html)) throw new Error(`verify-seo: sitemap URL is noindex: ${url}`);
    const title = html.match(/<title>(.*?)<\/title>/)?.[1];
    if (!title || titles.has(title)) throw new Error(`verify-seo: missing or duplicate title: ${url}`);
    titles.add(title);
    requireMatch(html, /href="\/models\/">/, `${url} has no model directory link`);
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => {
      const target = new URL(match[1].replaceAll('&amp;', '&'), url);
      target.hash = '';
      target.search = '';
      return target.href;
    });
    linkGraph.set(url, links);
  }
  const reached = new Set();
  const pending = [SITE + '/'];
  while (pending.length) {
    const url = pending.pop();
    if (reached.has(url) || !linkGraph.has(url)) continue;
    reached.add(url);
    pending.push(...linkGraph.get(url));
  }
  const orphaned = urls.filter((url) => !reached.has(url));
  if (orphaned.length) throw new Error(`verify-seo: sitemap URLs unreachable through HTML links: ${orphaned.join(', ')}`);

  const htmlFiles = await findHtmlFiles(PUBLIC);
  const modelSlugs = new Set(modelDirs.map((entry) => entry.name));
  for (const path of htmlFiles) {
    const html = await readFile(path, 'utf8');
    if (html.includes('{{')) throw new Error(`verify-seo: unresolved template placeholder in ${path}`);
    if (count(html, /<title>/g) !== 1) throw new Error(`verify-seo: ${path} must contain one title`);
    const skipCanonical = path.endsWith(join('widget', 'demo.html')) || path.endsWith('404.html');
    if (!skipCanonical && count(html, /<link rel="canonical"/g) !== 1) {
      throw new Error(`verify-seo: ${path} must contain one canonical link`);
    }
    for (const match of html.matchAll(/href="\/(models|providers)\/([^/"]+)\/"/g)) {
      const slugs = match[1] === 'models' ? modelSlugs : providerSlugs;
      if (!slugs.has(match[2])) throw new Error(`verify-seo: ${path} links to absent /${match[1]}/${match[2]}/`);
    }
  }

  // Committed HTML must only reference /h/ assets that exist. bust-cache.mjs
  // rewrites refs to content-hashed /h/* paths at deploy time and those copies
  // are deliberately NOT committed, so a hand-authored or accidentally-busted
  // page that keeps a /h/ ref renders unstyled in a clean checkout. Source HTML
  // must use the plain `?v=` form; only CI-generated deploy output uses /h/.
  const missingHashedAssets = [];
  for (const path of htmlFiles) {
    const html = await readFile(path, 'utf8');
    for (const match of html.matchAll(/(?:href|src)="(\/h\/[^"]+)"/g)) {
      const target = join(PUBLIC, match[1].replace(/^\//, ''));
      if (!existsSync(target)) missingHashedAssets.push(`${relative(PUBLIC, path)} → ${match[1]}`);
    }
  }
  if (missingHashedAssets.length) {
    throw new Error(`verify-seo: ${missingHashedAssets.length} committed HTML ref(s) point at absent /h/ assets (use a plain ?v= source path), e.g. ${missingHashedAssets.slice(0, 3).join(', ')}`);
  }

  const redirectsPath = join(PUBLIC, '_redirects');
  const redirects = existsSync(redirectsPath) ? assertRedirects(await readFile(redirectsPath, 'utf8'), PUBLIC) : [];
  const sitemapPaths = new Set(urls.map((url) => url.replace(SITE, '')));
  for (const rule of redirects) {
    if (sitemapPaths.has(rule.source)) throw new Error(`verify-seo: sitemap lists redirected URL ${rule.source}`);
  }

  console.log(`verify-seo: ${redirects.length} redirect rules checked`);
  console.log(`verify-seo: ${htmlFiles.length} HTML pages, ${providerDirs.length} providers, ${modelDirs.length} models, ${urls.length} sitemap URLs`);
  console.log('verify-seo: calculator pricing, FAQ/JSON-LD parity, optional history, canonical targets, and full HTML-link discovery passed');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
