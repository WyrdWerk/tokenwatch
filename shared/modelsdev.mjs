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
  deepinfra: 'deep-infra',
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
  crof: 'crof',
  deepseek: 'deepseek',
  digitalocean: 'digitalocean',
  friendli: 'friendli',
  gmicloud: 'gmicloud',
  google: 'google',
  groq: 'groq',
  inception: 'inception',
  'io-net': 'io-net',
  lilac: 'lilac',
  minimax: 'minimax',
  mistral: 'mistral',
  morph: 'morph',
  nebius: 'nebius',
  openai: 'openai',
  opencode: 'opencode-go',
  perplexity: 'perplexity',
  poolside: 'poolside',
  sakana: 'sakana',
  stepfun: 'stepfun',
  synthetic: 'synthetic',
  upstage: 'upstage',
  venice: 'venice',
  wandb: 'wandb',
  xai: 'xai',
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
    return { ...providerMap.get(exactNorm), confidence: 'high' };
  }
  const fuzzy = boundedFuzzyMatch(exactNorm, [...providerMap.keys()]);
  if (fuzzy) {
    return { ...providerMap.get(fuzzy), confidence: 'medium' };
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
        doc_url: modelHit.doc_url ?? null,
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
