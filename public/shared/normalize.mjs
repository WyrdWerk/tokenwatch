/**
 * shared/normalize.mjs — pure canonicalization helpers shared by the Node
 * pipeline (scripts/) and the Cloudflare Pages Function (functions/).
 *
 * This module MUST NOT import any node: builtins. It is bundled into a
 * Cloudflare Worker (which has no node:fs unless nodejs_compat is enabled),
 * so every function here must be a pure string transform.
 *
 * Imported by:
 *   - scripts/lib.mjs                       (re-exports these)
 *   - functions/api/v1/[[route]].js         (direct import — replaces the
 *     former local normalizeId, which had a greedy -preview-.*$ catch-all
 *     that over-stripped -preview-customtools and caused distinct models to
 *     collide in /models/:id/providers)
 */

/**
 * Build canonical model ID for cross-referencing and dedup.
 * Strips provider prefix, suffixes (:free, dates, -preview, :thinking), lowercases.
 *
 * Date formats stripped: YYYY-MM-DD (-YYYY-MM-DD), YYYYMMDD (-YYYYMMDD), YYMMDD (-YYMMDD).
 * Preview formats stripped: -preview, -preview-MM-YY, -preview-MM-YYYY, -preview-YYYY-MM-DD.
 *
 * IMPORTANT: unknown -preview-<foo> suffixes (e.g. -preview-customtools) are
 * PRESERVED as distinct entries. The API's former normalizeId used a greedy
 * -preview-.*$ catch-all that over-stripped these, causing distinct models
 * (e.g. gemini-3.1-pro vs gemini-3.1-pro-preview-customtools) to collide in
 * /models/:id/providers. Do NOT reintroduce that catch-all.
 *
 * Turbo variants kept separate (different SKUs).
 * Quantization suffixes baked into the ID (e.g. glm-5.2-fp8) are left as-is —
 * they are distinct model entries, not collapsed.
 */
export function canonicalId(id) {
  let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
  k = k.replace(/:free$/, '')
       .replace(/:thinking$/, '')
       .replace(/-(\d{4})-(\d{2})-(\d{2})$/, '')   // -2024-08-06
       .replace(/-preview-(\d{2})-(\d{4})$/, '')    // -preview-09-2025
       .replace(/-preview-(\d{4})-(\d{2})-(\d{2})$/, '') // -preview-2024-08-06
       .replace(/-preview-(\d{2})-(\d{2})$/, '')    // -preview-05-06
       .replace(/-preview$/, '')
       .replace(/-(\d{8})$/, '')                    // -20260420
       .replace(/-(\d{6})$/, '')                    // -250712
       .toLowerCase().trim();
  return k;
}

/** Quantization/tier suffixes that may appear at the END of a canonical ID.
 *  Shared by orgLookupKey (strip for org resolution) and quantFromId (extract
 *  for the quantization field) — keep the list in ONE place to prevent drift. */
export const QUANT_SUFFIX_RE = /-(fp8|nvfp4|int4-mixed-ar|int4|bf16|fp16|fp6|mxfp4)$/;

/**
 * Build a key for org cross-referencing.
 * Like canonicalId but also strips quantization and tier suffixes.
 * Used ONLY for org resolution — not for dedup or model display.
 */
export function orgLookupKey(id) {
  return canonicalId(id)
    .replace(QUANT_SUFFIX_RE, '')
    .replace(/-long$/, '');
}

/** Extract a quantization tag from a model ID, or null when absent.
 *  Matches on the canonical ID so date suffixes are stripped first
 *  ('glm-5.2-fp8-20260803' → 'fp8'). Examples: 'glm-5.2-fp8' → 'fp8',
 *  'qwen3-coder-480b-a35b-instruct-int4-mixed-ar' → 'int4-mixed-ar',
 *  'llama-4-scout-17b-instruct-v1:0-turbo' → null (-turbo is not a quant). */
export function quantFromId(id) {
  const match = canonicalId(id).match(QUANT_SUFFIX_RE);
  return match ? match[1] : null;
}

/** Trailing SKU / serving-tier / quantization tags that do not change which
 *  model a visitor is looking for. Stripped only for SEARCH grouping
 *  (modelFamilyId) — never for dedup, org lookup or the API's canonical ids.
 *  `-turbo` is deliberately absent: gpt-4-turbo / glm-5-turbo are distinct models. */
export const FAMILY_SUFFIX_RE = /-(fast|flex|speed|highspeed|off-peak|peak|batch|nvfp4|mxfp4|fp8|fp6|fp4|int4-mixed-ar|int4|int8|bf16|fp16)$/;

/**
 * Spelling-normalized model key: canonicalId plus separator/version spelling
 * cleanup, so `deepseek-v4-1-flash`, `DeepSeek-V4.1-Flash` and
 * "DeepSeek V4.1 Flash" agree. Keeps SKU/quant suffixes (a precise variant
 * selection). Search-only; dedup keeps canonicalId.
 */
export function modelSpellingKey(id) {
  const tidy = (v) => canonicalId(String(v).replace(/:(batch|nitro|floor|exacto|online)$/i, ''))
    .replace(/[()[\]]/g, '')                // "(off-peak)" → "off-peak"
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/(^|-)v(\d+)-(\d{1,2})(?=-|$)/g, '$1v$2.$3') // v4-1 → v4.1 (not v3-0324)
    .replace(/(^|-)v(\d)/g, '$1$2');                   // v4.1 → 4.1
  // Repeat until stable so stacked suffixes (-preview-260328, :batch) settle
  // and the key is idempotent.
  let k = String(id);
  let prev;
  do { prev = k; k = tidy(k); } while (k !== prev);
  return k;
}

/**
 * Search family: modelSpellingKey with SKU/tier/quant suffixes removed, so the
 * model search offers ONE option per model ("DeepSeek V4.1 Flash") while the
 * results keep each variant as its own explicit row.
 */
export function modelFamilyId(id) {
  let k = modelSpellingKey(id);
  let prev;
  do { prev = k; k = k.replace(FAMILY_SUFFIX_RE, ''); } while (k !== prev);
  return k;
}
