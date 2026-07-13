#!/usr/bin/env node
/**
 * Sidecar script — fetches per-endpoint latency and throughput data:
 *
 *   - Primary source: OpenRouter `/endpoints` API (requires OPENROUTER_API_KEY)
 *     → ~1000+ records with full latency + throughput percentiles
 *   - Supplementary: Crof, Lilac, Umans (direct providers, no key needed)
 *     → Crof: speed (tokens/sec) from `/v1/models` API
 *     → Lilac/Umans: latency + throughput from their status APIs
 *
 * Writes a compact lookup table to public/performance.json, keyed by the same
 * dedup key the main pipeline uses: canonicalId|normalizedProvider
 *
 * Graceful degradation WITHOUT an OPENROUTER_API_KEY:
 *   - OR portion is skipped (no data loss — OR records are preserved)
 *   - Crof/Lilac/Umans are still fetched
 *   - 85% threshold guard prevents overwriting OR-heavy data with direct-only
 *
 * Usage:
 *   node scripts/fetch-performance.mjs [--dry-run]
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import {
  canonicalId,
  normalizeProvider,
  fetchJson,
  fetchJsonWithRetry,
    parseArgs,
} from './lib.mjs';

const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OR_ENDPOINT_BASE = 'https://openrouter.ai/api/v1/models';
const CONCURRENCY = 15;
const OUTPUT_PATH = 'public/performance.json';

const USAGE = `Usage: node scripts/fetch-performance.mjs [--dry-run]
  Requires OPENROUTER_API_KEY env var for live latency/throughput data.
  --dry-run  Fetch and process but don't write performance.json`;

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a dedup key matching the pipeline's dedupKey() — canonicalId|normalizedProvider. */
function perfKey(modelId, providerName) {
  return `${canonicalId(modelId)}|${normalizeProvider(providerName)}`;
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const { dryRun, help } = parseArgs(USAGE);
  if (help) return;

  const apiKey = process.env.OPENROUTER_API_KEY;
  const hasKey = !!apiKey;

  if (!hasKey) {
    console.warn('⚠ OPENROUTER_API_KEY not set — skipping OpenRouter portion (direct providers will still be fetched)');
  }

  // ── Step 1: Read our catalog to know which models we track ──
  let catalogCanonicalIds;
  try {
    const pricing = JSON.parse(await readFile('public/pricing.json', 'utf-8'));
    catalogCanonicalIds = new Set(pricing.models.map(m => canonicalId(m.id)));
    console.log(`  Catalog: ${pricing.models.length} models, ${catalogCanonicalIds.size} unique canonical IDs`);
  } catch (err) {
    console.error('✗ Failed to read pricing.json — run fetch-pricing first');
    process.exit(1);
  }

  // ── Step 2: Fetch OR model listing to get canonical_slugs ──
  // Only if we have an API key. Without a key we skip the OR portion
  // entirely and build performance data from direct providers only.
  const perfData = {};
  let epCount = 0;
  const modelSlugs = new Map();
  let failed = 0;
  const t0 = Date.now();

  if (hasKey) {
    const listData = await fetchJsonWithRetry(OR_MODELS_URL, 1, 2000, { apiKey });
    const allORModels = (listData.data || []).filter(m => !m.id.endsWith(':free'));

    for (const m of allORModels) {
      const cid = canonicalId(m.id);
      if (catalogCanonicalIds.has(cid) && m.canonical_slug) {
        if (!modelSlugs.has(cid)) modelSlugs.set(cid, m.canonical_slug);
      }
    }
    console.log(`  OR models: ${allORModels.length} total → ${modelSlugs.size} match our catalog`);

    // ── Step 3: Fetch endpoints for each matched model ──
    const slugs = [...modelSlugs.values()];
    const results = [];
    failed = 0;  // reset for endpoint batch (reuses outer `let failed` from line 77)

    for (let i = 0; i < slugs.length; i += CONCURRENCY) {
      const batch = slugs.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (slug) => {
          const url = `${OR_ENDPOINT_BASE}/${slug}/endpoints`;
          return fetchJsonWithRetry(url, 1, 2000, { apiKey });
        })
      );
      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          failed++;
          if (failed <= 5) console.error(`    ✗ ${batch[j]}: ${r.reason?.message || r.reason}`);
        }
      }
      if (i % (CONCURRENCY * 4) === 0 && i > 0) {
        console.log(`    ... ${Math.min(i + CONCURRENCY, slugs.length)}/${slugs.length} models fetched`);
      }
    }

    // Abort on high failure rate
    const failureRate = slugs.length > 0 ? failed / slugs.length : 0;
    if (failureRate > 0.20) {
      throw new Error(
        `Performance fetch failure rate ${(failureRate * 100).toFixed(1)}% ` +
        `(${failed}/${slugs.length}) exceeds 20% threshold — aborting`
      );
    }

    // ── Step 4: Build performance lookup table from OR results ──
    for (const data of results) {
      const eps = data.data?.endpoints || [];
      const modelId = eps[0]?.model_id;
      if (!modelId) continue;

      for (const ep of eps) {
        const lat = ep.latency_last_30m;
        const tput = ep.throughput_last_30m;
        if (!lat && !tput) continue;

        const key = perfKey(modelId, ep.provider_name);
        perfData[key] = {
          latency: lat ? { p50: lat.p50, p75: lat.p75, p90: lat.p90, p99: lat.p99 } : null,
          throughput: tput ? { p50: tput.p50, p75: tput.p75, p90: tput.p90, p99: tput.p99 } : null,
        };
        epCount++;
      }
    }
  }

  // ── Lilac (direct provider) performance data ───────────────────────────────
  // Lilac isn't routed through OpenRouter, so fetch from their own status API.
  console.log('  Fetching Lilac performance data...');
  try {
    const lilacRes = await fetchJson('https://api.getlilac.com/status?window=1h');
    const lilacModels = lilacRes.models || [];
    let lilacCount = 0;
    for (const lm of lilacModels) {
      if (!lm.id || (!lm.tps && !lm.ttfb_seconds)) continue;
      const key = perfKey(lm.id, 'Lilac');
      // Lilac API gives scalar tps and ttfb_seconds — wrap as p50 for shape consistency
      const tps = typeof lm.tps === 'number' ? lm.tps : null;
      const ttfbMs = typeof lm.ttfb_seconds === 'number' ? Math.round(lm.ttfb_seconds * 1000) : null;
      perfData[key] = {
        latency: ttfbMs !== null ? { p50: ttfbMs, p75: null, p90: null, p99: null } : null,
        throughput: tps !== null ? { p50: tps, p75: null, p90: null, p99: null } : null,
      };
      lilacCount++;
    }
    console.log(`    Lilac: ${lilacCount} models indexed`);
  } catch (err) {
    console.warn(`    ⚠ Lilac status fetch failed: ${err.message} — continuing without Lilac perf data`);
  }

  // ── Umans AI (direct provider) performance data ────────────────────────────
  // Proxied through our own Cloudflare Pages Function to keep the API key off-box.
  const UMANS_STATUS_URL = process.env.UMANS_STATUS_URL || 'https://tokenwatch.wyrdwerk.com/api/umans-status';
  console.log('  Fetching Umans AI performance data...');
  try {
    const umansRes = await fetchJson(UMANS_STATUS_URL);
    // Umans status API returns { models: { "umans-glm-5.2": { latency: { ttft_ms: { p50 } }, output_tokens_per_second: { p50 } } } }
    const umansModels = umansRes.models || {};
    let umansCount = 0;
    for (const [modelId, metrics] of Object.entries(umansModels)) {
      if (!metrics) continue;
      const ttft = metrics.latency?.ttft_ms?.p50;
      const tps = metrics.output_tokens_per_second?.p50;
      if (!ttft && !tps) continue;
      const key = perfKey(modelId, 'Umans AI');
      perfData[key] = {
        latency: ttft != null ? { p50: ttft, p75: null, p90: null, p99: null } : null,
        throughput: tps != null ? { p50: tps, p75: null, p90: null, p99: null } : null,
      };
      umansCount++;
    }
    console.log(`    Umans AI: ${umansCount} models indexed`);
  } catch (err) {
    console.warn(`    ⚠ Umans status fetch failed: ${err.message} — continuing without Umans perf data`);
  }

  // ── Crof (direct provider) performance data ────────────────────────────────
  // Crof exposes speed (tokens/sec) on their public /v1/models API — the same
  // endpoint fetch-pricing.mjs already uses for pricing. No auth required.
  // Speed is a scalar (tokens/second), wrapped as p50 for shape consistency
  // with the OR endpoint data lat/tput percentiles.
  const CROF_MODELS_URL = 'https://crof.ai/v1/models';
  console.log('  Fetching Crof performance data...');
  try {
    const crofData = await fetchJson(CROF_MODELS_URL);
    const crofModels = crofData.data || [];
    let crofCount = 0;
    for (const m of crofModels) {
      if (!m.id || typeof m.speed !== 'number') continue;
      const key = perfKey(m.id, 'Crof');
      perfData[key] = {
        latency: null,
        throughput: { p50: m.speed, p75: null, p90: null, p99: null },
      };
      crofCount++;
    }
    console.log(`    Crof: ${crofCount} models indexed`);
  } catch (err) {
    console.warn(`    ⚠ Crof models fetch failed: ${err.message} — continuing without Crof perf data`);
  }

  const ms = Date.now() - t0;
  const total = Object.keys(perfData).length;
  console.log(`  Performance data: ${total} total records (${epCount} endpoints) in ${ms}ms (${failed} model fetches failed)`);

  // ── Dry run ──
  if (dryRun) {
    console.log('\n── Summary ──');
    console.log(`  Models matched: ${modelSlugs.size}/${catalogCanonicalIds.size}`);
    console.log(`  Total performance records: ${Object.keys(perfData).length}`);
    console.log(`  Failed fetches: ${failed}`);
    console.log(`\n→ Dry run — performance.json not written`);
    return;
  }

  // ── Guard: don't overwrite with degraded data ──
  // If we fetched from OR and got zero catalog matches (API outage,
  // key revoked), perfData only has direct-provider records
  // (Lilac/Umans/Crof). Never overwrite 700+ OR records with ~9
  // direct-only records — preserve last-good.
  // Only relevant when we actually attempted the OR fetch.
  if (hasKey && catalogCanonicalIds.size > 0 && modelSlugs.size === 0) {
    console.log('\n→ OpenRouter returned zero catalog matches — preserving existing performance.json');
    return;
  }
  // If no records at all were collected (all sources empty), preserve existing.
  if (Object.keys(perfData).length === 0) {
    console.log('\n→ No performance records fetched — preserving existing performance.json');
    return;
  }
  // If new record count dropped >15% vs existing, preserve last-good.
  // Catches truncated /models responses that pass the 20% endpoint-failure check
  // but yield far fewer matches than the prior run. Same 15% threshold as fetch-pricing.mjs.
  try {
    const existing = JSON.parse(await readFile(OUTPUT_PATH, 'utf-8'));
    const { _meta: _m, ...existingData } = existing;
    const existingCount = Object.keys(existingData).length;
    const newCount = Object.keys(perfData).length;
    if (existingCount > 0 && newCount < existingCount * 0.85) {
      console.log(`\n→ Performance record count dropped ${Math.round((1 - newCount / existingCount) * 100)}% (${newCount} vs ${existingCount}) — preserving existing performance.json`);
      return;
    }
  } catch {
    // No existing file — first run, allow write
  }

  // ── Write (only if data changed) ──
  // Compare against existing file to avoid unconditional churn — the CI
  // commit step skips when git diff is quiet, so identical data = no commit,
  // no bust-cache, no deploy. Keys are sorted before comparison so insertion
  // order changes from the API don't create false diffs.
  const canonicalData = obj => Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));

  const newDataStr = JSON.stringify(canonicalData(perfData)); // perfData has no _meta yet
  let existingDataStr = null;
  let hasMeta = false;
  try {
    const existingParsed = JSON.parse(await readFile(OUTPUT_PATH, 'utf-8'));
    hasMeta = !!existingParsed._meta;
    const { _meta: _existingMeta, ...existingData } = existingParsed;
    existingDataStr = JSON.stringify(canonicalData(existingData));
  } catch {
    // File doesn't exist or is invalid — treat as new data
  }

  // Skip write only when data is unchanged AND the file already has _meta.
  // A bare legacy file (no _meta) gets migrated even if data matches.
  if (existingDataStr === newDataStr && hasMeta) {
    console.log(`\n→ No performance data changes — skipping write (${Object.keys(perfData).length} records unchanged)`);
    console.log(`  (CI commit step will detect no diff and skip deploy)`);
    return;
  }

  perfData._meta = { generated_at: new Date().toISOString() };
  await mkdir('public', { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(perfData));
  const recordCount = Object.keys(perfData).length - 1; // exclude _meta
  console.log(`\n→ Wrote ${OUTPUT_PATH} (${recordCount} records, updated ${perfData._meta.generated_at})`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
