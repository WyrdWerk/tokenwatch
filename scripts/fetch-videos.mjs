#!/usr/bin/env node
/**
 * fetch-videos.mjs
 *
 * Fetches video generation models from OpenRouter's /api/v1/videos/models,
 * normalizes per-second pricing (dollars + cents→dollars),
 * and writes public/video-pricing.json.
 *
 * Model record:
 * {
 *   id:          "google/veo-3.1-fast"
 *   name:        "Google: Veo 3.1 Fast"
 *   org:         "google"            (model creator)
 *   provider:    "google"            (same as org — no de-aggregation)
 *   supported_durations: [4, 6, 8]
 *   pricing: [
 *     { resolution: "720p"|"1080p"|"4k", audio: true|false,
 *       cost_per_second: number }
 *   ]
 * }
 */

import { writeFile, mkdir } from 'node:fs/promises';
import {
  orgFromId, orgFromName, canonicalId, orgLookupKey, ORG_ALIASES,
  num, fetchJsonWithRetry, checkCoverageDrop, CoverageDropError, parseArgs, dedupModels,
} from './lib.mjs';
import { fetchFalVideoModels } from './fetch-fal.mjs';

const VIDEOS_MODELS_URL = 'https://openrouter.ai/api/v1/videos/models';
const OUTPUT_PATH = 'public/video-pricing.json';

const USAGE = `Usage: node scripts/fetch-videos.mjs [--dry-run]
  --dry-run  Fetch and process but don't write video-pricing.json`;

// ── pricing SKU parsing ───────────────────────────────────────────────────────

/**
 * Parse pricing_skus into normalized pricing entries.
 * Handles both dollar-denominated keys ("duration_seconds_720p": "0.0988")
 * and cent-denominated keys ("cents_per_video_output_second_720p": "5").
 */
function parseVideoPricing(skus) {
  if (!skus || typeof skus !== 'object') return [];

  const entries = [];

  for (const [key, rawValue] of Object.entries(skus)) {
    let value = num(rawValue);
    if (value === null || value <= 0) continue;
    // Skip non-per-second keys (e.g. "video_tokens" is per-token, not per-second)
    if (!/second/i.test(key)) continue;


    // Detect cent-denominated keys → convert to dollars
    const isCents = key.startsWith('cents_');
    if (isCents) value = value / 100;

    // Extract resolution from key
    let resolution = null;
    const resMatch = key.match(/(\d+p|4k|1024p)/i);
    if (resMatch) {
      resolution = resMatch[1].toLowerCase();
      if (resolution === '1024p') resolution = '1080p'; // normalize
    }

    // Detect audio
    const hasAudio = key.includes('with_audio') || key.includes('with_audio_');
    const noAudio = key.includes('without_audio') || key.includes('without_audio_');

    // Some keys don't specify audio (e.g. "duration_seconds", "duration_seconds_720p")
    // For those, create both audio variants if applicable, else one entry
    if (!hasAudio && !noAudio && !isCents) {
      // Generic key — could be with or without audio, use as-is
      entries.push({ resolution, audio: null, cost_per_second: value });
    } else if (hasAudio) {
      entries.push({ resolution, audio: true, cost_per_second: value });
    } else if (noAudio) {
      entries.push({ resolution, audio: false, cost_per_second: value });
    } else if (isCents) {
      // Cent-denominated keys like "cents_per_video_output_second_480p"
      entries.push({ resolution, audio: null, cost_per_second: value });
    }
  }

  // Deduplicate by (resolution, audio)
  const seen = new Set();
  return entries.filter(e => {
    const k = `${e.resolution || 'any'}|${e.audio}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => {
    // Sort by resolution priority then audio
    const resOrder = { '480p': 0, '720p': 1, '1080p': 2, '4k': 3 };
    const ra = resOrder[a.resolution] ?? 99;
    const rb = resOrder[b.resolution] ?? 99;
    if (ra !== rb) return ra - rb;
    if (a.audio !== b.audio) return a.audio === true ? 1 : -1;
    return a.cost_per_second - b.cost_per_second;
  });
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const { dryRun, help } = parseArgs(USAGE);
  if (help) return;

  console.log('Fetching video generation models...');

  const data = await fetchJsonWithRetry(VIDEOS_MODELS_URL);
  const allModels = (data.data || []).filter(m => m.id !== 'openrouter/auto');
  console.log(`  ${allModels.length} video models`);

  const models = [];
  for (const m of allModels) {
    const pricing = parseVideoPricing(m.pricing_skus);
    if (pricing.length === 0) {
      console.warn(`  ⚠ ${m.id}: no parsable pricing_skus — skipping`);
      continue;
    }

    const org = orgFromId(m.id)
      || orgFromName(m.name)
      || m.id.split('/')[0];

    models.push({
      id: m.id,
      name: m.name || m.id,
      org,
      provider: org,
      supported_durations: m.supported_durations || [],
      supported_resolutions: m.supported_resolutions || [],
      pricing,
    });
  }

  console.log(`  ${models.length} models with pricing`);

  // ── Merge fal.ai video models (Tier 1 — first-seen wins over OpenRouter) ──
  const falVideoModels = await fetchFalVideoModels();
  const tieredModels = [...falVideoModels, ...models];
  const dedupedModels = dedupModels(tieredModels);
  console.log(`  Video models: ${models.length} OpenRouter + ${falVideoModels.length} fal → ${dedupedModels.length} after dedup`);

  // Coverage drop check
  const prevCount = await checkCoverageDrop(OUTPUT_PATH, dedupedModels.length);

  // Org enrichment
  const canonToOrg = {};
  for (const m of dedupedModels) {
    if (m.org) {
      canonToOrg[canonicalId(m.id)] = m.org;
      canonToOrg[orgLookupKey(m.id)] = m.org;
    }
  }
  let unresolved = 0;
  for (const m of dedupedModels) {
    if (!m.org || m.org === m.id.split('/')[0]) {
      const resolved = canonToOrg[orgLookupKey(m.id)] || canonToOrg[canonicalId(m.id)];
      if (resolved && resolved !== m.org) m.org = resolved;
    }
    if (!m.org) { m.org = m.provider; unresolved++; }
  }
  if (unresolved) console.warn(`  ⚠ ${unresolved} models could not resolve org — using provider as fallback`);

  // Dry run
  const out = {
    generated_at: new Date().toISOString(),
    models: dedupedModels,
  };

  if (dryRun) {
    console.log('\n── Summary ──');
    console.log(`  Models: ${dedupedModels.length}`);
    for (const m of dedupedModels) {
      const cheapest = m.pricing.reduce((min, p) => p.cost_per_second < min ? p.cost_per_second : min, Infinity);
      console.log(`    ${m.name}: ${m.pricing.length} SKUs, from $${cheapest.toFixed(4)}/sec`);
    }
    if (prevCount !== null) {
      console.log(`  Coverage delta: ${dedupedModels.length - prevCount} (${prevCount} → ${dedupedModels.length})`);
    }
    console.log(`\n→ Dry run — video-pricing.json not written`);
    return;
  }

  await mkdir('public', { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n→ Wrote ${OUTPUT_PATH} (${dedupedModels.length} models)`);
}

main().catch((err) => {
  if (err instanceof CoverageDropError) {
    console.error(`⚠ ${err.message}`);
    console.error('  Last-good video-pricing.json preserved — exiting 0 (not a failure).');
    process.exit(0);
  }
  console.error('Fatal:', err);
  process.exit(1);
});
