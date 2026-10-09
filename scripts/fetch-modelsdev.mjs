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
import { fetchJson, MODELSDEV_PROVIDER_TARGETS, normalizeForMatch, normalizeContextTiers } from './lib.mjs';
import { openWeightLookupId } from '../shared/open-weights.mjs';

const MODELSDEV_URL = 'https://models.dev/api.json';
const MODELSDEV_MODELS_URL = 'https://models.dev/models.json';

// Reverse map: models.dev provider_id → TW provider slug.
// Single source of truth is shared/modelsdev.mjs: PROVIDER_MAP (1:1) plus
// EXTRA_PROVIDER_ALIASES, combined into md provider_id → [TW slugs].
const PROVIDER_TARGETS = new Map(Object.entries(MODELSDEV_PROVIDER_TARGETS));

/** models.dev reasoning_options → [{ type, values? }] (sanitized), [] or null. */
function normalizeReasoningOptions(options) {
  if (!Array.isArray(options)) return null;
  return options
    .filter((o) => o && typeof o.type === 'string' && o.type.trim())
    .map((o) => {
      const values = Array.isArray(o.values) ? o.values.filter((v) => typeof v === 'string' && v.trim()) : null;
      return values && values.length ? { type: o.type, values } : { type: o.type };
    });
}

const positiveInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const LIFECYCLE_STATUSES = new Set(['deprecated', 'beta', 'alpha']);

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
    const twKeys = PROVIDER_TARGETS.get(mdPid);
    if (!twKeys) continue; // provider not in TW — skip
    if (!p.models) continue;
    for (const twKey of twKeys) for (const [mdMid, m] of Object.entries(p.models)) {
      modelCount++;
      const normalized = normalizeForMatch(twKey, mdMid);
      if (!normalized) continue;
      if (!index.has(twKey)) index.set(twKey, new Map());
      const existing = index.get(twKey).get(normalized);
      const cost = m.cost || {};
      const limit = m.limit || {};
      const baseUrl = (p.api && !p.api.includes('${')) ? p.api : null;
      const docUrl = p.doc || null;
      const record = {
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
        // Internal (not copied verbatim to rows): base tariff for the
        // context-tier guard and the price-drift report.
        cost_input: Number.isFinite(cost.input) ? cost.input : null,
        cost_output: Number.isFinite(cost.output) ? cost.output : null,
        context_tiers: normalizeContextTiers(cost),
        max_input: positiveInt(limit.input),
        status: LIFECYCLE_STATUSES.has(m.status) ? m.status : null,
        reasoning_options: normalizeReasoningOptions(m.reasoning_options),
        interleaved_reasoning: m.interleaved ? true : null,
      };
      if (existing) {
        // Several md ids collapse to one key (canonicalId strips dates and
        // -preview). The first record stays primary (unchanged behaviour);
        // every candidate is kept so findEnrichment can pick the one whose
        // raw id equals the TokenWatch id.
        (existing.alternates ||= [{ ...existing }]).push(record);
        continue;
      }
      index.get(twKey).set(normalized, record);
      indexedCount++;
    }
  }
  console.log(`  [modelsdev] Indexed ${indexedCount} of ${modelCount} models across ${index.size} TW providers`);
  return index;
}

/**
 * TW provider slug → { setup_env, ai_sdk_package } from models.dev provider
 * records. `setup_env` is every env var the provider needs (API key plus e.g.
 * an account id), unordered; names must look like shell variables.
 */
export function buildProviderSetupIndex(apiData) {
  const index = new Map();
  for (const [mdPid, p] of Object.entries(apiData || {})) {
    const twKeys = PROVIDER_TARGETS.get(mdPid);
    if (!twKeys || !p) continue;
    const env = Array.isArray(p.env) ? p.env.filter((v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(v)) : [];
    const npm = typeof p.npm === 'string' && /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(p.npm) ? p.npm : null;
    if (!env.length && !npm) continue;
    for (const twKey of twKeys) {
      if (!index.has(twKey)) index.set(twKey, { setup_env: env.length ? env : null, ai_sdk_package: npm });
    }
  }
  return index;
}

const DRIFT_CLASS_LABELS = {
  mismatch: 'Unexplained mismatch',
  promo_unexplained: 'Promo row, still differs after undoing the discount',
  promo_explained: 'OpenRouter promo (list price matches models.dev)',
  tier_explained: 'Matches a models.dev context tier',
  fuzzy_mismatch: 'Differs, but matched by fuzzy id (may be another SKU)',
};

const fmtPrice = (v) => (Number.isFinite(v) ? `$${Number(v.toPrecision(4))}` : '—');
const fmtRatio = (r) => (r === Infinity ? '×∞' : `×${r.toFixed(2)}`);

/**
 * Render a modelsDevPriceDrift() result as console lines and a GitHub step
 * summary (markdown). Lists only the unexplained classes, largest gap first.
 */
export function formatPriceDriftReport(drift, { limit = 25 } = {}) {
  const { checked, counts, rows } = drift;
  const unexplained = rows.filter((r) => r.class === 'mismatch' || r.class === 'promo_unexplained');
  const bySource = {};
  for (const r of unexplained) bySource[r.source || 'unknown'] = (bySource[r.source || 'unknown'] || 0) + 1;
  const sourceText = Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  const describe = (r) => `${r.provider}/${r.id} [${r.source || 'unknown'}${r.match === 'fuzzy' ? ', fuzzy match' : ''}${r.discount ? `, ${Math.round(r.discount * 100)}% promo` : ''}]`
    + ` TW ${fmtPrice(r.tw.input)}/${fmtPrice(r.tw.output)} vs models.dev ${fmtPrice(r.md.input)}/${fmtPrice(r.md.output)} (${fmtRatio(r.ratio)})`;
  const consoleLines = [
    `  models.dev price check (same provider + model, report only): ${checked} compared — match ${counts.match}, `
      + `promo explained ${counts.promo_explained}, tier explained ${counts.tier_explained}, `
      + `promo unexplained ${counts.promo_unexplained}, mismatch ${counts.mismatch}, fuzzy-match mismatch ${counts.fuzzy_mismatch} (unexplained by source: ${sourceText})`,
    ...unexplained.slice(0, 5).map((r) => `    ${describe(r)}`),
  ];
  if (unexplained.length > 5) consoleLines.push(`    ... ${unexplained.length - 5} more`);
  const esc = (v) => String(v).replace(/[|\r\n]/g, ' ');
  const markdown = [
    '### models.dev price check',
    '',
    `Compared ${checked} offerings against models.dev for the **same provider and model**. `
      + 'OpenRouter promos are undone before comparing; `:batch` rows are skipped. Report only — no price was changed.',
    '',
    '| Class | Count |',
    '|---|---|',
    `| Match | ${counts.match} |`,
    ...Object.entries(DRIFT_CLASS_LABELS).map(([k, label]) => `| ${label} | ${counts[k]} |`),
    '',
    ...(unexplained.length ? [
      `Unexplained by source: ${sourceText}. Largest gaps first${unexplained.length > limit ? ` (top ${limit} of ${unexplained.length})` : ''}:`,
      '',
      '| Provider | Model | Source | TokenWatch in/out | models.dev in/out | Ratio |',
      '|---|---|---|---|---|---|',
      ...unexplained.slice(0, limit).map((r) => `| ${esc(r.provider)} | ${esc(r.id)} | ${esc(r.source || 'unknown')}${r.match === 'fuzzy' ? ' (fuzzy)' : ''}${r.discount ? ` (${Math.round(r.discount * 100)}% promo)` : ''} | `
        + `${fmtPrice(r.tw.input)} / ${fmtPrice(r.tw.output)} | ${fmtPrice(r.md.input)} / ${fmtPrice(r.md.output)} | ${fmtRatio(r.ratio)} |`),
    ] : ['No unexplained differences.']),
    '',
  ].join('\n');
  return { consoleLines, markdown };
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
      providerSetupIndex: buildProviderSetupIndex(providerData),
    };
  } catch (err) {
    console.warn(`⚠ models.dev fetch failed — continuing without enrichment: ${err.message}`);
    return {
      enrichmentIndex: new Map(),
      openWeightIndex: new Map(),
      modelLicenseIndex: new Map(),
      providerSetupIndex: new Map(),
    };
  }
}

/** Backwards-compatible enrichment-only accessor. */
export async function fetchModelsDevEnrichment() {
  return (await fetchModelsDevIndexes()).enrichmentIndex;
}
