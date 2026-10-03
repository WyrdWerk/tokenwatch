#!/usr/bin/env node
/**
 * Build-time SEO generation.
 *
 * Reads the committed text, image, and video catalogs; enriches the three
 * calculator pages with crawlable pricing and FAQs; generates provider and
 * documentation pages; then writes sitemap.xml and robots.txt.
 */

import { renderHero } from './hero.mjs';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  TOP_N,
  cheapestModels,
  cheapestImageModels,
  cheapestVideoModels,
  renderSeoTable,
  renderImageSeoSection,
  renderVideoSeoSection,
  homeFaqItems,
  imageFaqItems,
  videoFaqItems,
  renderFaqSection,
  renderFaqPointerSection,
  renderBenchmarksSeoSection,
  buildLlmsTxt,
  calculatorStructuredData,
  replaceStructuredData,
  replaceSection,
  renderModalityMeta,
  renderHomepageMeta,
  renderCounts,
  collectProviderPages,
  renderProviderPage,
  renderProviderDirectoryPage,
  collectModelPages,
  renderModelPage,
  renderModelDirectoryPage,
  providerPageSlugs,
  renderMethodologyPage,
  renderRulesStrip,
  renderApiDocsPage,
  buildOpenApiDocument,
  renderFaqPage,
  renderExploreLinks,
  buildSitemap,
  buildRobots,
} from './seo-pages.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

async function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`generate-seo: cannot read ${label}: ${error.message}`);
  }
  if (!Array.isArray(parsed.models) || !parsed.generated_at) {
    throw new Error(`generate-seo: ${label} must contain generated_at and models[]`);
  }
  return parsed;
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, path);
}

function dateOnly(value, label) {
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`generate-seo: invalid ${label} generated_at: ${value}`);
  return date;
}

async function stageProviderPages(providers, dates, links) {
  const target = join(PUBLIC, 'providers');
  const stage = join(PUBLIC, `.providers-${process.pid}.tmp`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, 'index.html'), renderProviderDirectoryPage(providers));
  for (const provider of providers) {
    const dir = join(stage, provider.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderProviderPage(provider, dates, links));
  }

  const backup = join(PUBLIC, `.providers-${process.pid}.bak`);
  await rm(backup, { recursive: true, force: true });
  let movedOld = false;
  try {
    await rename(target, backup);
    movedOld = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(stage, target);
  } catch (error) {
    if (movedOld) await rename(backup, target);
    throw error;
  }
  if (movedOld) await rm(backup, { recursive: true, force: true });
}

/** Atomic staging for the /models/<slug>/ tree — never leaves a partial tree. */
async function stageModelPages(pages, dates, linkedProviderSlugs) {
  const target = join(PUBLIC, 'models');
  const stage = join(PUBLIC, `.models-${process.pid}.tmp`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, 'index.html'), renderModelDirectoryPage(pages));
  for (const page of pages) {
    const dir = join(stage, page.slug);
    await mkdir(dir, { recursive: true });
    // Only providers with a generated page are linked; the rest render as plain
    // text so a model page can never emit a 404 link.
    await writeFile(join(dir, 'index.html'), renderModelPage(page, { lastmod: dates.text, linkedProviderSlugs }));
  }

  const backup = join(PUBLIC, `.models-${process.pid}.bak`);
  await rm(backup, { recursive: true, force: true });
  let movedOld = false;
  try {
    await rename(target, backup);
    movedOld = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(stage, target);
  } catch (error) {
    if (movedOld) await rename(backup, target);
    throw error;
  }
  if (movedOld) await rm(backup, { recursive: true, force: true });
}

function renderHomepage(markup, pricing, rows, dates, links) {
  const modelCount = pricing.models.length;
  const providerCount = new Set(pricing.models.map((model) => model.provider)).size;
  const faq = homeFaqItems(modelCount, providerCount);
  let out = renderCounts(markup, modelCount, providerCount);
  out = renderHomepageMeta(out, modelCount, providerCount);
  out = replaceSection(out, 'tw-hero', renderHero(pricing));
  out = replaceSection(out, 'tw-rules', renderRulesStrip());
  out = replaceSection(out, 'seo-models', renderSeoTable(rows, dates.text, links));
  out = replaceSection(out, 'seo-faq', renderFaqPointerSection());
  out = replaceSection(out, 'seo-links', renderExploreLinks());
  out = replaceStructuredData(out, calculatorStructuredData({
    page: 'text',
    title: `LLM API Pricing Comparison — ${providerCount} Providers`,
    description: `Compare pay-as-you-go LLM API pricing across ${providerCount} providers and ${modelCount} text-model offerings using workload-specific token costs.`,
    rows,
  }));
  return out;
}

function renderImagePage(markup, imagePricing, dates) {
  const groups = Object.fromEntries(['image', 'megapixel', 'token'].map((unit) => [unit, cheapestImageModels(imagePricing.models, unit, 15)]));
  const faq = imageFaqItems();
  const itemRows = [...groups.image, ...groups.megapixel, ...groups.token];
  let out = renderModalityMeta(markup, 'image', imagePricing.models.length);
  out = replaceSection(out, 'seo-models', renderImageSeoSection(groups, dates.image));
  out = replaceSection(out, 'seo-faq', renderFaqPointerSection());
  out = replaceSection(out, 'seo-links', renderExploreLinks());
  out = replaceStructuredData(out, calculatorStructuredData({
    page: 'image',
    title: `Image Generation API Pricing — ${imagePricing.models.length} Models`,
    description: 'Compare image API prices while keeping flat-image, megapixel, and image-token billing units separate.',
    rows: itemRows,
  }));
  return out;
}

function renderVideoPage(markup, videoPricing, rows, dates) {
  const faq = videoFaqItems();
  let out = renderModalityMeta(markup, 'video', videoPricing.models.length);
  out = replaceSection(out, 'seo-models', renderVideoSeoSection(rows, dates.video));
  out = replaceSection(out, 'seo-faq', renderFaqPointerSection());
  out = replaceSection(out, 'seo-links', renderExploreLinks());
  out = replaceStructuredData(out, calculatorStructuredData({
    page: 'video',
    title: `Video Generation API Pricing — ${videoPricing.models.length} Models`,
    description: 'Compare video API prices by per-second rate, resolution, audio mode, and total duration.',
    rows,
  }));
  return out;
}

export async function main() {
  const [pricing, imagePricing, videoPricing, indexMarkup, imageMarkup, videoMarkup] = await Promise.all([
    readJson(join(PUBLIC, 'pricing.json'), 'pricing.json'),
    readJson(join(PUBLIC, 'image-pricing.json'), 'image-pricing.json'),
    readJson(join(PUBLIC, 'video-pricing.json'), 'video-pricing.json'),
    readFile(join(PUBLIC, 'index.html'), 'utf8'),
    readFile(join(PUBLIC, 'image.html'), 'utf8'),
    readFile(join(PUBLIC, 'video.html'), 'utf8'),
  ]);

  const dates = {
    text: dateOnly(pricing.generated_at, 'pricing.json'),
    image: dateOnly(imagePricing.generated_at, 'image-pricing.json'),
    video: dateOnly(videoPricing.generated_at, 'video-pricing.json'),
  };
  const textRows = cheapestModels(pricing.models, TOP_N);
  const videoRows = cheapestVideoModels(videoPricing.models, TOP_N);
  // Freeze established URLs during the discovery-fix phase. Coverage changes
  // update a page's content, not its existence; new landing pages need approval.
  const published = JSON.parse(await readFile(join(__dirname, '..', 'data', 'seo-published-pages.json'), 'utf8'));
  const providerPages = collectProviderPages({ pricing, imagePricing, videoPricing, publishedProviders: new Set(published.providers) });
  if (!providerPages.length) throw new Error('generate-seo: provider eligibility produced zero pages');
  const modelPages = collectModelPages({ pricing }, { publishedModels: new Set(published.models) });
  if (!modelPages.length) throw new Error('generate-seo: model eligibility produced zero pages');
  const links = {
    linkedModelPages: new Map(modelPages.map((page) => [page.canonical, page.slug])),
    linkedProviderSlugs: providerPageSlugs(providerPages),
  };

  const rendered = {
    index: renderHomepage(indexMarkup, pricing, textRows, dates, links),
    image: renderImagePage(imageMarkup, imagePricing, dates),
    video: renderVideoPage(videoMarkup, videoPricing, videoRows, dates),
  };
  if (!rendered.index.includes('class="seo-models"') || !rendered.image.includes('class="seo-models"') || !rendered.video.includes('class="seo-models"')) {
    throw new Error('generate-seo: a calculator page is missing crawlable pricing content');
  }

  const modelCount = pricing.models.length;
  const providerCount = new Set(pricing.models.map((model) => model.provider)).size;
  const methodology = renderMethodologyPage({ modelCount, providerCount, generatedAt: pricing.generated_at, models: pricing.models, linkedModelPages: links.linkedModelPages });
  const apiDocs = renderApiDocsPage();
  const openApi = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
  const faqPage = renderFaqPage({ modelCount, providerCount });

  // /benchmarks crawlable snapshot — page is committed with marker sections;
  // regenerate from benchmarks.json like the calculator pages.
  const benchData = JSON.parse(await readFile(join(PUBLIC, 'benchmarks.json'), 'utf8'));
  const benchmarksMarkup = await readFile(join(PUBLIC, 'benchmarks.html'), 'utf8');
  let benchmarksOut = replaceSection(benchmarksMarkup, 'seo-models', renderBenchmarksSeoSection(benchData, links.linkedModelPages));
  benchmarksOut = replaceSection(benchmarksOut, 'seo-faq', renderFaqPointerSection());
  benchmarksOut = replaceStructuredData(benchmarksOut, calculatorStructuredData({
    page: 'benchmarks',
    title: 'LLM benchmarks by use case',
    description: 'Practical LLM benchmarks joined to pay-as-you-go pricing. Compare models on agentic coding, reasoning, knowledge work and UI quality — with blended cost per million tokens from the cheapest provider.',
  }));
  if (!benchmarksOut.includes('id="crawlable-benchmarks"') || !benchmarksOut.includes('href="/faq/')) {
    throw new Error('generate-seo: benchmarks page missing crawlable content or FAQ pointer');
  }
  // generated_at records a fetch, not a meaningful page-content change. Omit
  // optional lastmod until actual change times are tracked; do not invent them.
  const sitemapEntries = [
    { path: '/', changefreq: 'daily', priority: '1.0' },
    { path: '/image', changefreq: 'daily', priority: '0.8' },
    { path: '/video', changefreq: 'daily', priority: '0.8' },
    { path: '/providers/', changefreq: 'daily', priority: '0.8' },
    ...providerPages.map((provider) => ({ path: `/providers/${provider.slug}/`, changefreq: 'daily', priority: '0.7' })),
    { path: '/models/', changefreq: 'daily', priority: '0.7' },
    ...modelPages.map((page) => ({ path: `/models/${page.slug}/`, changefreq: 'daily', priority: '0.6' })),
    { path: '/benchmarks', changefreq: 'daily', priority: '0.8' },
    { path: '/docs/methodology/', changefreq: 'monthly', priority: '0.6' },
    { path: '/docs/api/', changefreq: 'monthly', priority: '0.6' },
    { path: '/faq/', changefreq: 'weekly', priority: '0.6' },
  ];
  const sitemap = buildSitemap(sitemapEntries);
  const robots = buildRobots();

  await stageProviderPages(providerPages, dates, links);
  await stageModelPages(modelPages, dates, links.linkedProviderSlugs);
  await Promise.all([
    writeAtomic(join(PUBLIC, 'index.html'), rendered.index),
    writeAtomic(join(PUBLIC, 'image.html'), rendered.image),
    writeAtomic(join(PUBLIC, 'video.html'), rendered.video),
    writeAtomic(join(PUBLIC, 'docs', 'methodology', 'index.html'), methodology),
    writeAtomic(join(PUBLIC, 'docs', 'api', 'index.html'), apiDocs),
    writeAtomic(join(PUBLIC, 'openapi.json'), openApi),
    writeAtomic(join(PUBLIC, 'faq', 'index.html'), faqPage),
    writeAtomic(join(PUBLIC, 'benchmarks.html'), benchmarksOut),
    writeAtomic(join(PUBLIC, 'llms.txt'), buildLlmsTxt({
      modelCount, providerCount,
      imageCount: imagePricing.models.length,
      videoCount: videoPricing.models.length,
      generatedAt: pricing.generated_at,
    })),
    writeAtomic(join(PUBLIC, 'sitemap.xml'), sitemap),
    writeAtomic(join(PUBLIC, 'robots.txt'), robots),
  ]);

  console.log(`generate-seo: rendered ${textRows.length} text, ${videoRows.length} video, and modality-safe image price rows`);
  console.log(`generate-seo: generated ${providerPages.length} provider pages plus methodology and API documentation`);
  console.log(`generate-seo: generated ${modelPages.length} canonical-model pages plus the /models/ directory`);
  console.log(`generate-seo: wrote ${sitemapEntries.length} sitemap URLs and refreshed all calculator SEO sections`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('generate-seo failed:', error);
    process.exit(1);
  });
}
