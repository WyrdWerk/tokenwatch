/**
 * shared/modelsdev.mjs — pure reconciliation helpers for the models.dev
 * enrichment source.
 *
 * This module MUST NOT import any node: builtins (same constraint as
 * shared/normalize.mjs). It is pure string-transform logic.
 *
 * Imported by:
 *   - scripts/lib.mjs (re-exports the public surface)
 *   - scripts/fetch-modelsdev.mjs (builds the enrichment index)
 */

import { canonicalId } from './normalize.mjs';

/**
 * TW provider slug → models.dev provider_id.
 * Entries where the slug differs are explicit; identity mappings are
 * included for providers that exist on both sides with the same key
 * (for lookup clarity and so the reverse map derives correctly).
 */
export const PROVIDER_MAP = {
  // slug-format differences (bespoke)
  deepinfra: 'deepinfra',
  fireworks: 'fireworks-ai',
  together: 'togetherai',
  novita: 'novita-ai',
  moonshot: 'moonshotai',
  sambanova: 'nova',
  'z-ai': 'zai',
  xiaomimimo: 'xiaomi',
  wafer: 'wafer.ai',
  amazon: 'amazon-bedrock',
  cloudflare: 'cloudflare-workers-ai',
  // identity mappings (same slug on both sides)
  alibaba: 'alibaba',
  anthropic: 'anthropic',
  azure: 'azure',
  baseten: 'baseten',
  cerebras: 'cerebras',
  chutes: 'chutes',
  clarifai: 'clarifai',
  cohere: 'cohere',
  crusoe: 'crusoe',
  deepseek: 'deepseek',
  digitalocean: 'digitalocean',
  friendli: 'friendli',
  hyper: 'hyper',
  gmicloud: 'gmicloud',
  google: 'google',
  groq: 'groq',
  inception: 'inception',
  'io-net': 'io-net',
  minimax: 'minimax',
  mistral: 'mistral',
  modal: 'modal',
  morph: 'morph',
  nebius: 'nebius',
  neuralwatt: 'neuralwatt',
  openai: 'openai',
  opencode: 'opencode-go',
  perplexity: 'perplexity',
  poolside: 'poolside',
  runinfra: 'runinfra',
  sakana: 'sakana',
  siliconflow: 'siliconflow',
  stepfun: 'stepfun',
  synthetic: 'synthetic',
  umans: 'umans-ai-coding-plan',
  upstage: 'upstage',
  venice: 'venice',
  wandb: 'wandb',
  xai: 'xai',
  // Verified 2026-10-09 by catalog overlap: each shares model ids with the
  // models.dev provider and lists the same base URL host.
  arcee: 'arcee',
  coralbricks: 'coralbricks',
  inceptron: 'inceptron',
  meta: 'meta',
  'scx-ai': 'scx-ai',
  tencent: 'tencent-tokenhub',
};

/**
 * Additional TW provider slugs that read from an md provider already claimed
 * in PROVIDER_MAP. Kept separate so PROVIDER_MAP stays injective and
 * REVERSE_PROVIDER_MAP stays a 1:1 lookup.
 *   - xiaomi: OpenRouter's Xiaomi backend; xiaomimimo (CSV) owns 'xiaomi'.
 *   - meta-contributor: Meta's contributor-tier SKUs on the same API.
 */
export const EXTRA_PROVIDER_ALIASES = {
  xiaomi: 'xiaomi',
  'meta-contributor': 'meta',
};

/**
 * models.dev provider_id → TW provider slug. Derived from PROVIDER_MAP.
 * Note: non-injective maps (multiple TW keys → same md id) are not expected
 * here; every value in PROVIDER_MAP is currently unique, so this reverse
 * lookup is unambiguous.
 */
export const REVERSE_PROVIDER_MAP = Object.fromEntries(
  Object.entries(PROVIDER_MAP).map(([tw, md]) => [md, tw]),
);

/** models.dev provider_id → every TW provider slug indexed from it. */
export const MODELSDEV_PROVIDER_TARGETS = (() => {
  const targets = {};
  for (const [tw, md] of [...Object.entries(PROVIDER_MAP), ...Object.entries(EXTRA_PROVIDER_ALIASES)]) {
    (targets[md] ||= []).push(tw);
  }
  return targets;
})();

/**
 * Normalize a model ID for join-key purposes, applying any provider-specific
 * transform. Default: canonicalId only. Providers with bespoke ID formats
 * (cloudflare, amazon, fireworks, minimax) are handled in PROVIDER_NORMALIZERS.
 */
export function normalizeForMatch(providerKey, modelId) {
  const fn = PROVIDER_NORMALIZERS[providerKey];
  return fn ? fn(modelId) : canonicalId(modelId);
}

/**
 * Strip a leading region segment from a Bedrock model ID.
 *   'global.anthropic.claude-haiku-4-5-20251001-v1:0' → 'anthropic.claude-haiku-4-5-20251001-v1:0'
 *   'us.meta.llama4-scout-17b-instruct-v1:0'          → 'meta.llama4-scout-17b-instruct-v1:0'
 * Regions seen in real data: global, us, eu, jp, ap, sa, ca.
 */
function stripBedrockRegion(id) {
  return id.replace(/^(global|us|eu|jp|ap|sa|ca)\./i, '');
}

/**
 * Normalize an Amazon Bedrock model ID for matching.
 *   'global.anthropic.claude-haiku-4-5-20251001-v1:0'
 *     → strip region        → 'anthropic.claude-haiku-4-5-20251001-v1:0'
 *     → first dot = org sep → 'anthropic/claude-haiku-4-5-20251001-v1:0'
 *     → strip :N stamp      → 'anthropic/claude-haiku-4-5-20251001-v1'
 *     → strip trailing -vN  → 'anthropic/claude-haiku-4-5-20251001'
 *     → canonicalId (-date)→ 'claude-haiku-4-5'
 *
 * The trailing -v<N> segment (e.g. '-v1') is stripped here because canonicalId
 * only strips a bare trailing date; with '-v1' left on the end the date isn't
 * terminal and would otherwise survive canonicalId.
 */
function normalizeAmazon(id) {
  const noRegion = stripBedrockRegion(id);
  const firstDot = noRegion.indexOf('.');
  const withSlash = firstDot > 0
    ? noRegion.slice(0, firstDot) + '/' + noRegion.slice(firstDot + 1)
    : noRegion;
  const noVersion = withSlash.replace(/:\d+$/, '').replace(/-v\d+$/, '');
  return canonicalId(noVersion);
}

/**
 * Strip the Fireworks accounts/fireworks/{models,routers}/ prefix and decode
 * the version encoding where 'p' replaces '.' (e.g. 'k2p6' → 'k2.6', '5p2' → '5.2').
 * ONLY decodes the version pattern — other 'p' occurrences are left alone.
 * SKU suffixes (-turbo, -fast, -highspeed) are preserved as distinct SKUs.
 */
function normalizeFireworks(id) {
  const stripped = id.replace(/^accounts\/fireworks\/(?:models|routers)\//, '');
  // Decode version pattern: a digit followed by 'p' followed by a digit.
  // Applies across multi-segment versions like 'k2p6' (k2.6) and '5p2' (5.2).
  const decoded = stripped.replace(/(\d)p(\d)/g, '$1.$2');
  return canonicalId(decoded);
}

/**
 * Strip the duplicated brand prefix on Minimax models.dev IDs.
 *   'MiniMax-M2.5-highspeed' → 'M2.5-highspeed' → canonicalId → 'm2.5-highspeed'
 * SKU suffixes preserved.
 */
function normalizeMinimax(id) {
  const noBrand = id.replace(/^MiniMax-/i, '');
  return canonicalId(noBrand);
}

/**
 * Tokenize an ID for fuzzy matching. Splits on / - _ and drops empty segments.
 *
 * NOTE: '.' is intentionally NOT a delimiter. Version subnumbers (e.g. '5.5',
 * 'k2.7') must survive as single tokens so that 'gpt-5' does not falsely
 * subset-match 'gpt-5.5' (a classic wrong-URL hazard). Splitting on '.' would
 * turn 'gpt-5.5' into [gpt, 5, 5], making 'gpt-5' ([gpt, 5]) a spurious subset.
 */
function tokenize(id) {
  return id.split(/[\/\-_]/).filter(Boolean);
}

/**
 * Bounded fuzzy fallback. Returns a single matching key from the haystack, or
 * null if no safe match exists.
 *
 * Rules:
 *  - Same-provider only (caller passes only that provider's keys).
 *  - 2-token floor on both sides.
 *  - Directional subset: the NEEDLE (TW id) must be a subset of the CANDIDATE
 *    (MD id). This captures the intended case (TW base model → MD suffixed SKU
 *    like kimi-k2.7-code → kimi-k2.7-code-fast) but rejects the wrong case
 *    (TW suffixed SKU → MD base model like o4-mini-high → o4-mini, which would
 *    surface the wrong model_id on the card).
 *  - Single-candidate: if more than one key matches, refuse (ambiguity).
 */
function boundedFuzzyMatch(needle, haystack) {
  const needleTokens = tokenize(needle);
  if (needleTokens.length < 2) return null;
  const candidates = [];
  for (const candidate of haystack) {
    const candTokens = tokenize(candidate);
    if (candTokens.length < 2) continue;
    // Directional: needle (TW) must be the subset of candidate (MD).
    // This captures the intended case (TW base model → MD suffixed SKU)
    // but rejects the wrong case (TW suffixed SKU → MD base model).
    if (needleTokens.length > candTokens.length) continue;
    const candSet = new Set(candTokens);
    const isSubset = needleTokens.every((t) => candSet.has(t));
    if (isSubset) candidates.push(candidate);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Lowercased last path segment without `:batch` — the id as a provider spells it. */
function idTail(id) {
  return String(id || '').toLowerCase().replace(/:batch$/, '').split('/').pop();
}

/** Fields that must agree across collapsed md ids before SKU-specific facts are trusted. */
const SKU_FACT_KEYS = ['status', 'cost_input', 'cost_output', 'context_tiers', 'max_input'];

/**
 * When several md ids collapsed to one key, prefer the candidate whose raw id
 * equals the TokenWatch id. Without such a candidate the primary record is
 * kept (descriptive metadata unchanged) but flagged `ambiguous` when the
 * candidates disagree on SKU-specific facts — lifecycle, tiers and the price
 * check then skip it rather than borrow another SKU's facts.
 */
function resolveAlternate(record, twModelId) {
  const alternates = record?.alternates;
  if (!alternates) return record;
  const tail = idTail(twModelId);
  const exact = alternates.find((candidate) => idTail(candidate.model_id) === tail);
  if (exact) return exact;
  const disagree = SKU_FACT_KEYS.some((key) =>
    new Set(alternates.map((candidate) => JSON.stringify(candidate[key] ?? null))).size > 1);
  return disagree ? { ...record, ambiguous: true } : record;
}

/**
 * Two-tier matcher. Returns the enrichment record with a `confidence` field
 * ('high' for exact normalized, 'medium' for bounded fuzzy), or null if no match.
 *
 * `providerIndex` is a Map<twProviderKey, Map<normalizedId, enrichmentRecord>>,
 * built by the fetcher script. Cross-provider matching is impossible by
 * construction (each provider has its own inner Map).
 */
export function findEnrichment(twProvider, twModelId, providerIndex) {
  const providerMap = providerIndex.get(twProvider);
  if (!providerMap) return null;
  const exactNorm = normalizeForMatch(twProvider, twModelId);
  if (providerMap.has(exactNorm)) {
    return { ...resolveAlternate(providerMap.get(exactNorm), twModelId), confidence: 'high', match: 'exact' };
  }
  const fuzzy = boundedFuzzyMatch(exactNorm, [...providerMap.keys()]);
  if (fuzzy) {
    return { ...resolveAlternate(providerMap.get(fuzzy), twModelId), confidence: 'medium', match: 'fuzzy' };
  }
  // Metadata-only fallback: ':batch' billing variants (azure/openai/google/…)
  // share the base model's metadata. Row identity and dedup are untouched —
  // twModelId/canonicalId keep ':batch'; only enrichment borrows the base record.
  if (twModelId.endsWith(':batch')) {
    const batchNorm = normalizeForMatch(twProvider, twModelId.slice(0, -':batch'.length));
    if (providerMap.has(batchNorm)) {
      // 'medium' (⚠ pill) — variant match: batch SKU borrows base model metadata.
      return { ...resolveAlternate(providerMap.get(batchNorm), twModelId), confidence: 'medium', match: 'batch-base' };
    }
  }
  return null;
}

/**
 * Apply models.dev enrichment to a list of TW models (mutates in place).
 *
 * Merge rule (NEVER overwrite):
 *   - pricing.cache_read, pricing.cache_write, context_length, max_output
 *     are filled from MD ONLY when the TW value is null/undefined.
 *   - When both are non-null and differ, the TW value is kept and a warning
 *     string is pushed to `log`.
 *   - The `modelsdev` block is attached whenever any provider-specific match
 *     (Tier A or B) is found, regardless of whether cache fields were filled.
 *   - If NO provider-specific match exists, a `modelsdev_model` block is
 *     attached instead — model-level metadata (description, capabilities,
 *     modalities) from ANY provider hosting the same canonical model. Never
 *     carries base_url or model_id (those are provider-specific and can't be
 *     safely borrowed). The frontend shows these with a disclaimer.
 *
 * `providerIndex` is the Map<twProviderKey, Map<normalizedId, record>> from
 * the fetcher. `log` is an array that collects disagreement warnings.
 */
export function applyEnrichment(models, providerIndex, log = []) {
  // Build a model-level fallback index: canonicalId → first record seen.
  // Used when no provider-specific match exists, to still surface model
  // metadata (description, capabilities) from any hosting provider.
  const modelIndex = new Map();
  for (const inner of providerIndex.values()) {
    for (const [normId, rec] of inner) {
      // normId is already canonicalId-ified per the TW provider's normalizer.
      // For the model-level index we need a provider-agnostic canonical key;
      // normId serves that purpose well enough (normalizers mostly just strip
      // prefixes, the underlying model name is preserved).
      if (!modelIndex.has(normId)) modelIndex.set(normId, rec);
    }
  }

  let modelFallbackCount = 0;
  for (const m of models) {
    const hit = findEnrichment(m.provider, m.id, providerIndex);

    if (hit) {
      // Provider-specific match — full enrichment (existing behavior).
      if (!m.pricing) m.pricing = {};
      for (const [twField, mdField] of [
        ['cache_read', 'cache_read'],
        ['cache_write', 'cache_write'],
      ]) {
        const mdVal = hit[mdField];
        if (mdVal === null || mdVal === undefined) continue;
        if (m.pricing[twField] === null || m.pricing[twField] === undefined) {
          m.pricing[twField] = mdVal;
        } else if (m.pricing[twField] !== mdVal) {
          log.push(`${m.provider}/${m.id} ${twField} disagreement: TW=${m.pricing[twField]} MD=${mdVal} (kept TW)`);
        }
      }
      if (hit.context_length != null) {
        if (m.context_length === null || m.context_length === undefined) {
          m.context_length = hit.context_length;
        } else if (m.context_length !== hit.context_length) {
          log.push(`${m.provider}/${m.id} context_length disagreement: TW=${m.context_length} MD=${hit.context_length} (kept TW)`);
        }
      }
      if (hit.max_output != null) {
        if (m.max_completion_tokens === null || m.max_completion_tokens === undefined) {
          m.max_completion_tokens = hit.max_output;
        } else if (m.max_completion_tokens !== hit.max_output) {
          log.push(`${m.provider}/${m.id} max_output disagreement: TW=${m.max_completion_tokens} MD=${hit.max_output} (kept TW)`);
        }
      }
      if (hit.max_input != null) {
        if (m.max_prompt_tokens === null || m.max_prompt_tokens === undefined) {
          m.max_prompt_tokens = hit.max_input;
        } else if (m.max_prompt_tokens !== hit.max_input) {
          log.push(`${m.provider}/${m.id} max_prompt_tokens disagreement: TW=${m.max_prompt_tokens} MD=${hit.max_input} (kept TW)`);
        }
      }
      // Lifecycle status is SKU-specific: never borrow it through a fuzzy
      // match (base id → suffixed md SKU). A :batch row shares its base model's
      // lifecycle, so the batch-base fallback is allowed.
      if (hit.status && hit.match !== 'fuzzy' && !hit.ambiguous) m.lifecycle_status = hit.status;
      // Context tiers describe one tariff. Attach them only for an exact SKU
      // match whose base price IS the row's price — a promo, batch, fuzzy or
      // differently priced row would otherwise inherit tiers that do not apply.
      if (hit.context_tiers && hit.match === 'exact' && !hit.ambiguous && sameTariff(m.pricing, hit)) {
        m.context_price_tiers = hit.context_tiers.map((tier) => ({ ...tier }));
      }

      m.modelsdev = {
        base_url: hit.base_url,
        model_id: hit.model_id,
        doc_url: hit.doc_url ?? null,
        confidence: hit.confidence,
        source: 'models.dev',
        release_date: hit.release_date ?? null,
        knowledge_cutoff: hit.knowledge_cutoff ?? null,
        description: hit.description ?? null,
        capabilities: hit.capabilities ?? null,
        modalities: hit.modalities ?? null,
        open_weights: hit.open_weights ?? null,
        license: hit.license ?? null,
        reasoning_options: hit.reasoning_options ?? null,
        interleaved_reasoning: hit.interleaved_reasoning ?? null,
      };
      continue;
    }

    // No provider-specific match — try model-level fallback.
    const normId = normalizeForMatch(m.provider, m.id);
    const modelHit = modelIndex.get(normId);
    if (modelHit) {
      m.modelsdev_model = {
        source: 'models.dev (model-level fallback)',
        release_date: modelHit.release_date ?? null,
        knowledge_cutoff: modelHit.knowledge_cutoff ?? null,
        description: modelHit.description ?? null,
        capabilities: modelHit.capabilities ?? null,
        modalities: modelHit.modalities ?? null,
        open_weights: modelHit.open_weights ?? null,
        license: modelHit.license ?? null,
        doc_url: modelHit.doc_url ?? null,
        reasoning_options: modelHit.reasoning_options ?? null,
        interleaved_reasoning: modelHit.interleaved_reasoning ?? null,
      };
      modelFallbackCount++;
    }
  }
  return { modelFallbackCount };
}

const PROVIDER_NORMALIZERS = {
  cloudflare: (id) => canonicalId(id.replace(/^@cf\//, '')),
  amazon: normalizeAmazon,
  fireworks: normalizeFireworks,
  minimax: normalizeMinimax,
};

/** Relative closeness for $/M prices (1% default — float noise, not policy). */
function priceClose(a, b, tolerance = 0.01) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return true;
  return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

/** True when a row's input AND output equal the md record's base tariff. */
function sameTariff(pricing, hit) {
  return priceClose(pricing?.input, hit.cost_input) && priceClose(pricing?.output, hit.cost_output);
}

/**
 * Normalize models.dev `cost.tiers` / `cost.context_over_200k` into
 * [{ above_tokens, input, output, cache_read, cache_write }] sorted ascending.
 * Only context-size tiers are kept; malformed entries are dropped. Returns
 * null when nothing usable remains.
 */
export function normalizeContextTiers(cost) {
  const out = [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const push = (size, t) => {
    const input = num(t?.input);
    const output = num(t?.output);
    if (!Number.isInteger(size) || size <= 0 || input === null || output === null) return;
    if (out.some((tier) => tier.above_tokens === size)) return;
    out.push({ above_tokens: size, input, output, cache_read: num(t.cache_read), cache_write: num(t.cache_write) });
  };
  if (Array.isArray(cost?.tiers)) {
    for (const t of cost.tiers) if (t?.tier?.type === 'context') push(t.tier.size, t);
  }
  if (cost?.context_over_200k) push(200000, cost.context_over_200k);
  out.sort((a, b) => a.above_tokens - b.above_tokens);
  return out.length ? out : null;
}

/**
 * Compare each TokenWatch offering's input/output price with the models.dev
 * listing for the SAME provider + model (the index is per provider, so a
 * cheaper host for the same model never counts as drift).
 *
 * Classes:
 *   match              — input and output agree within 1%
 *   promo_explained    — OpenRouter discount > 0 and the undiscounted price
 *                        (price / (1 - discount)) agrees with models.dev
 *   promo_unexplained  — discounted row that still disagrees after undoing the promo
 *   tier_explained     — the row's price equals one of the md context tiers
 *   mismatch           — no known explanation (exact or :batch-free match)
 *   fuzzy_mismatch     — differs, but the md record was a fuzzy (base id →
 *                        suffixed SKU) match, so it may be a different SKU
 *
 * Skipped: `:batch` rows (batch discounts are not listed by models.dev),
 * batch-base borrowed matches, rows without a md base price, and md listings
 * priced at zero. Read-only: never changes any row.
 *
 * @param {object[]} models
 * @param {Map} providerIndex
 * @param {{ sourceOf?: (m: object) => string|null }} [options]
 */
export function modelsDevPriceDrift(models, providerIndex, { sourceOf = () => null } = {}) {
  const counts = { match: 0, promo_explained: 0, promo_unexplained: 0, tier_explained: 0, mismatch: 0, fuzzy_mismatch: 0 };
  const rows = [];
  for (const m of models) {
    if (typeof m?.id !== 'string' || m.id.endsWith(':batch')) continue;
    const hit = findEnrichment(m.provider, m.id, providerIndex);
    if (!hit || hit.match === 'batch-base' || hit.ambiguous) continue;
    const tw = { input: m.pricing?.input, output: m.pricing?.output };
    const md = { input: hit.cost_input, output: hit.cost_output };
    if (![tw.input, tw.output, md.input, md.output].every(Number.isFinite)) continue;
    if (md.input <= 0 && md.output <= 0) continue;
    const discount = Number.isFinite(m.discount) && m.discount > 0 && m.discount < 1 ? m.discount : 0;
    let cls;
    if (priceClose(tw.input, md.input) && priceClose(tw.output, md.output)) cls = 'match';
    else if (discount > 0) {
      const list = { input: tw.input / (1 - discount), output: tw.output / (1 - discount) };
      cls = priceClose(list.input, md.input) && priceClose(list.output, md.output) ? 'promo_explained' : 'promo_unexplained';
    } else if ((hit.context_tiers || []).some((t) => priceClose(tw.input, t.input) && priceClose(tw.output, t.output))) {
      cls = 'tier_explained';
    } else cls = hit.match === 'fuzzy' ? 'fuzzy_mismatch' : 'mismatch';
    counts[cls]++;
    if (cls === 'match') continue;
    // tw/md per side; a zero on one side yields 0 or Infinity (largest gap).
    const ratios = [[tw.input, md.input], [tw.output, md.output]]
      .filter(([a, b]) => a > 0 || b > 0)
      .map(([a, b]) => (b === 0 ? Infinity : a / b));
    const worst = ratios.reduce((w, r) => (Math.abs(Math.log(r)) > Math.abs(Math.log(w)) ? r : w), 1);
    rows.push({
      provider: m.provider,
      id: m.id,
      source: sourceOf(m),
      match: hit.match,
      discount,
      tw,
      md,
      ratio: worst,
      class: cls,
    });
  }
  rows.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
  return { checked: Object.values(counts).reduce((a, b) => a + b, 0), counts, rows };
}
