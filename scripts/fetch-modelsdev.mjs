/**
 * fetch-modelsdev.mjs — pulls https://models.dev/api.json and builds the
 * enrichment index consumed by applyEnrichment().
 *
 * Returns: Map<twProviderKey, Map<normalizedId, enrichmentRecord>>
 *
 * The index is built by iterating models.dev providers, finding the matching
 * TW provider key via the reverse map, and keying each model by its
 * normalizeForMatch() output. Unmatched providers (no TW counterpart) are
 * skipped silently.
 *
 * On fetch failure (network, non-OK, malformed JSON), logs a warning and
 * returns an empty Map — the pipeline continues without enrichment.
 */

// Import shared helpers from lib.mjs (the Node-pipeline convention — it re-exports
// the pure shared/*.mjs modules). fetchJson is node:fs-backed and lives here.
import { fetchJson, REVERSE_PROVIDER_MAP, normalizeForMatch } from './lib.mjs';

const MODELSDEV_URL = 'https://models.dev/api.json';

// Reverse map: models.dev provider_id → TW provider slug.
// Single source of truth is REVERSE_PROVIDER_MAP in shared/modelsdev.mjs
// (derived from PROVIDER_MAP); tests assert it round-trips every entry.
const REVERSE_MAP = new Map(Object.entries(REVERSE_PROVIDER_MAP));

/**
 * Build the enrichment index from a parsed models.dev API response.
 * Exported for testability (tests pass fixture data instead of fetching).
 */
export function buildIndexFromApi(apiData) {
  const index = new Map(); // twProviderKey → Map<normalizedId, record>
  let modelCount = 0;
  let indexedCount = 0;
  // Crof was removed as a TokenWatch provider. models.dev still points some
  // provider records' api/doc URLs at crof.ai; strip those before the
  // enrichment merges into models so removed-provider URLs never reach
  // pricing.json.
  const REMOVED_HOSTS = ['crof.ai'];
  const isRemovedHost = (url) => {
    if (typeof url !== 'string') return false;
    try {
      const host = new URL(url).hostname;
      return REMOVED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };
  for (const [mdPid, p] of Object.entries(apiData)) {
    const twKey = REVERSE_MAP.get(mdPid);
    if (!twKey) continue; // provider not in TW — skip
    if (!p.models) continue;
    for (const [mdMid, m] of Object.entries(p.models)) {
      modelCount++;
      const normalized = normalizeForMatch(twKey, mdMid);
      if (!normalized) continue;
      if (!index.has(twKey)) index.set(twKey, new Map());
      // First occurrence wins (matches dedup precedence philosophy).
      if (index.get(twKey).has(normalized)) continue;
      const cost = m.cost || {};
      const limit = m.limit || {};
      const baseUrl = (p.api && !p.api.includes('${')) ? p.api : null;
      const docUrl = p.doc || null;
      index.get(twKey).set(normalized, {
        base_url: isRemovedHost(baseUrl) ? null : baseUrl,
        model_id: mdMid,
        doc_url: isRemovedHost(docUrl) ? null : docUrl,
        cache_read: cost.cache_read ?? null,
        cache_write: cost.cache_write ?? null,
        context_length: limit.context ?? null,
        max_output: limit.output ?? null,
        release_date: m.release_date || null,
        knowledge_cutoff: m.knowledge || null,
        description: m.description || null,
        capabilities: {
          reasoning: m.reasoning === true,
          tool_call: m.tool_call === true,
          structured_output: m.structured_output === true,
          attachment: m.attachment === true,
          temperature: m.temperature === true,
        },
        modalities: m.modalities || null,
        open_weights: m.open_weights === true,
      });
      indexedCount++;
    }
  }
  console.log(`  [modelsdev] Indexed ${indexedCount} of ${modelCount} models across ${index.size} TW providers`);
  return index;
}

/**
 * Fetch the live models.dev API and build the enrichment index.
 * Non-fatal: returns an empty Map on any failure.
 */
export async function fetchModelsDevEnrichment() {
  try {
    const t0 = Date.now();
    const data = await fetchJson(MODELSDEV_URL);
    const ms = Date.now() - t0;
    const providerCount = Object.keys(data).length;
    console.log(`✓ models.dev: ${providerCount} providers fetched (${ms}ms)`);
    return buildIndexFromApi(data);
  } catch (err) {
    console.warn(`⚠ models.dev fetch failed — continuing without enrichment: ${err.message}`);
    return new Map();
  }
}
