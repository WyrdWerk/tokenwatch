/**
 * fetch-aa.mjs — Artificial Analysis free-tier benchmark sidecar.
 *
 * Two execution modes:
 *   1. As imported module: fetchAABenchmarks() returns Map<conservativeBase, benchmarks>
 *      - With ARTIFICIAL_ANALYSIS_API_KEY: fetch live + write cache
 *      - Without key: read from cached data/aa-benchmarks.json
 *      - Neither available: return null (non-fatal)
 *
 *   2. Standalone (node scripts/fetch-aa.mjs): fetch-and-cache mode
 *      - Requires ARTIFICIAL_ANALYSIS_API_KEY
 *      - Fetches live, writes cache file, exits
 *
 * Cache file (data/aa-benchmarks.json, committed to git):
 *   {
 *     "_meta": { "fetched_at": "...", "source": "...", "count": 566 },
 *     "models": [ { "slug": "glm-5-2", "intelligence_index": ..., ... }, ... ]
 *   }
 *
 * Index structure: Map<conservativeBase, {intelligence_index, coding_index, agentic_index}>
 *   - Keyed by conservativeBase(canonicalId(slug)) — same as OR benchmark index
 *   - Collision resolution: when 2+ AA models map to same baseKey, prefer the
 *     entry whose slug does NOT contain 'preview' or 'turbo' (the "real" model)
 *   - One score per family, applied to all matching TW rows
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchJsonWithRetry, writeJsonAtomic } from './lib.mjs';
import { canonicalId } from '../shared/normalize.mjs';
import { conservativeBase } from '../shared/benchmarks.mjs';

const AA_FREE_URL_BASE = 'https://artificialanalysis.ai/api/v2/language/models/free';
const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'aa-benchmarks.json');

/**
 * Convert AA slug to dotted canonical ID.
 * AA uses hyphens for dots: glm-5-2 → glm-5.2
 * Pattern: digit-hyphen-digit → digit.dot-digit
 */
function slugToDotted(slug) {
  return slug.replace(/(\d)-(\d)/g, '$1.$2');
}

/**
 * Build the AA enrichment index from a list of AA model records.
 * Each record: { slug, intelligence_index, coding_index, agentic_index }
 *
 * Collision resolution: when 2+ models map to the same conservativeBase with
 * different scores, prefer the entry whose slug does NOT contain 'preview' or
 * 'turbo' (the "real" model, not the variant).
 *
 * Exported for testability (tests pass fixture records directly).
 */
export function buildIndexFromModels(models) {
  const idx = new Map();

  for (const m of models) {
    if (m.intelligence_index == null) continue;

    const dotted = slugToDotted(m.slug);
    const canonical = canonicalId(dotted);
    const base = conservativeBase(canonical);

    const entry = {
      intelligence_index: m.intelligence_index,
      coding_index: m.coding_index ?? null,
      agentic_index: m.agentic_index ?? null,
      _slug: m.slug,
    };

    const existing = idx.get(base);
    if (!existing) {
      idx.set(base, entry);
    } else {
      // Collision: prefer non-preview/non-turbo (the "real" model)
      const existingSlugHasVariant = existing._slug.includes('preview') || existing._slug.includes('turbo');
      const newSlugHasVariant = m.slug.includes('preview') || m.slug.includes('turbo');

      if (!existingSlugHasVariant && newSlugHasVariant) {
        // Existing is the "real" model, keep it
        continue;
      } else if (existingSlugHasVariant && !newSlugHasVariant) {
        // New is the "real" model, replace
        idx.set(base, entry);
      }
      // If both or neither have variant suffixes, keep first-seen (continue)
    }
  }

  // Remove internal _slug field from final index
  for (const [key, val] of idx) {
    if (val._slug !== undefined) {
      const { _slug, ...clean } = val;
      idx.set(key, clean);
    }
  }

  return idx;
}

/**
 * Try to read the cache file. Returns parsed models array or null.
 */
async function readCache() {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.models)) return null;
    return data.models;
  } catch {
    return null;
  }
}

/**
 * Write model records to the cache file.
 */
async function writeCache(models, fetchedAt) {
  const cache = {
    _meta: {
      fetched_at: fetchedAt,
      source: 'artificialanalysis.ai/api/v2/language/models/free',
      count: models.length,
    },
    models,
  };
  await writeJsonAtomic(CACHE_PATH, cache);
}

/**
 * Fetch live from AA free-tier API and write cache.
 * Returns model records or null on failure.
 */
async function fetchLive() {
  const totalPages = 3;
  const headers = { 'x-api-key': process.env.ARTIFICIAL_ANALYSIS_API_KEY };
  const allModels = [];

  const t0 = Date.now();
  for (let page = 1; page <= totalPages; page++) {
    const url = `${AA_FREE_URL_BASE}?page=${page}`;
    const data = await fetchJsonWithRetry(url, 1, 2000, { headers });
    const pageModels = (data.data || []).filter(
      (m) => m && m.evaluations && m.evaluations.artificial_analysis_intelligence_index != null
    );
    for (const m of pageModels) {
      allModels.push({
        slug: m.slug,
        intelligence_index: m.evaluations.artificial_analysis_intelligence_index,
        coding_index: m.evaluations.artificial_analysis_coding_index ?? null,
        agentic_index: m.evaluations.artificial_analysis_agentic_index ?? null,
      });
    }
  }

  const ms = Date.now() - t0;
  console.log(`✓ Artificial Analysis live: ${allModels.length} models with benchmarks (${ms}ms)`);
  await writeCache(allModels, new Date().toISOString());
  console.log(`  Cache written to data/aa-benchmarks.json (${allModels.length} models)`);

  return allModels;
}

/**
 * Build the AA enrichment index.
 *
 * - With ARTIFICIAL_ANALYSIS_API_KEY: fetch live + write cache
 * - Without key: read from cached data/aa-benchmarks.json
 * - Neither available: return null (non-fatal, pipeline continues)
 *
 * @param {object} [log] — unused, kept for API parity with other fetchers
 * @returns {Map<string, {intelligence_index, coding_index, agentic_index}> | null}
 */
export async function fetchAABenchmarks(log) {
  const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  let models;

  if (key) {
    try {
      models = await fetchLive();
    } catch (err) {
      console.warn(`⚠ AA live fetch failed — falling back to cache: ${err.message}`);
      models = await readCache();
    }
  } else {
    models = await readCache();
  }

  if (!models || models.length === 0) {
    if (!key) {
      console.warn('⚠ ARTIFICIAL_ANALYSIS_API_KEY not set and no cache file — skipping AA enrichment');
    } else {
      console.warn('⚠ AA: no benchmark data available (no cache, live fetch empty)');
    }
    return null;
  }

  return buildIndexFromModels(models);
}

// Allow `node scripts/fetch-aa.mjs` to run standalone (CI prefetch step).
// Writes data/aa-benchmarks.json atomically.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  if (!process.env.ARTIFICIAL_ANALYSIS_API_KEY) {
    console.error('Error: ARTIFICIAL_ANALYSIS_API_KEY must be set to run standalone.');
    process.exit(1);
  }
  const result = await fetchAABenchmarks();
  if (result) {
    console.log(`✓ Cache ready: ${result.size} entries (after collision resolution)`);
  } else {
    console.error('✗ Failed to build AA index');
    process.exit(1);
  }
}
