/**
 * shared/model-summary.mjs — pure canonical-model comparison math shared by the
 * calculator UI (public/app.js) and tests. No `node:` imports so it bundles
 * cleanly into the Cloudflare Worker alongside shared/normalize.mjs and
 * shared/cost.mjs.
 *
 * Semantics deliberately mirror app.js:
 *   - `blendedRate()` from shared/cost.mjs is the single cost formula (app.js
 *     keeps a mirrored `blendedCostFor` pinned by test/generate-seo.test.mjs).
 *   - A `null` cache_read falls back to the input rate (no cache discount); a
 *     `null` input/output disqualifies the offering for that leg of the mix.
 *   - Quantization, `:batch`, and other SKU suffixes stay part of the offering
 *     identity — they are never merged into a single "model" row.
 *
 * Honest labelling: this module never invents performance data. `uptime_30m`
 * is a short-window endpoint metric and TTFT/latency comes from whichever
 * source published it; callers must label both with their real source/window.
 */

import { blendedRate } from './cost.mjs';
import { canonicalId } from './normalize.mjs';

/** Minimum provider rows required before summary mode is offered. */
export const MIN_PROVIDER_ROWS = 1;

/**
 * Rank provider offerings by effective cost at the visitor's token mix.
 * Offerings that cannot serve the mix are dropped (same rule as app.js).
 *
 * @param {Array<object>} offerings catalog records
 * @param {{inputPct: number, cacheReadPct: number, outputPct: number}} mix
 * @param {Record<string, object>} [perfByKey] performance keyed `canonical|provider`
 * @returns {Array<{model: object, eff: number, perf: object|null}>}
 */
export function rankOfferings(offerings, mix, perfByKey = {}) {
  return (offerings || [])
    .map((model) => ({
      model,
      eff: blendedRate(model.pricing || {}, mix),
      perf: perfFor(model, perfByKey),
    }))
    .filter((row) => row.eff != null && row.eff > 0)
    .sort((a, b) => {
      if (a.eff !== b.eff) return a.eff - b.eff;
      return String(a.model.provider).localeCompare(String(b.model.provider));
    });
}

/**
 * Performance lookup keyed exactly as app.js does: canonicalId(id)|provider.
 * Using the canonical id keeps quantized variants from borrowing a sibling's
 * metrics, and a missing entry stays null rather than being inferred.
 */
function perfFor(model, perfByKey) {
  if (!perfByKey) return null;
  const key = `${canonicalId(model.id)}|${model.provider}`;
  return perfByKey[key] || null;
}

/**
 * Provider-offering price ranges. These describe the spread ACROSS offerings —
 * they are not an intrinsic model price and must be labelled as such.
 * @returns {{input: object|null, output: object|null, cacheRead: object|null, total: number}}
 */
export function priceDistribution(offerings) {
  const collect = (pick) => {
    const values = (offerings || [])
      .map((model) => pick(model.pricing || {}))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (!values.length) return null;
    return { min: Math.min(...values), max: Math.max(...values), count: values.length };
  };
  return {
    input: collect((p) => p.input),
    output: collect((p) => p.output),
    cacheRead: collect((p) => p.cache_read),
    total: (offerings || []).length,
  };
}

/**
 * Resolve a raw search query to the canonical id of the offerings it matches.
 *
 * The results filter normalizes spaces and hyphens to the same separator, so
 * "GLM 5.3" matches the same rows as "glm-5.3". The summary must resolve the
 * same way, otherwise a space-separated query filters the table but yields no
 * summary. Exact canonical ids (including `:batch`/quant variants) win first.
 */
export function resolveCanonicalQuery(catalogModels, query) {
  const raw = String(query || '').trim();
  if (!raw) return null;

  const target = canonicalId(raw);
  if (target && (catalogModels || []).some((model) => model && canonicalId(model.id) === target)) return target;

  const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, ' ').trim();
  const q = norm(raw);
  if (!q) return null;
  const ids = new Set();
  for (const model of catalogModels || []) {
    if (!model || !model.id) continue;
    const id = canonicalId(model.id);
    if (id && norm(id) === q) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * Build the canonical-model summary when the selection resolves to exactly one
 * canonical id. Returns null otherwise (multi-model or empty selections use the
 * normal results table).
 *
 * @param {Array<object>} catalogModels full in-memory catalog rows
 * @param {{canonical: string, mix: object, perfByKey?: Record<string, object>}} options
 */
export function canonicalSummary(catalogModels, { canonical, mix, perfByKey = {} } = {}) {
  const target = resolveCanonicalQuery(catalogModels, canonical);
  if (!target) return null;

  const offerings = (catalogModels || []).filter((model) => model && canonicalId(model.id) === target);
  if (!offerings.length) return null;

  const rows = rankOfferings(offerings, mix, perfByKey);
  const perfCoverage = rows.filter((row) => row.perf != null).length;
  const distribution = priceDistribution(offerings);
  const cheapest = rows[0] || null;

  return {
    canonical: target,
    name: offerings.find((m) => m.name)?.name || target,
    org: offerings.find((m) => m.org)?.org || offerings[0].provider,
    providerCount: new Set(offerings.map((m) => m.provider)).size,
    offeringCount: offerings.length,
    rows,
    cheapest: cheapest ? cheapest.model : null,
    cheapestEff: cheapest ? cheapest.eff : null,
    distribution,
    perfCoverage,
  };
}