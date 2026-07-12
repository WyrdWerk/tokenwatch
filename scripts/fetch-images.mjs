#!/usr/bin/env node
/**
 * fetch-images.mjs
 *
 * Fetches image generation models from OpenRouter's /api/v1/images/models,
 * resolves per-endpoint pricing (per-image or per-image-token),
 * and writes public/image-pricing.json.
 *
 * Model record:
 * {
 *   id:          "sourceful/riverflow-v2.5-pro"
 *   name:        "Sourceful: Riverflow V2.5 Pro"
 *   org:         "sourceful"        (model creator)
 *   provider:    "sourceful"        (same as org — no de-aggregation)
 *   output_modalities: ["image"]
 *   pricing: [
 *     { unit: "image"|"token", variant: "1k"|"2k"|"4k"|null,
 *       cost_per_unit: number, cost_per_million: number|null }
 *   ]
 * }
 */

import { writeFile, mkdir } from 'node:fs/promises';
import {
  orgFromId, orgFromName, canonicalId, orgLookupKey, ORG_ALIASES,
  num, fetchJsonWithRetry, checkCoverageDrop, CoverageDropError, parseArgs, dedupModels,
} from './lib.mjs';
import { fetchFalImageModels } from './fetch-fal.mjs';

const IMAGES_MODELS_URL = 'https://openrouter.ai/api/v1/images/models';
const IMAGES_ENDPOINT_BASE = 'https://openrouter.ai/api/v1/images/models';
const CONCURRENCY = 10;
const OUTPUT_PATH = 'public/image-pricing.json';

const USAGE = `Usage: node scripts/fetch-images.mjs [--dry-run]
  --dry-run  Fetch and process but don't write image-pricing.json`;

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const { dryRun, help } = parseArgs(USAGE);
  if (help) return;

  console.log('Fetching image generation models...');

  // Fetch model list
  const data = await fetchJsonWithRetry(IMAGES_MODELS_URL);
  const allModels = (data.data || []).filter(m => m.id !== 'openrouter/auto');
  console.log(`  ${allModels.length} image models (${data.data.length} total, excluded auto-router)`);

  // Fetch endpoints concurrently
  const results = [];
  let failed = 0;
  for (let i = 0; i < allModels.length; i += CONCURRENCY) {
    const batch = allModels.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (m) => {
        const epUrl = `${IMAGES_ENDPOINT_BASE}/${m.id}/endpoints`;
        const epData = await fetchJsonWithRetry(epUrl);
        return { model: m, endpoints: epData };
      })
    );
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        failed++;
        if (failed <= 5) console.error(`    ✗ ${batch[j].id}: ${r.reason?.message || r.reason}`);
      }
    }
    if (i % (CONCURRENCY * 3) === 0 && i > 0) {
      console.log(`    ... ${Math.min(i + CONCURRENCY, allModels.length)}/${allModels.length} models fetched`);
    }
  }

  // Abort on high failure rate
  const failureRate = allModels.length > 0 ? failed / allModels.length : 0;
  if (failureRate > 0.20) {
    throw new Error(
      `Image endpoints failure rate ${(failureRate * 100).toFixed(1)}% ` +
      `(${failed}/${allModels.length}) exceeds 20% threshold — aborting`
    );
  }

  // Parse pricing from endpoints
  const models = [];
  for (const { model, endpoints } of results) {
    const eps = endpoints.endpoints || [];
    const pricing = [];

    for (const ep of eps) {
      const epPricing = ep.pricing || [];
      for (const line of epPricing) {
        if (line.billable !== 'output_image') continue;
        const unit = line.unit; // "image" or "token"
        const cost = num(line.cost_usd);
        if (cost === null) continue;

        const variant = (line.variant || null); // "1k", "2k", "4k", null
        const entry = {
          unit,
          variant,
          cost_per_unit: cost,
          cost_per_million: unit === 'token' ? cost * 1e6 : null,
        };
        // Avoid duplicate entries
        const dup = pricing.find(p => p.unit === unit && p.variant === variant);
        if (!dup) pricing.push(entry);
      }
    }

    if (pricing.length === 0) {
      console.warn(`  ⚠ ${model.id}: no output_image pricing found — skipping`);
      continue;
    }

    // Org from model ID prefix; fall back to name; fall back to provider slug
    const org = orgFromId(model.id)
      || orgFromName(model.name)
      || (eps[0]?.provider_slug || model.id.split('/')[0]);

    models.push({
      id: model.id,
      name: model.name || model.id,
      org,
      provider: org, // model creator IS the provider
      output_modalities: model.architecture?.output_modalities || ['image'],
      supported_parameters: model.supported_parameters || null,
      pricing: pricing.sort((a, b) => {
        // Sort: flat images first, then by variant, then token-priced
        if (a.unit !== b.unit) return a.unit === 'image' ? -1 : 1;
        return (a.cost_per_unit || 0) - (b.cost_per_unit || 0);
      }),
    });
  }

  console.log(`  ${models.length} models with pricing (${failed} endpoints failed)`);

  // ── Merge fal.ai image models (Tier 1 — first-seen wins over OpenRouter) ──
  const falImageModels = await fetchFalImageModels();
  // Prepend fal rows so dedupModels gives them Tier-1 precedence
  const tieredModels = [...falImageModels, ...models];
  const dedupedModels = dedupModels(tieredModels);
  console.log(`  Image models: ${models.length} OpenRouter + ${falImageModels.length} fal → ${dedupedModels.length} after dedup`);

  // Coverage drop check
  const prevCount = await checkCoverageDrop(OUTPUT_PATH, dedupedModels.length);

  // Org enrichment (cross-reference via orgLookupKey)
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
    const flatCount = dedupedModels.filter(m => m.pricing.some(p => p.unit === 'image')).length;
    const tokenCount = dedupedModels.filter(m => m.pricing.every(p => p.unit === 'token')).length;
    console.log(`  Flat per-image: ${flatCount} | Per-token: ${tokenCount}`);
    if (prevCount !== null) {
      const delta = dedupedModels.length - prevCount;
      console.log(`  Coverage delta: ${delta >= 0 ? '+' : ''}${delta} (${prevCount} → ${dedupedModels.length})`);
    }
    console.log(`\n→ Dry run — image-pricing.json not written`);
    return;
  }

  await mkdir('public', { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n→ Wrote ${OUTPUT_PATH} (${dedupedModels.length} models)`);
}

main().catch((err) => {
  if (err instanceof CoverageDropError) {
    console.error(`⚠ ${err.message}`);
    console.error('  Last-good image-pricing.json preserved — exiting 0 (not a failure).');
    process.exit(0);
  }
  console.error('Fatal:', err);
  process.exit(1);
});
