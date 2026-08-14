#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
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
  const [index, image, video, faqPage, sitemap, providerEntries] = await Promise.all([
    readFile(join(PUBLIC, 'index.html'), 'utf8'),
    readFile(join(PUBLIC, 'image.html'), 'utf8'),
    readFile(join(PUBLIC, 'video.html'), 'utf8'),
    readFile(join(PUBLIC, 'faq', 'index.html'), 'utf8'),
    readFile(join(PUBLIC, 'sitemap.xml'), 'utf8'),
    readdir(join(PUBLIC, 'providers'), { withFileTypes: true }),
  ]);
  assertFaqPage(faqPage);

  assertCalculatorPage(index, 'index.html', 10);
  assertCalculatorPage(image, 'image.html', 6);
  assertCalculatorPage(video, 'video.html', 6);
  requireMatch(image, /flat per-image[\s\S]*per-megapixel[\s\S]*image-token/i, 'image.html does not keep image units in separate groups');
  requireMatch(video, /Price per second[\s\S]*30-second cost/, 'video.html lacks per-second and example-duration columns');

  const providerDirs = providerEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  if (!providerDirs.length) throw new Error('verify-seo: no generated provider pages');
  await Promise.all([
    assertFile(join(PUBLIC, 'providers', 'index.html'), 'provider directory'),
    assertFile(join(PUBLIC, 'docs', 'methodology', 'index.html'), 'methodology page'),
    assertFile(join(PUBLIC, 'docs', 'api', 'index.html'), 'API documentation page'),
    ...providerDirs.map((entry) => assertFile(join(PUBLIC, 'providers', entry.name, 'index.html'), `provider page ${entry.name}`)),
  ]);

  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  if (urls.length !== new Set(urls).size) throw new Error('verify-seo: sitemap contains duplicate URLs');
  const expectedUrls = providerDirs.length + 8;
  if (urls.length !== expectedUrls) throw new Error(`verify-seo: sitemap has ${urls.length} URLs; expected ${expectedUrls}`);
  await Promise.all(urls.map((url) => assertFile(localFileForUrl(url), `sitemap target ${url}`)));

  const htmlFiles = await findHtmlFiles(PUBLIC);
  for (const path of htmlFiles) {
    const html = await readFile(path, 'utf8');
    if (html.includes('{{')) throw new Error(`verify-seo: unresolved template placeholder in ${path}`);
    if (count(html, /<title>/g) !== 1) throw new Error(`verify-seo: ${path} must contain one title`);
    if (!path.endsWith(join('widget', 'demo.html')) && count(html, /<link rel="canonical"/g) !== 1) {
      throw new Error(`verify-seo: ${path} must contain one canonical link`);
    }
  }

  console.log(`verify-seo: ${htmlFiles.length} HTML pages, ${providerDirs.length} providers, ${urls.length} sitemap URLs`);
  console.log('verify-seo: calculator pricing, visible FAQ/JSON-LD parity, metadata, and sitemap targets passed');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
