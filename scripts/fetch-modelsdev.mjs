/**
 * fetch-modelsdev.mjs — pulls models.dev's provider and model catalogs and
 * builds separate enrichment and all-provider open-weight indexes.
 *
 * Indexes: a TokenWatch-mapped enrichment index, an all-provider weight index,
 * and a model-level license index from models.json.
 *
 * The index is built by iterating models.dev providers, finding the matching
 * TW provider key via the reverse map, and keying each model by its
 * normalizeForMatch() output. Unmatched providers (no TW counterpart) are
 * skipped silently.
 *
 * Provider-catalog failure is non-fatal and returns empty indexes. The
 * separate models.json catalog supplies model-level license strings.
 */

// Import shared helpers from lib.mjs (the Node-pipeline convention — it re-exports
// the pure shared/*.mjs modules). fetchJson is node:fs-backed and lives here.
import { fetchJson, REVERSE_PROVIDER_MAP, normalizeForMatch } from './lib.mjs';
import { openWeightLookupId } from '../shared/open-weights.mjs';

const MODELSDEV_URL = 'https://models.dev/api.json';
const MODELSDEV_MODELS_URL = 'https://models.dev/models.json';

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
          tool_call: typeof m.tool_call === 'boolean' ? m.tool_call : null,
          structured_output: m.structured_output === true,
          attachment: m.attachment === true,
          temperature: m.temperature === true,
        },
        modalities: m.modalities || null,
        open_weights: typeof m.open_weights === 'boolean' ? m.open_weights : null,
        license: typeof m.license === 'string' && m.license.trim() ? m.license : null,
      });
      indexedCount++;
    }
  }
  console.log(`  [modelsdev] Indexed ${indexedCount} of ${modelCount} models across ${index.size} TW providers`);
  return index;
}

/** Build model-level license strings from the models.dev models.json catalog. */
export function buildModelsDevLicenseIndex(modelsData) {
  const countsById = new Map();
  for (const [modelId, model] of Object.entries(modelsData || {})) {
    const id = openWeightLookupId(modelId);
    const license = typeof model?.license === 'string' ? model.license.trim() : '';
    if (!id || !license) continue;
    if (!countsById.has(id)) countsById.set(id, new Map());
    const licenseCounts = countsById.get(id);
    licenseCounts.set(license, (licenseCounts.get(license) || 0) + 1);
  }

  return new Map([...countsById].map(([id, licenseCounts]) => [
    id,
    [...licenseCounts]
      .sort(([licenseA, countA], [licenseB, countB]) => countB - countA || licenseA.localeCompare(licenseB))[0][0],
  ]));
}

/** Build weight facts from every models.dev provider, not only TW-mapped ones. */
export function buildOpenWeightIndexFromApi(apiData, modelLicenseIndex = new Map()) {
  const index = new Map();
  for (const [providerId, provider] of Object.entries(apiData || {})) {
    if (!provider?.models) continue;
    const providerModels = new Map();
    for (const [modelId, model] of Object.entries(provider.models)) {
      const id = openWeightLookupId(modelId);
      if (!id) continue;
      const previous = providerModels.get(id);
      const openWeights = typeof model?.open_weights === 'boolean' ? model.open_weights : null;
      const rawLicense = typeof model?.license === 'string' ? model.license.trim() : '';
      const license = rawLicense || modelLicenseIndex.get(id) || null;
      if (!previous && openWeights === null && license === null) continue;
      providerModels.set(id, {
        open_weights: previous?.open_weights ?? openWeights,
        license: previous?.license ?? license,
      });
    }
    if (providerModels.size > 0) index.set(providerId, providerModels);
  }
  return index;
}

/**
 * Fetch the live models.dev API and build the enrichment index.
 * Non-fatal: returns an empty Map on any failure.
 */
export async function fetchModelsDevIndexes() {
  try {
    const t0 = Date.now();
    const providerData = await fetchJson(MODELSDEV_URL);
    const providerFetchMs = Date.now() - t0;
    const providerCount = Object.keys(providerData).length;
    let modelsData = {};
    try {
      modelsData = await fetchJson(MODELSDEV_MODELS_URL);
    } catch (err) {
      console.warn(`⚠ models.dev models.json unavailable — licenses may be incomplete: ${err.message}`);
    }
    console.log(`✓ models.dev: ${providerCount} providers fetched (${providerFetchMs}ms), ${Object.keys(modelsData).length} model records`);
    const modelLicenseIndex = buildModelsDevLicenseIndex(modelsData);
    return {
      enrichmentIndex: buildIndexFromApi(providerData),
      openWeightIndex: buildOpenWeightIndexFromApi(providerData, modelLicenseIndex),
      modelLicenseIndex,
    };
  } catch (err) {
    console.warn(`⚠ models.dev fetch failed — continuing without enrichment: ${err.message}`);
    return {
      enrichmentIndex: new Map(),
      openWeightIndex: new Map(),
      modelLicenseIndex: new Map(),
    };
  }
}
