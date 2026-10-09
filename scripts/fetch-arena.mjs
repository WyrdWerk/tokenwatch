#!/usr/bin/env node
/**
 * Fetch the official Arena text-preference leaderboards from Hugging Face.
 *
 * The Arena-owned dataset is CC-BY-4.0. We retain only the latest Text Arena
 * overall and creative-writing categories, with attribution and publish dates
 * in a committed last-good cache. The dataset is refreshed independently from
 * fetch-pricing; pricing enrichment reads this cache and remains non-fatal.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArenaIndex } from '../shared/benchmarks.mjs';
import { fetchJsonWithRetry, writeJsonAtomic } from './lib.mjs';

const DATASET = 'lmarena-ai/leaderboard-dataset';
const DATASET_URL = `https://huggingface.co/datasets/${DATASET}`;
const ROWS_URL = 'https://datasets-server.huggingface.co/rows';
const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'arena-benchmarks.json');
const CATEGORIES = ['overall', 'creative_writing'];
const PAGE_SIZE = 100;
const PAGE_CONCURRENCY = 8;
const MIN_CATEGORY_ROWS = 20;
const MAX_CATEGORY_ROWS = 5000;
const MAX_DATASET_ROWS = 50000;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parse and validate one page from Hugging Face's dataset-viewer rows API. */
export function parseArenaRowsPage(payload) {
  if (!Number.isInteger(payload?.num_rows_total) || payload.num_rows_total < 0) {
    throw new Error('Arena rows page: missing valid num_rows_total');
  }
  if (!Array.isArray(payload.rows)) throw new Error('Arena rows page: response rows must be an array');
  const rows = payload.rows.map((item, index) => {
    const row = item?.row;
    if (!row || typeof row.category !== 'string' || !row.category.trim()) {
      throw new Error(`Arena rows page: row ${index} has a missing category`);
    }
    if (typeof row.model_name !== 'string' || !row.model_name.trim()) {
      throw new Error(`Arena rows page: row ${index} is missing model_name`);
    }
    if (!finite(row.rating) || !Number.isInteger(row.rank) || row.rank < 1) {
      throw new Error(`Arena rows page: row ${index} has an invalid rating or rank`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.leaderboard_publish_date || '')) {
      throw new Error(`Arena rows page: row ${index} is missing leaderboard_publish_date`);
    }
    return {
      model_name: row.model_name,
      organization: typeof row.organization === 'string' ? row.organization : null,
      license: typeof row.license === 'string' ? row.license : null,
      rating: row.rating,
      rating_lower: finite(row.rating_lower) ? row.rating_lower : null,
      rating_upper: finite(row.rating_upper) ? row.rating_upper : null,
      vote_count: finite(row.vote_count) ? row.vote_count : null,
      rank: row.rank,
      category: row.category,
      leaderboard_publish_date: row.leaderboard_publish_date,
    };
  });
  return { total: payload.num_rows_total, rows };
}

/** Parse a category-specific test/fixture page without accepting cross-category rows. */
export function parseArenaPage(payload, category) {
  if (!CATEGORIES.includes(category)) throw new Error(`Arena ${category}: unsupported category`);
  const page = parseArenaRowsPage(payload);
  for (const [index, row] of page.rows.entries()) {
    if (row.category !== category) throw new Error(`Arena ${category}: row ${index} has an unexpected category`);
  }
  return page;
}

/** Validate a complete snapshot before it can replace the last-good cache. */
export function validateArenaSnapshot(snapshot, { previous = null } = {}) {
  if (!Array.isArray(snapshot?.models)) throw new Error('Arena snapshot models must be an array');
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const seen = new Set();
  for (const [index, row] of snapshot.models.entries()) {
    if (!row || !Object.hasOwn(counts, row.category)) throw new Error(`Arena snapshot row ${index} has an unexpected category`);
    if (typeof row.model_name !== 'string' || !row.model_name.trim() || !finite(row.rating)) {
      throw new Error(`Arena snapshot row ${index} is missing model_name or rating`);
    }
    if (!Number.isInteger(row.rank) || row.rank < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(row.leaderboard_publish_date || '')) {
      throw new Error(`Arena snapshot row ${index} has invalid rank or publish date`);
    }
    const key = `${row.category}|${row.model_name}`;
    if (seen.has(key)) throw new Error(`Arena snapshot contains duplicate ${key}`);
    seen.add(key);
    counts[row.category]++;
  }

  for (const category of CATEGORIES) {
    const count = counts[category];
    if (count < MIN_CATEGORY_ROWS || count > MAX_CATEGORY_ROWS) {
      throw new Error(`Arena ${category}: ${count} rows outside the accepted ${MIN_CATEGORY_ROWS}–${MAX_CATEGORY_ROWS} range`);
    }
    const previousCount = previous?._meta?.categories?.[category]?.count;
    if (Number.isFinite(previousCount) && previousCount > 0 && count < previousCount * 0.8) {
      throw new Error(`Arena ${category}: row count dropped from ${previousCount} to ${count}`);
    }
  }
  return counts;
}

function rowsUrl(offset) {
  const url = new URL(ROWS_URL);
  url.search = new URLSearchParams({
    dataset: DATASET,
    config: 'text_style_control',
    split: 'latest',
    offset: String(offset),
    length: String(PAGE_SIZE),
  });
  return url.toString();
}

async function fetchRowsPage(offset, expectedTotal = null) {
  const page = parseArenaRowsPage(await fetchJsonWithRetry(rowsUrl(offset), 2, 1000));
  if (page.total > MAX_DATASET_ROWS) throw new Error(`Arena dataset: unexpected row count ${page.total}`);
  if (expectedTotal !== null && page.total !== expectedTotal) {
    throw new Error(`Arena dataset: total row count changed while paging`);
  }
  const expectedPageRows = Math.min(PAGE_SIZE, Math.max(0, page.total - offset));
  if (page.rows.length !== expectedPageRows) {
    throw new Error(`Arena dataset: page at offset ${offset} returned ${page.rows.length} of ${expectedPageRows} rows`);
  }
  if (page.rows.length === 0 && offset < page.total) throw new Error(`Arena dataset: empty page at offset ${offset}`);
  return page;
}

async function fetchLatestRows() {
  const first = await fetchRowsPage(0);
  const rows = [...first.rows];
  for (let offset = PAGE_SIZE; offset < first.total; offset += PAGE_SIZE * PAGE_CONCURRENCY) {
    const offsets = Array.from(
      { length: Math.min(PAGE_CONCURRENCY, Math.ceil((first.total - offset) / PAGE_SIZE)) },
      (_, index) => offset + index * PAGE_SIZE,
    );
    const pages = await Promise.all(offsets.map((pageOffset) => fetchRowsPage(pageOffset, first.total)));
    for (const page of pages) rows.push(...page.rows);
  }
  if (rows.length !== first.total) throw new Error(`Arena dataset: fetched ${rows.length} of ${first.total} rows`);
  return rows;
}

async function fetchCategory(category, rows) {
  const selected = rows.filter((row) => row.category === category);
  if (selected.length === 0) throw new Error(`Arena ${category}: no rows in latest dataset split`);
  return selected;
}

async function readCache() {
  try {
    const snapshot = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    validateArenaSnapshot(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

function makeSnapshot(models, fetchedAt) {
  const categories = {};
  for (const category of CATEGORIES) {
    const rows = models.filter((row) => row.category === category);
    categories[category] = {
      count: rows.length,
      leaderboard_publish_date: rows[0]?.leaderboard_publish_date ?? null,
    };
  }
  return {
    _meta: {
      fetched_at: fetchedAt,
      source: 'Arena Leaderboard Dataset (Text Arena, style-controlled)',
      source_url: DATASET_URL,
      data_url: `${ROWS_URL}?dataset=${encodeURIComponent(DATASET)}&config=text_style_control&split=latest`,
      license: 'CC-BY-4.0',
      attribution: 'Arena (LMArena), Leaderboard Dataset; licensed under CC BY 4.0.',
      adaptation: 'Filtered to Text Arena overall and creative_writing; ratings are unchanged, with canonical matching applied downstream.',
      categories,
    },
    models,
  };
}

/** Refresh the last-good snapshot. A fetch or validation failure preserves cache. */
export async function refreshArenaSnapshot({ log = console, now = () => new Date() } = {}) {
  const previous = await readCache();
  try {
    const rows = await fetchLatestRows();
    const models = [];
    for (const category of CATEGORIES) models.push(...await fetchCategory(category, rows));
    const snapshot = makeSnapshot(models, now().toISOString());
    validateArenaSnapshot(snapshot, { previous });
    await writeJsonAtomic(CACHE_PATH, snapshot);
    log.log(`✓ Arena leaderboard snapshot: ${models.length} rows (${DATASET}, ${snapshot._meta.categories.overall.leaderboard_publish_date})`);
    return snapshot;
  } catch (error) {
    log.warn(`⚠ Arena live refresh failed — preserving last-good cache: ${error.message}`);
    return previous;
  }
}

/** Load the committed/fresh cache as a non-fatal benchmark enrichment index. */
export async function fetchArenaBenchmarks(log = console) {
  const snapshot = await readCache();
  if (!snapshot) {
    log.warn('⚠ Arena cache unavailable — continuing without Arena preference scores');
    return null;
  }
  return buildArenaIndex(snapshot.models);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await refreshArenaSnapshot();
