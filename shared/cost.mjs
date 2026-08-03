/**
 * shared/cost.mjs — pure cost math shared by the Node pipeline (generate-seo),
 * the Cloudflare Pages Function, and tests. No `node:` imports so it bundles
 * cleanly into the Worker alongside shared/normalize.mjs.
 *
 * IMPORTANT: public/app.js is a classic <script> (no bundler, cannot import ESM)
 * and keeps a MIRRORED copy of this logic (blendedCostFor / costFor). The parity
 * guard in test/generate-seo.test.mjs pins the mirror to this module; when the
 * formula changes, update BOTH surfaces + the test. See
 * docs/canonicalization-edge-cases.md §10 for the same pattern on canonicalId.
 */

/**
 * Effective $/M rate for a token mix. Prices are $/M tokens; pct are 0-100.
 *
 * Null semantics (mirrors app.js blendedCostFor):
 *  - inputPct > 0 && input price null  → returns null (offering can't serve the mix)
 *  - outputPct > 0 && output price null → returns null
 *  - cache_read null → cached tokens are charged at the INPUT rate (no cache
 *    discount; the provider simply doesn't publish one)
 *  - cache_read AND input both null → the cache leg contributes $0 (never
 *    disqualifies the offering — matches app.js costFor semantics)
 *
 * Returns null when the mix can't be priced at all, otherwise USD per 1M tokens
 * (i.e. blendedCostFor's return) — NOT a per-token cost.
 */
export function blendedRate(pricing, { inputPct, cacheReadPct, outputPct }) {
  const inRate = pricing.input != null ? pricing.input * inputPct / 100 : null;
  const outRate = pricing.output != null ? pricing.output * outputPct / 100 : null;
  const crPrice = pricing.cache_read != null ? pricing.cache_read : pricing.input;
  const crRate = crPrice != null ? crPrice * cacheReadPct / 100 : null;
  if (inputPct > 0 && inRate === null) return null;
  if (outputPct > 0 && outRate === null) return null;
  return (inRate || 0) + (outRate || 0) + (crRate || 0);
}

/** The default agentic workload mix used by the SEO "cheapest models" ranking. */
export const AGENTIC_MIX = { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 };