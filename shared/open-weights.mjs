/**
 * shared/open-weights.mjs — canonical open-weight status resolution.
 *
 * Pure and Worker-safe. The caller supplies source records and the reviewed
 * override map; this module performs no filesystem, network, or Node imports.
 */

import { canonicalId as normalizeCanonicalId } from './normalize.mjs';

const ORG_PRIORS = new Map([
  ['anthropic', false],
  ['xai', false],
  ['amazon', false],
  ['perplexity', false],
]);

/** Normalize only the lookup key; offering IDs remain unchanged. */
export function openWeightLookupId(id) {
  return normalizeCanonicalId(id).replace(/(:batch|-turbo|-fast)$/i, '');
}

function licenseFromRecords(records) {
  const counts = new Map();
  for (const record of records) {
    const license = typeof record?.license === 'string' ? record.license.trim() : '';
    if (license) counts.set(license, (counts.get(license) || 0) + 1);
  }
  return [...counts]
    .sort(([licenseA, countA], [licenseB, countB]) => countB - countA || licenseA.localeCompare(licenseB))[0]?.[0] ?? null;
}

/**
 * Build canonicalId → models.dev facts from the provider index produced by
 * fetch-modelsdev.mjs. Each indexed models.dev record contributes at most one
 * vote, independent of how many TokenWatch offerings use it.
 */
export function buildModelsDevOpenWeightIndex(providerIndex) {
  const index = new Map();
  for (const providerModels of providerIndex.values()) {
    const seenByProvider = new Set();
    for (const [normalizedId, record] of providerModels) {
      const key = openWeightLookupId(normalizedId);
      if (!key || seenByProvider.has(key)) continue;
      seenByProvider.add(key);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({
        open_weights: typeof record.open_weights === 'boolean' ? record.open_weights : null,
        license: typeof record.license === 'string' ? record.license : null,
      });
    }
  }
  return index;
}

/**
 * Resolve one status and license per canonical ID, then project it onto every
 * offering for that ID. Org priors are used only when all reported orgs agree.
 */
export function resolveOpenWeightsForOfferings(offerings, providerIndex, overrides = {}, modelLicenseIndex = new Map()) {
  const modelsDevRecords = buildModelsDevOpenWeightIndex(providerIndex);
  const orgsByCanonical = new Map();
  for (const offering of offerings) {
    const id = normalizeCanonicalId(offering.id);
    if (!orgsByCanonical.has(id)) orgsByCanonical.set(id, new Set());
    if (typeof offering.org === 'string' && offering.org.trim()) {
      orgsByCanonical.get(id).add(offering.org.trim().toLowerCase());
    }
  }

  const resolutions = new Map();
  return offerings.map((offering) => {
    const id = normalizeCanonicalId(offering.id);
    if (!resolutions.has(id)) {
      const lookupId = openWeightLookupId(id);
      resolutions.set(id, resolveOpenWeights({
        canonicalId: id,
        org: [...(orgsByCanonical.get(id) || [])],
        modelsDevRecords: modelsDevRecords.get(lookupId) || [],
        licenseFallback: modelLicenseIndex.get(lookupId) ?? null,
        overrides,
      }));
    }
    return { ...offering, ...resolutions.get(id) };
  });
}

/**
 * Resolve one canonical model's weight status, in priority order:
 * reviewed override → strict models.dev majority → known-closed creator-org
 * prior → unknown.
 *
 * A models.dev tie is not a majority and falls through only to a safe org prior.
 */
export function resolveOpenWeights({ canonicalId, org, modelsDevRecords = [], licenseFallback = null, overrides = {} }) {
  const id = normalizeCanonicalId(canonicalId);
  const lookupId = openWeightLookupId(id);
  const override = overrides[id] || overrides[lookupId];
  const overrideLicense = typeof override?.license === 'string' && override.license.trim()
    ? override.license.trim()
    : null;
  const license = overrideLicense
    ?? licenseFromRecords(modelsDevRecords)
    ?? (typeof licenseFallback === 'string' && licenseFallback.trim() ? licenseFallback.trim() : null);
  if (override && typeof override.open_weights === 'boolean') {
    return { open_weights: override.open_weights, open_weights_source: 'override', license };
  }

  let trueCount = 0;
  let falseCount = 0;
  for (const record of modelsDevRecords) {
    if (record?.open_weights === true) trueCount++;
    else if (record?.open_weights === false) falseCount++;
  }
  if (trueCount > falseCount) {
    return { open_weights: true, open_weights_source: 'modelsdev', license };
  }
  if (falseCount > trueCount) {
    return { open_weights: false, open_weights_source: 'modelsdev', license };
  }

  const orgs = (Array.isArray(org) ? org : [org])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase());
  const distinctOrgs = new Set(orgs);
  const prior = distinctOrgs.size === 1 ? ORG_PRIORS.get(orgs[0]) : undefined;
  if (prior !== undefined) {
    return { open_weights: prior, open_weights_source: 'org_prior', license };
  }
  return { open_weights: null, open_weights_source: null, license };
}
