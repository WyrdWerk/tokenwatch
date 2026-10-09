// Cloudflare Pages Functions — catch-all API route
// Serves pricing data with query filtering and sorting.
//
// Endpoints:
//   GET /api/v1/                              — API info + endpoint directory
//   GET /api/v1/stats                         — summary statistics (text models)
//   GET /api/v1/orgs                           — all orgs with model counts
//   GET /api/v1/providers[?zdr=true]          — provider metadata
//   GET /api/v1/use-cases                     — workload recommendation presets
//   GET /api/v1/recommend                     — workload-aware model shortlist
//   GET /api/v1/recommend/providers            — provider ranking for a model
//   GET /api/v1/models                         — list text models (with filters)
//   GET /api/v1/models/:canonicalId/providers  — all providers for a model, sorted by cost
//   GET /api/v1/models/:canonicalId/history    — daily cheapest-provider price history
//   GET /api/v1/images                         — list image models
//   GET /api/v1/images/:id                     — single image model with pricing variants
//   GET /api/v1/videos                         — list video models
//   GET /api/v1/videos/:id                     — single video model with pricing variants
//   OPTIONS *                                  — CORS preflight

import { canonicalId } from '../../../shared/normalize.mjs';
import { endpointDirectory } from '../../../shared/api-meta.mjs';
import { blendedRate } from '../../../shared/cost.mjs';
import { PRIORITY_PROVIDER_WEIGHTS, USE_CASES } from '../../../shared/use-cases.mjs';
import { isOpenWeightModel, rankProviders, shortlistModels } from '../../../shared/recommend.mjs';
import {
  MAX_HISTORY_DAYS,
  buildHistorySeries,
  capHistoryDays,
  parseDaysParam,
  parseMixParam,
  utcDay,
  windowStartDay,
} from '../../../shared/price-history.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'X-Robots-Tag': 'noindex',
};

function json(data, status = 200, { pretty = true } = {}) {
  return new Response(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

const PRIORITIES = new Set(Object.keys(PRIORITY_PROVIDER_WEIGHTS));

function parseOptionalBoolean(params, name) {
  if (!params.has(name)) return { ok: true, value: false };
  const value = params.get(name);
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return { ok: false, error: `${name} must be true or false` };
}

function parseRecommendationParams(params, { requireModel = false } = {}) {
  const useCase = params.get('use_case');
  if (!useCase || !Object.hasOwn(USE_CASES, useCase)) {
    return { ok: false, error: useCase ? `Unknown use_case: ${useCase}` : 'use_case is required', parameter: 'use_case' };
  }

  const priority = params.get('priority') ?? 'balanced';
  if (!PRIORITIES.has(priority)) {
    return { ok: false, error: `priority must be one of: ${[...PRIORITIES].join(', ')}`, parameter: 'priority' };
  }

  const detail = params.get('detail') ?? 'compact';
  if (detail !== 'compact' && detail !== 'full') {
    return { ok: false, error: 'detail must be compact or full', parameter: 'detail' };
  }

  let pretty = false;
  if (params.has('pretty')) {
    const value = params.get('pretty');
    if (value === '1' || value === 'true') pretty = true;
    else if (value !== '0' && value !== 'false') {
      return { ok: false, error: 'pretty must be 1, 0, true, or false', parameter: 'pretty' };
    }
  }

  let limit = 10;
  if (params.has('limit')) {
    const value = params.get('limit');
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 100) {
      return { ok: false, error: 'limit must be an integer between 1 and 100', parameter: 'limit' };
    }
    limit = Number(value);
  }

  const zdr = parseOptionalBoolean(params, 'zdr');
  if (!zdr.ok) return { ...zdr, parameter: 'zdr' };
  const includeProprietary = parseOptionalBoolean(params, 'include_proprietary');
  if (!includeProprietary.ok) return { ...includeProprietary, parameter: 'include_proprietary' };

  let excludeHQ = [];
  if (params.has('exclude_hq')) {
    const value = params.get('exclude_hq');
    if (!value || !/^[a-z]{2}(?:,[a-z]{2})*$/i.test(value)) {
      return { ok: false, error: 'exclude_hq must be a comma-separated list of two-letter country codes', parameter: 'exclude_hq' };
    }
    excludeHQ = [...new Set(value.split(',').map((country) => country.toUpperCase()))];
  }

  let model = null;
  if (requireModel) {
    model = params.get('model')?.trim() || null;
    if (!model) return { ok: false, error: 'model is required', parameter: 'model' };
  }

  return {
    ok: true,
    useCase,
    priority,
    detail,
    pretty,
    limit,
    requireZdr: zdr.value,
    includeProprietary: includeProprietary.value,
    excludeHQ,
    model,
  };
}

async function loadRecommendationAssets(context) {
  const { request, env } = context;
  const load = async (filename) => {
    const response = await env.ASSETS.fetch(new URL(`/${filename}`, request.url));
    if (!response.ok) throw new Error(`${filename} not found: ${response.status}`);
    return response.json();
  };
  try {
    const [benchmarks, performance] = await Promise.all([
      load('benchmarks.json'),
      load('performance.json'),
    ]);
    return { ok: true, benchmarks, performance };
  } catch (error) {
    return { ok: false, response: json({ error: 'Failed to load recommendation data', detail: error.message }, 503) };
  }
}

function compactRecommendationOffering(offering) {
  if (!offering) return null;
  return {
    id: offering.id,
    provider: offering.provider,
    name: offering.name ?? null,
    pricing: offering.pricing ?? null,
    context_length: offering.context_length ?? null,
    max_prompt_tokens: offering.max_prompt_tokens ?? null,
    max_completion_tokens: offering.max_completion_tokens ?? null,
    quantization: offering.quantization ?? null,
    zdr: offering.zdr === true,
    subscription: offering.subscription === true,
  };
}

function compactRecommendationProvider(provider, includeExplanation = true) {
  if (!provider) return null;
  const { explanation, ...summary } = provider;
  return {
    ...summary,
    ...(includeExplanation && explanation ? { explanation } : {}),
    offering: compactRecommendationOffering(provider.offering),
  };
}

function compactRecommendationCandidate(candidate, includeProviderExplanations = true) {
  return {
    ...candidate,
    recommendedProvider: compactRecommendationProvider(candidate.recommendedProvider, includeProviderExplanations),
    cheapestProvider: compactRecommendationProvider(candidate.cheapestProvider, includeProviderExplanations),
    offering: compactRecommendationOffering(candidate.offering),
    cheapestOffering: compactRecommendationOffering(candidate.cheapestOffering),
    unverifiedProviders: (candidate.unverifiedProviders || []).map((provider) =>
      includeProviderExplanations ? compactRecommendationProvider(provider, true) : compactUnverifiedProviderRow(provider)),
    ...(Array.isArray(candidate.providers)
      ? { providers: includeProviderExplanations ? candidate.providers : candidate.providers.map(compactProviderRow) }
      : {}),
  };
}

function compactRecommendationPreference(preference) {
  if (!preference) return null;
  const favorite = preference.favorite;
  return {
    field: preference.field,
    label: preference.label,
    board: preference.board,
    source: preference.source,
    favorite: favorite ? {
      id: favorite.id,
      name: favorite.name,
      rank: favorite.rank,
      rating: favorite.rating,
      providers: (favorite.providers || []).map(compactProviderRow),
    } : null,
    ranking: preference.ranking,
  };
}

function compactRecommendationRow(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    score: candidate.qualityScore ?? null,
    coverage: candidate.qualityCoverage ?? null,
    blendedRate: candidate.blendedRate ?? null,
    reason: candidate.reasons?.[0] ?? candidate.unknowns?.[0] ?? null,
  };
}

function compactProviderRow(provider) {
  const reason = provider.reasons?.find((item) => /lowest blended price|lowest .*ttft|highest throughput|reported uptime|only qualifying option|subscription plan|low-bit quantization/i.test(item));
  return {
    provider: provider.provider,
    name: provider.offering?.provider_display || provider.provider,
    score: provider.score ?? null,
    blendedRate: provider.blendedRate ?? null,
    confidence: provider.confidence?.level ?? null,
    reason: reason ?? provider.reasons?.[0] ?? provider.unknowns?.[0] ?? null,
  };
}

function compactUnverifiedProviderRow(provider) {
  return {
    provider: provider.provider,
    offeringId: provider.offering?.id ?? null,
    blendedRate: provider.blendedRate ?? null,
    reason: provider.unknowns?.[0] ?? provider.reasons?.[0] ?? null,
  };
}

function recommendationGroup(items, parsed, compactRow) {
  return {
    totalCount: items.length,
    items: items.slice(0, parsed.limit).map((item) => parsed.detail === 'full' ? item : compactRow(item)),
  };
}

function providerGroup(items, parsed, { explainTopThree = false } = {}) {
  return {
    totalCount: items.length,
    items: items.slice(0, parsed.limit).map((item, index) =>
      parsed.detail === 'full' || (explainTopThree && index < 3) ? item : compactProviderRow(item)),
  };
}

function recommendationConstraints(parsed, pricing) {
  return {
    priority: parsed.priority,
    requireZdr: parsed.requireZdr,
    excludeHQ: parsed.excludeHQ,
    providersMeta: pricing.providers_meta || {},
  };
}

// ── Canonical ID normalization ────────────────────────────────────────────────
// canonicalId is imported from shared/normalize.mjs — the same source of truth
// the Node pipeline uses. This replaces the former local normalizeId, which had
// a greedy -preview-.*$ catch-all that over-stripped -preview-customtools and
// caused distinct models (e.g. gemini-3.1-pro vs gemini-3.1-pro-preview-customtools)
// to collide in /models/:id/providers.

// ── Pagination helper ─────────────────────────────────────────────────────────

function paginate(arr, params) {
  // Clamp user input: limit ∈ [1,500], offset ≥ 0. Non-numeric, zero, or negative
  // values fall back to the defaults — a negative offset would silently slice
  // from the END of the array and a negative limit would drop trailing rows.
  const requestedLimit = parseInt(params.get('limit'), 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 500)
    : 100;
  const requestedOffset = parseInt(params.get('offset'), 10);
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
  const total = arr.length;
  const paged = arr.slice(offset, offset + limit);
  return { total, offset, limit, paged };
}

// ── Price history ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/models/:canonicalId/history?days=90&mix=2.5,97,0.5
 *
 * Reads raw USD-per-million snapshot rows and blends them at read time, so the
 * stored history is independent of any visitor's token mix.
 *
 * Contract:
 *   - `mix` defaults to the agentic mix (2.5/97/0.5) and is validated; a mix
 *     that does not sum to 100, or a `days` outside [1, 90], is a 400.
 *   - Each returned point is the cheapest offering that day for the requested
 *     mix. A day where nothing can be priced is absent — never $0.
 *   - `series` carries every offering for the day so a chart can show a
 *     provider switch without a second request.
 *   - At most 90 points, chronologically ascending (oldest → newest).
 *   - `cache_read: null` falls back to the offering's INPUT price (the same
 *     semantics as /providers and the calculator) rather than disqualifying it.
 */
async function historyResponse(context, pricing, rawId) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;

  if (!rawId) return json({ error: 'Not found' }, 404); // "models/history"

  let requestedId;
  try {
    requestedId = decodeURIComponent(rawId);
  } catch {
    return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
  }

  const mixParam = parseMixParam(params.get('mix'));
  if (!mixParam.ok) return json({ error: mixParam.error, parameter: 'mix' }, 400);
  const daysParam = parseDaysParam(params.get('days'));
  if (!daysParam.ok) return json({ error: daysParam.error, parameter: 'days' }, 400);
  const mix = mixParam.mix;
  const days = daysParam.days;

  const target = canonicalId(requestedId);
  const known = pricing.models.some((m) => canonicalId(m.id) === target);
  if (!known) {
    return json({ error: 'Model not found', canonical_id: requestedId }, 404);
  }

  const db = env?.PRICE_HISTORY;
  if (!db) {
    // Local dev without the D1 binding, or a deployment missing it. Fail
    // loudly with a 503 rather than pretending the model has no history.
    return json({
      error: 'Price history is not configured',
      detail: 'The PRICE_HISTORY D1 binding is unavailable in this environment',
    }, 503);
  }

  const today = utcDay(new Date());
  const startDay = windowStartDay(today, days);

  let rows;
  try {
    const result = await db
      .prepare(
        `SELECT utc_day, offering_key, provider, model_id, quantization,
                input_price, output_price, cache_read, cache_write, input_billing, discount
           FROM price_snapshot
          WHERE canonical_model = ? AND utc_day >= ? AND utc_day <= ?
          ORDER BY utc_day ASC`,
      )
      .bind(target, startDay, today)
      .all();
    rows = result?.results ?? [];
  } catch (err) {
    return json({ error: 'Failed to read price history', detail: err.message }, 503);
  }

  const allDays = buildHistorySeries(rows, mix);
  const points = capHistoryDays(allDays, MAX_HISTORY_DAYS);
  const providerChanges = points.reduce(
    (count, entry, index) => count + (index > 0 && entry.point.provider !== points[index - 1].point.provider ? 1 : 0),
    0,
  );

  return json({
    canonical_id: target,
    days,
    mix: { input: mix.inputPct, cache_read: mix.cacheReadPct, output: mix.outputPct },
    from: startDay,
    to: today,
    point_count: points.length,
    provider_switches: providerChanges,
    points: points.map((entry) => entry.point),
    series: points.map((entry) => ({ day: entry.day, offerings: entry.series })),
  });
}

// ── Main router ───────────────────────────────────────────────────────────────

function useCasesResponse(pricing) {
  const use_cases = Object.values(USE_CASES).map((useCase) => ({
    id: useCase.id,
    label: useCase.label,
    mix: { ...useCase.mix, assumed: true },
    weights: {
      benchmark: { ...useCase.benchmarkWeights },
      provider: { ...useCase.providerWeights },
    },
    requirements: { ...useCase.hardRequirements },
    quantizationPolicy: { ...useCase.quantizationPolicy, reject: [...useCase.quantizationPolicy.reject] },
    floors: { ...useCase.qualityFloor },
  }));
  return json({ generated_at: pricing.generated_at, use_cases });
}

async function recommendationResponse(context, pricing, providersOnly) {
  const { request } = context;
  const params = new URL(request.url).searchParams;
  const parsed = parseRecommendationParams(params, { requireModel: providersOnly });
  if (!parsed.ok) return json({ error: parsed.error, parameter: parsed.parameter }, 400);

  const target = providersOnly ? canonicalId(parsed.model) : null;
  if (target && !pricing.models.some((model) => canonicalId(String(model.id)) === target)) {
    return json({ error: 'Model not found', canonical_id: parsed.model }, 404);
  }

  const assets = await loadRecommendationAssets(context);
  if (!assets.ok) return assets.response;

  const constraints = recommendationConstraints(parsed, pricing);
  const timestamps = {
    generated_at: pricing.generated_at,
    benchmarks_generated_at: assets.benchmarks.generated_at ?? null,
    performance_generated_at: assets.performance._meta?.generated_at ?? null,
  };

  if (providersOnly) {
    const offerings = pricing.models.filter((model) =>
      canonicalId(String(model.id)) === target
      && (parsed.includeProprietary || isOpenWeightModel(model)));
    const result = rankProviders(parsed.useCase, target, offerings, assets.performance, constraints);
    return json({
      ...timestamps,
      useCase: parsed.useCase,
      priority: parsed.priority,
      mix: { ...USE_CASES[parsed.useCase].mix, assumed: true },
      canonical_id: target,
      ranked: providerGroup(result.ranked, parsed, { explainTopThree: true }),
      unverified: {
        totalCount: result.unverified.length,
        items: result.unverified.slice(0, parsed.limit).map((item) => parsed.detail === 'full' ? item : compactUnverifiedProviderRow(item)),
      },
      message: result.message,
    }, 200, { pretty: parsed.pretty });
  }

  const result = shortlistModels(parsed.useCase, pricing.models, {
    benchmarks: assets.benchmarks,
    performance: assets.performance,
    includeProprietary: parsed.includeProprietary,
    constraints,
  });
  const selectedIds = new Set([
    result.bestQuality?.id,
    result.bestValue?.id,
    result.cheapestAboveFloor?.id,
  ].filter(Boolean));
  const alsoConsideredById = new Map();
  for (const candidate of [...result.paretoFrontier, ...result.qualityRanking]) {
    if (!selectedIds.has(candidate.id)) alsoConsideredById.set(candidate.id, candidate);
  }

  return json({
    ...timestamps,
    useCase: result.useCase,
    priority: result.priority,
    mix: { ...USE_CASES[result.useCase].mix, assumed: true },
    qualityFloor: result.qualityFloor,
    preference: compactRecommendationPreference(result.preference),
    picks: {
      bestQuality: result.bestQuality ? compactRecommendationCandidate(result.bestQuality, parsed.detail === 'full') : null,
      bestValue: result.bestValue ? compactRecommendationCandidate(result.bestValue, parsed.detail === 'full') : null,
      cheapestAboveFloor: result.cheapestAboveFloor ? compactRecommendationCandidate(result.cheapestAboveFloor, parsed.detail === 'full') : null,
    },
    alsoConsidered: recommendationGroup([...alsoConsideredById.values()], parsed, compactRecommendationRow),
    partiallyBenchmarked: recommendationGroup(result.partiallyBenchmarked, parsed, compactRecommendationRow),
    unbenchmarked: recommendationGroup(result.unbenchmarked, parsed, compactRecommendationRow),
    unverified: recommendationGroup(result.unverified, parsed, compactRecommendationRow),
  }, 200, { pretty: parsed.pretty });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v1/, '').replace(/^\//, '');
  const params = url.searchParams;

  // Load pricing.json from static assets
  let pricing;
  try {
    const res = await env.ASSETS.fetch(new URL('/pricing.json', request.url));
    if (!res.ok) throw new Error(`pricing.json not found: ${res.status}`);
    pricing = await res.json();
  } catch (err) {
    return json({ error: 'Failed to load pricing data', detail: err.message }, 503);
  }

  // ── Route: /api/v1/ (empty path) → API info ──
  if (!path || path === '') {
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: [...new Set(pricing.models.map(m => m.provider))].length,
      source_count: pricing.providers.length,
      endpoints: endpointDirectory(),
    });
  }

  // ── Route: /api/v1/stats ──
  if (path === 'stats') {
    const providers = {};
    const orgs = {};
    const quantizations = {};
    let zdrCount = 0, subCount = 0;
    let cacheReadCount = 0, cacheWriteCount = 0;
    for (const m of pricing.models) {
      providers[m.provider] = (providers[m.provider] || 0) + 1;
      orgs[m.org] = (orgs[m.org] || 0) + 1;
      if (m.zdr) zdrCount++;
      if (m.subscription) subCount++;
      if (m.pricing?.cache_read != null) cacheReadCount++;
      if (m.pricing?.cache_write != null) cacheWriteCount++;
      const q = m.quantization || 'unknown';
      quantizations[q] = (quantizations[q] || 0) + 1;
    }
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: Object.keys(providers).length,
      org_count: Object.keys(orgs).length,
      zdr_count: zdrCount,
      subscription_count: subCount,
      cache_read_count: cacheReadCount,
      cache_write_count: cacheWriteCount,
      providers,
      orgs,
      quantizations,
      source_providers: pricing.providers,
    });
  }

  // ── Route: /api/v1/orgs ──
  if (path === 'orgs') {
    const orgs = {};
    for (const m of pricing.models) {
      orgs[m.org] = (orgs[m.org] || 0) + 1;
    }
    const sorted = Object.entries(orgs)
      .sort(([, a], [, b]) => b - a)
      .map(([org, count]) => ({ org, model_count: count }));
    return json({
      generated_at: pricing.generated_at,
      org_count: sorted.length,
      orgs: sorted,
    });
  }

  // ── Route: /api/v1/providers[?zdr=true] ──
  if (path === 'providers') {
    let meta = pricing.providers_meta || {};
    const zdrOnly = params.get('zdr') === 'true';
    if (zdrOnly) {
      const filtered = {};
      for (const [key, val] of Object.entries(meta)) {
        if (val.retains_prompts === false) filtered[key] = val;
      }
      meta = filtered;
    }
    return json({
      generated_at: pricing.generated_at,
      provider_count: Object.keys(meta).length,
      providers_meta: meta,
    });
  }

  // ── Workload-aware model and provider recommendations ──
  if (path === 'use-cases') return useCasesResponse(pricing);
  if (path === 'recommend') return recommendationResponse(context, pricing, false);
  if (path === 'recommend/providers') return recommendationResponse(context, pricing, true);

  // ── Route: /api/v1/models[/:canonicalId/providers|/:canonicalId/history] ──
  if (path === 'models' || path.startsWith('models/')) {
    // 'models' → '' (list); 'models/<rest>' → '<rest>'
    const subPath = path === 'models' ? '' : path.replace(/^models\//, '');

    // /api/v1/models/:canonicalId/history — daily raw snapshots, blended at read
    // time with the requested visitor mix. Registered before the providers
    // branch so `models/<id>/history` is never mistaken for an unknown shape.
    if (subPath !== '' && subPath.endsWith('/history')) {
      return historyResponse(context, pricing, subPath.slice(0, -'/history'.length));
    }

    // /api/v1/models/:canonicalId/providers — id may itself contain slashes (org/model).
    // Only a non-empty suffix ending exactly in `/providers` is the detail route;
    // anything else (models/foo, models/foo/bar, models/providers) is NOT a valid
    // shape and must 404 rather than fall through to the list handler.
    if (subPath !== '' && subPath.endsWith('/providers')) {
      const rawId = subPath.slice(0, -'/providers'.length);
      if (!rawId) return json({ error: 'Not found', path }, 404); // "models/providers" (empty id)
      let requestedId;
      try {
        requestedId = decodeURIComponent(rawId);
      } catch {
        return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
      }
      const target = canonicalId(requestedId);
      const matches = pricing.models.filter(m => canonicalId(m.id) === target);

      if (matches.length === 0) {
        return json({ error: 'Model not found', canonical_id: requestedId }, 404);
      }

      // Sort by cost — use mix-aware cost if params provided, else input+output
      const reqTokens = parseFloat(params.get('tokens'));
      const reqMix = params.get('mix'); // 'inputPct,cachePct,outputPct'
      let sorted;
      if (reqTokens > 0 && reqMix) {
        const parts = reqMix.split(',').map(parseFloat);
        const inputPct = parts[0] || 0, cachePct = parts[1] || 0, outputPct = parts[2] || 0;
        const costFn = (m) => {
          const rate = blendedRate(m.pricing, { inputPct, cacheReadPct: cachePct, outputPct });
          return rate == null ? Infinity : rate * reqTokens;
        };
        sorted = matches.sort((a, b) => costFn(a) - costFn(b));
      } else {
        sorted = matches.sort((a, b) => {
          const costA = (a.pricing.input || 0) + (a.pricing.output || 0);
          const costB = (b.pricing.input || 0) + (b.pricing.output || 0);
          return costA - costB;
        });
      }

      return json({
        canonical_id: target,
        model_count: sorted.length,
        providers: sorted.map(m => ({
          provider: m.provider,
          provider_display: m.provider_display,
          quantization: m.quantization,
          discount: m.discount,
          zdr: m.zdr || false,
          subscription: m.subscription || false,
          context_length: m.context_length,
          max_completion_tokens: m.max_completion_tokens,
          uptime_30m: m.uptime_30m,
          uptime_1d: m.uptime_1d ?? null,
          open_weights: typeof m.open_weights === 'boolean' ? m.open_weights : null,
          open_weights_source: m.open_weights_source ?? null,
          license: m.license ?? null,
          supported_parameters: m.supported_parameters ?? null,
          supports_tool_choice: m.supports_tool_choice ?? null,
          supports_implicit_caching: m.supports_implicit_caching ?? null,
          max_prompt_tokens: m.max_prompt_tokens ?? null,
          pricing: m.pricing,
        })),
      });
    }

    // List route: only an empty subPath (`models` or `models/`). Reject every other
    // non-empty shape not handled by the detail route above — covers models/foo,
    // models/foo/bar, models/providers, and models/models.
    if (subPath !== '') return json({ error: 'Not found', path }, 404);

    // /api/v1/models — list with filters
    let models = pricing.models;

    // Filters
    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const minContext = parseInt(params.get('min_context'), 10);
    if (minContext) models = models.filter(m => m.context_length && m.context_length >= minContext);

    const minOutput = parseInt(params.get('min_output'), 10);
    if (minOutput) models = models.filter(m => m.max_completion_tokens && m.max_completion_tokens >= minOutput);

    if (params.has('min_intelligence')) {
      const minIntelligence = Number(params.get('min_intelligence'));
      if (Number.isFinite(minIntelligence) && minIntelligence > 0) models = models.filter(m => m.benchmarks?.intelligence_index != null && m.benchmarks.intelligence_index >= minIntelligence);
    }

    const quantization = params.get('quantization');
    if (quantization) models = models.filter(m => (m.quantization || 'unknown') === quantization.toLowerCase());

    const openWeights = params.get('open_weights');
    if (openWeights === 'true') models = models.filter(m => m.open_weights === true);
    if (openWeights === 'false') models = models.filter(m => m.open_weights === false);

    if (params.get('cache_read') === 'true') models = models.filter(m => m.pricing?.cache_read != null);
    if (params.get('cache_write') === 'true') models = models.filter(m => m.pricing?.cache_write != null);

    const promo = params.get('promo');
    if (promo === 'true') models = models.filter(m => m.discount > 0);
    const zdr = params.get('zdr');
    if (zdr === 'true') models = models.filter(m => m.zdr === true);
    const sub = params.get('sub');
    if (sub === 'true') models = models.filter(m => m.subscription === true);
    const benchmarked = params.get('benchmarked');
    if (benchmarked === 'true') models = models.filter(m => !!m.benchmarks);

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const sort = params.get('sort') || 'id';
    const validSorts = ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'];
    const sortKey = validSorts.includes(sort) ? sort : 'id';
    const order = params.get('order') === 'desc' ? -1 : 1;
    models = [...models].sort((a, b) => {
      let va, vb;
      if (sortKey === 'id') { va = a.id.toLowerCase(); vb = b.id.toLowerCase(); }
      else if (sortKey === 'context') { va = a.context_length; vb = b.context_length; }
      else if (sortKey === 'max_output') { va = a.max_completion_tokens; vb = b.max_completion_tokens; }
      else if (sortKey === 'uptime') { va = a.uptime_30m; vb = b.uptime_30m; }
      else if (sortKey === 'intelligence') { va = a.benchmarks?.intelligence_index; vb = b.benchmarks?.intelligence_index; }
      else if (sortKey === 'coding') { va = a.benchmarks?.coding_index; vb = b.benchmarks?.coding_index; }
      else if (sortKey === 'agentic') { va = a.benchmarks?.agentic_index; vb = b.benchmarks?.agentic_index; }
      else { va = a.pricing[sortKey]; vb = b.pricing[sortKey]; }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    // Pagination
    const { total, offset, limit, paged } = paginate(models, params);

    return json({
      generated_at: pricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // ── Route: /api/v1/images[/:id] ──
  if (path === 'images' || path.startsWith('images/')) {
    let imagePricing;
    try {
      const res = await env.ASSETS.fetch(new URL('/image-pricing.json', request.url));
      if (!res.ok) throw new Error(`image-pricing.json not found: ${res.status}`);
      imagePricing = await res.json();
    } catch (err) {
      return json({ error: 'Failed to load image pricing data', detail: err.message }, 503);
    }

    const subPath = path.replace(/^images\//, '');

    // /api/v1/images/:id — single model (accepts org/model or bare canonical id)
    if (path.startsWith('images/') && subPath) {
      let requestedId;
      try {
        requestedId = decodeURIComponent(subPath);
      } catch {
        return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
      }
      const target = canonicalId(requestedId);
      const model = imagePricing.models.find(m => canonicalId(m.id) === target);
      if (!model) {
        return json({ error: 'Image model not found', id: subPath }, 404);
      }
      return json({
        generated_at: imagePricing.generated_at,
        model,
      });
    }

    // /api/v1/images — list with filters
    let models = imagePricing.models;

    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const sort = params.get('sort') || 'id';
    const validSorts = ['id', 'org', 'provider'];
    const sortKey = validSorts.includes(sort) ? sort : 'id';
    const order = params.get('order') === 'desc' ? -1 : 1;
    models = [...models].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    const { total, offset, limit, paged } = paginate(models, params);

    return json({
      generated_at: imagePricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // ── Route: /api/v1/videos[/:id] ──
  if (path === 'videos' || path.startsWith('videos/')) {
    let videoPricing;
    try {
      const res = await env.ASSETS.fetch(new URL('/video-pricing.json', request.url));
      if (!res.ok) throw new Error(`video-pricing.json not found: ${res.status}`);
      videoPricing = await res.json();
    } catch (err) {
      return json({ error: 'Failed to load video pricing data', detail: err.message }, 503);
    }

    const subPath = path.replace(/^videos\//, '');

    // /api/v1/videos/:id — single model (accepts org/model or bare canonical id)
    if (path.startsWith('videos/') && subPath) {
      let requestedId;
      try {
        requestedId = decodeURIComponent(subPath);
      } catch {
        return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
      }
      const target = canonicalId(requestedId);
      const model = videoPricing.models.find(m => canonicalId(m.id) === target);
      if (!model) {
        return json({ error: 'Video model not found', id: subPath }, 404);
      }
      return json({
        generated_at: videoPricing.generated_at,
        model,
      });
    }

    // /api/v1/videos — list with filters
    let models = videoPricing.models;

    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const sort = params.get('sort') || 'id';
    const validSorts = ['id', 'org', 'provider'];
    const sortKey = validSorts.includes(sort) ? sort : 'id';
    const order = params.get('order') === 'desc' ? -1 : 1;
    models = [...models].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    const { total, offset, limit, paged } = paginate(models, params);

    return json({
      generated_at: videoPricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // Unknown route
  return json({ error: 'Not found', path }, 404);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
