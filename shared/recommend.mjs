/**
 * Pure, Worker-safe recommendation logic for model and provider selection.
 * Benchmark percentiles and provider scores are catalog-relative, while each
 * quality floor is absolute. Prices always come from shared/cost.mjs so this
 * uses the same billing estimate as TokenWatch.
 */

import { blendedRate } from './cost.mjs';
import { canonicalId, quantFromId } from './normalize.mjs';
import { getUseCase, resolveProviderWeights } from './use-cases.mjs';

const BENCHMARK_FIELDS = new Set([
  'intelligence_index', 'coding_index', 'agentic_index', 'design_arena_best',
  'livebench_math', 'livebench_coding', 'livebench_language',
  'livebench_data_analysis', 'livebench_agentic_coding',
  'livebench_reasoning', 'livebench_instruction_following',
]);

const LOW_BIT_TOKENS = ['fp4', 'nvfp4', 'mxfp4', 'int4'];
const BLOCKING_ISSUES = new Set(['broken', 'unavailable']);
const PROVIDER_METRICS = ['price', 'ttft', 'throughput', 'uptime'];

function modelsFrom(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.models)) return catalog.models;
  return [];
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteNonNegative(value) {
  return finite(value) && value >= 0;
}

function normalizedWeights(weights, label) {
  const entries = Object.entries(weights || {});
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!entries.length || entries.some(([, weight]) => !finiteNonNegative(weight)) || total <= 0) {
    throw new RangeError(`${label} must contain non-negative finite weights with a positive total`);
  }
  return Object.fromEntries(entries.map(([field, weight]) => [field, weight / total]));
}

function effectiveUseCase(useCaseId, options = {}) {
  const base = getUseCase(useCaseId);
  const scenario = options.scenario || {};
  const priority = options.priority ?? 'balanced';
  const priorityProviderWeights = resolveProviderWeights(base, priority);
  const mix = scenario.mix ?? base.mix;
  const mixTotal = mix.inputPct + mix.cacheReadPct + mix.outputPct;
  if (![mix.inputPct, mix.cacheReadPct, mix.outputPct].every(finiteNonNegative) || Math.abs(mixTotal - 100) > 1e-9) {
    throw new RangeError('scenario.mix percentages must be finite, non-negative, and sum to 100');
  }
  return {
    ...base,
    priority,
    mix: { ...mix },
    benchmarkWeights: normalizedWeights(scenario.benchmarkWeights ?? base.benchmarkWeights, 'benchmark weights'),
    providerWeights: normalizedWeights(scenario.providerWeights ?? priorityProviderWeights, 'provider weights'),
    qualityFloor: { ...(scenario.qualityFloor ?? base.qualityFloor) },
  };
}

function openWeightInfo(model) {
  if (Object.hasOwn(model || {}, 'open_weights')) {
    const value = model.open_weights === true || model.open_weights === false ? model.open_weights : null;
    return {
      value,
      source: model.open_weights_source || (value === null ? null : 'catalog'),
    };
  }
  if (model?.modelsdev?.open_weights === true || model?.modelsdev?.open_weights === false) {
    return {
      value: model.modelsdev.open_weights,
      source: model.modelsdev.open_weights_source || model.modelsdev.source || 'models.dev',
    };
  }
  return { value: null, source: null };
}

/** Return true only when the catalog has a confirmed open-weight status. */
export function isOpenWeightModel(model) {
  return openWeightInfo(model).value === true;
}

function capabilityValue(model, capability) {
  const parameters = model?.supported_parameters;
  if (Array.isArray(parameters)) {
    if (capability === 'tool_call') return parameters.includes('tools');
    return parameters.includes('response_format') || parameters.includes('structured_outputs');
  }
  if (parameters !== null && parameters !== undefined) return null;

  const modelDevValue = capability === 'tool_call'
    ? (model?.modelsdev?.tool_call ?? model?.modelsdev?.capabilities?.tool_call)
    : (model?.modelsdev?.structured_output ?? model?.modelsdev?.capabilities?.structured_output);
  const modelDevModelValue = capability === 'tool_call'
    ? (model?.modelsdev_model?.tool_call ?? model?.modelsdev_model?.capabilities?.tool_call)
    : (model?.modelsdev_model?.structured_output ?? model?.modelsdev_model?.capabilities?.structured_output);
  const value = modelDevValue ?? modelDevModelValue;
  return value === true || value === false ? value : null;
}

function contextCapacity(model) {
  const prompt = finiteNonNegative(model?.max_prompt_tokens) ? model.max_prompt_tokens : null;
  const context = finiteNonNegative(model?.context_length) ? model.context_length : null;
  if (prompt !== null && context !== null) return Math.min(prompt, context);
  return prompt ?? context;
}

function assessHardRequirements(model, useCase) {
  const requirements = useCase.hardRequirements || {};
  const unknowns = [];
  if (requirements.needsToolCalling) {
    const toolCalling = capabilityValue(model, 'tool_call');
    if (toolCalling === false) return { blocked: true, unknowns };
    if (toolCalling === null) unknowns.push('Required tool-calling capability is unknown (tool-calling capability not disclosed).');
  }
  if (requirements.needsStructuredOutput) {
    const structuredOutput = capabilityValue(model, 'structured_output');
    if (structuredOutput === false) return { blocked: true, unknowns };
    if (structuredOutput === null) unknowns.push('Required structured-output capability is unknown (structured-output capability not disclosed).');
  }
  const minContext = requirements.minContext || 0;
  const capacity = contextCapacity(model);
  if (minContext > 0) {
    if (capacity === null) unknowns.push(`Prompt capacity is unknown; the ${minContext.toLocaleString()}-token minimum cannot be confirmed.`);
    else if (capacity < minContext) return { blocked: true, unknowns };
  }
  return { blocked: false, unknowns, capacity };
}

function quantizationOf(model) {
  const direct = typeof model?.quantization === 'string' ? model.quantization.trim().toLowerCase() : '';
  if (direct && direct !== 'unknown' && direct !== 'n/a' && direct !== 'none') return direct;
  const fromId = quantFromId(String(model?.id || ''));
  return fromId ? fromId.toLowerCase() : null;
}

function isRejectedQuantization(model, useCase) {
  const quantization = quantizationOf(model);
  const rejected = useCase.quantizationPolicy?.reject || [];
  if (!quantization || !rejected.length) return false;
  return rejected.some((tag) => {
    const normalized = String(tag).toLowerCase();
    return quantization === normalized || (LOW_BIT_TOKENS.includes(normalized) && quantization.includes(normalized));
  });
}

function applyQuantizationPolicy(groups, useCase) {
  const hasAcceptedAlternative = groups.some((group) => group.offerings.some((model) => !isRejectedQuantization(model, useCase)));
  const fallback = Boolean(useCase.quantizationPolicy?.reject?.length)
    && !hasAcceptedAlternative && useCase.quantizationPolicy?.fallbackWhenNoAlternative !== false;
  return {
    fallback,
    groups: groups
      .map((group) => {
        const rejectedRows = group.offerings.filter((model) => isRejectedQuantization(model, useCase));
        const offerings = fallback
          ? group.offerings
          : group.offerings.filter((model) => !isRejectedQuantization(model, useCase));
        return { ...group, offerings, quantFallback: fallback && rejectedRows.length > 0 };
      })
      .filter((group) => group.offerings.length),
  };
}

function buildBenchmarkIndex(benchmarks) {
  const index = new Map();
  const rows = Array.isArray(benchmarks) ? benchmarks : benchmarks?.models;
  for (const row of rows || []) {
    if (!row?.id) continue;
    const id = canonicalId(String(row.id));
    const entry = index.get(id) || {};
    const scores = { ...(row.benchmarks || {}), ...(row.scores || {}) };
    for (const [key, value] of Object.entries(scores)) {
      if (finite(value) && entry[key] == null) entry[key] = value;
    }
    index.set(id, entry);
  }
  return index;
}

function metricValue(record, field) {
  const benchmark = record?.benchmarks || {};
  const scores = record?.scores || {};
  let value;
  if (field === 'design_arena_best') {
    const design = benchmark.design_arena_best ?? record?.design_arena_best;
    value = finite(design) ? design : finite(design?.elo) ? design.elo : scores.design_arena_elo;
  } else {
    const aaField = {
      intelligence_index: 'aa_intelligence',
      coding_index: 'aa_coding',
      agentic_index: 'aa_agentic',
    }[field];
    value = benchmark[field] ?? record?.[field] ?? scores[field]
      ?? (aaField ? record?.[aaField] ?? scores[aaField] : null);
  }
  return finite(value) ? value : null;
}

function benchmarkSignalSource(field, benchmarks) {
  if (field === 'design_arena_best') {
    return { name: 'Design Arena', transport: 'OpenRouter benchmark metadata' };
  }
  if (field.startsWith('livebench_')) {
    return { name: 'LiveBench', release: benchmarks?.sources?.livebench?.release ?? null };
  }
  return { name: 'Artificial Analysis via OpenRouter', index: field };
}

function modelMetrics(group, benchmarkEntry, weights, benchmarks) {
  const metrics = {};
  const sources = {};
  for (const field of Object.keys(weights)) {
    if (!BENCHMARK_FIELDS.has(field)) continue;
    for (const model of group.offerings) {
      const value = metricValue(model, field) ?? metricValue(benchmarkEntry, field);
      if (value !== null) {
        metrics[field] = value;
        sources[field] = benchmarkSignalSource(field, benchmarks);
        break;
      }
    }
  }
  return { metrics, sources };
}

function percentile(value, values) {
  if (values.length <= 1) return 0.5;
  let lower = 0;
  let equal = 0;
  for (const other of values) {
    if (other < value) lower++;
    else if (other === value) equal++;
  }
  return (lower + equal / 2) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function scoreModelCandidates(groups, benchmarks, useCase) {
  const benchmarkIndex = buildBenchmarkIndex(benchmarks);
  for (const group of groups) {
    const result = modelMetrics(group, benchmarkIndex.get(group.id), useCase.benchmarkWeights, benchmarks);
    group.metrics = result.metrics;
    group.metricSources = result.sources;
  }
  const totalWeight = Object.values(useCase.benchmarkWeights).reduce((sum, weight) => sum + weight, 0);
  const valuesByField = {};
  for (const field of Object.keys(useCase.benchmarkWeights)) {
    valuesByField[field] = groups.map((group) => group.metrics[field]).filter(finite).sort((a, b) => a - b);
  }

  for (const group of groups) {
    const weightedScores = [];
    group.metricPercentiles = {};
    let coveredWeight = 0;
    for (const [field, weight] of Object.entries(useCase.benchmarkWeights)) {
      const value = group.metrics[field];
      if (!finite(value)) continue;
      const values = valuesByField[field];
      if (!values.length) continue;
      const score = percentile(value, values);
      group.metricPercentiles[field] = score;
      weightedScores.push({ field, score, weight });
      coveredWeight += weight;
    }
    group.qualityCoverage = totalWeight ? coveredWeight / totalWeight : 0;
    group.rawQualityScore = coveredWeight
      ? weightedScores.reduce((sum, item) => sum + item.score * item.weight, 0) / coveredWeight * 100
      : null;
  }

  const cohortMedian = median(groups.map((group) => group.rawQualityScore).filter(finite));
  for (const group of groups) {
    group.cohortMedianQualityScore = cohortMedian;
    group.qualityScore = finite(group.rawQualityScore)
      ? group.rawQualityScore * group.qualityCoverage
        + (cohortMedian ?? group.rawQualityScore) * (1 - group.qualityCoverage)
      : null;
  }
}

function blendedPrice(model, mix) {
  const rate = blendedRate(model?.pricing || {}, mix);
  return finiteNonNegative(rate) ? rate : null;
}

function rounded(value, digits = 4) {
  return finite(value) ? Number(value.toFixed(digits)) : null;
}

function confidenceFromRanking(ranked, selectedId, method) {
  const index = ranked.findIndex((row) => row.id === selectedId);
  const selected = ranked[index];
  const runnerUp = index >= 0 ? ranked[index + 1] : null;
  if (!selected || !runnerUp || !finite(selected.score) || !finite(runnerUp.score)) {
    return { level: 'uncompared', method, scoreMargin: null, runnerUpId: runnerUp?.id ?? null, runnerUpScore: runnerUp?.score ?? null };
  }
  const scoreMargin = Math.max(0, selected.score - runnerUp.score);
  const level = scoreMargin >= 10 ? 'stable' : scoreMargin >= 3 ? 'moderately_stable' : 'close_call';
  return {
    level,
    method,
    scoreMargin: rounded(scoreMargin, 2),
    runnerUpId: runnerUp.id,
    runnerUpScore: rounded(runnerUp.score, 2),
  };
}

function capabilitySource(model) {
  return Array.isArray(model?.supported_parameters) ? 'OpenRouter supported_parameters' : 'models.dev capability metadata';
}

function candidateGates(group, model, useCase, pick) {
  const requirements = useCase.hardRequirements || {};
  const openWeights = openWeightInfo(model);
  const capacity = contextCapacity(model);
  const primaryScore = group.metrics?.[useCase.qualityFloor.field] ?? null;
  const qualityGateApplied = ['bestQuality', 'bestValue', 'qualityRanking'].includes(pick);
  return [
    { key: 'open_weights', applied: true, passed: openWeights.value === true || group.allowProprietary, required: !group.allowProprietary, overridden: group.allowProprietary && openWeights.value !== true, observed: openWeights.value, source: openWeights.source },
    { key: 'subscription', applied: true, passed: model.subscription !== true || group.allowSubscription, observed: model.subscription === true, overridden: model.subscription === true && group.allowSubscription },
    { key: 'tool_calling', applied: requirements.needsToolCalling === true, passed: capabilityValue(model, 'tool_call') !== false, required: requirements.needsToolCalling === true, observed: capabilityValue(model, 'tool_call'), source: capabilitySource(model) },
    { key: 'structured_output', applied: requirements.needsStructuredOutput === true, passed: capabilityValue(model, 'structured_output') !== false, required: requirements.needsStructuredOutput === true, observed: capabilityValue(model, 'structured_output'), source: capabilitySource(model) },
    { key: 'minimum_context', applied: finiteNonNegative(requirements.minContext) && requirements.minContext > 0, passed: capacity === null ? null : capacity >= (requirements.minContext || 0), minimum: requirements.minContext || 0, observed: capacity },
    { key: 'priceable_mix', applied: true, passed: finiteNonNegative(group.blendedRate), mix: useCase.mix, observedBlendedRate: group.blendedRate },
    { key: 'quantization_policy', applied: Boolean(useCase.quantizationPolicy?.reject?.length), passed: true, rejected: useCase.quantizationPolicy?.reject || [], fallbackUsed: Boolean(group.quantFallback) },
    { key: 'benchmark_coverage', applied: qualityGateApplied, passed: group.qualityCoverage >= 0.5, minimumCoverage: 0.5, observedCoverage: group.qualityCoverage },
    { key: 'quality_floor', applied: pick === 'cheapestAboveFloor', passed: pick === 'cheapestAboveFloor' ? finite(primaryScore) && primaryScore >= useCase.qualityFloor.min : null, field: useCase.qualityFloor.field, minimum: useCase.qualityFloor.min, observed: primaryScore },
  ];
}

function candidateExplanation(group, model, useCase, pick) {
  const weights = useCase.benchmarkWeights;
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const signals = Object.entries(weights).map(([field, weight]) => {
    const rawValue = finite(group.metrics?.[field]) ? group.metrics[field] : null;
    const percentileScore = finite(group.metricPercentiles?.[field]) ? group.metricPercentiles[field] : null;
    return {
      field,
      rawValue,
      source: group.metricSources?.[field] ?? benchmarkSignalSource(field, null),
      weight,
      percentileScore: rounded(percentileScore, 6),
      weightedContribution: rawValue === null || percentileScore === null ? 0 : rounded(percentileScore * weight * 100, 4),
    };
  });
  const missingSignals = signals
    .filter((signal) => signal.rawValue === null)
    .map((signal) => ({ ...signal, reason: 'No benchmark value is available for this model in the selected catalog snapshot.' }));
  const missingWeight = signals.filter((signal) => signal.rawValue === null).reduce((sum, signal) => sum + signal.weight, 0);
  const observedWeight = totalWeight - missingWeight;
  const rawScore = group.rawQualityScore;
  const cohortMedian = group.cohortMedianQualityScore;
  const finalScore = group.qualityScore;
  const observedContribution = finite(rawScore) ? rawScore * (group.qualityCoverage ?? 0) : null;
  const missingContribution = finite(cohortMedian) ? cohortMedian * (1 - (group.qualityCoverage ?? 0)) : null;
  const priority = useCase.priority || 'balanced';
  return {
    schemaVersion: 1,
    useCase: useCase.id,
    pick,
    priority,
    mix: { ...useCase.mix },
    weights: {
      benchmark: { ...weights },
      provider: { ...useCase.providerWeights },
    },
    benchmark: {
      signals,
      missingSignals,
      totalWeight: rounded(totalWeight, 6),
      observedWeight: rounded(observedWeight, 6),
      missingWeight: rounded(missingWeight, 6),
      coverage: rounded(group.qualityCoverage ?? 0, 6),
      unshrunkScore: rounded(rawScore, 4),
      cohortMedianScore: rounded(cohortMedian, 4),
      shrinkage: {
        method: 'missing_weight_toward_eligible_cohort_median',
        missingWeight: rounded(missingWeight, 6),
        observedContribution: rounded(observedContribution, 4),
        missingContribution: rounded(missingContribution, 4),
        scoreDelta: finite(finalScore) && finite(rawScore) ? rounded(finalScore - rawScore, 4) : null,
      },
      finalScore: rounded(finalScore, 4),
    },
    gates: candidateGates(group, model, useCase, pick),
  };
}

function candidateResult(group, useCase, {
  unbenchmarked = false,
  meetsQualityFloor = false,
  candidateCount = null,
  costsMoreThanBestValue = false,
  pick = 'candidate',
  confidence = null,
} = {}) {
  const providerRanking = group.providerRanking || { ranked: [], unverified: [] };
  const recommendedProvider = providerRanking.ranked[0] || null;
  const cheapestProvider = [...providerRanking.ranked]
    .sort((a, b) => a.blendedRate - b.blendedRate || String(a.provider).localeCompare(String(b.provider)))[0] || null;
  const model = recommendedProvider?.offering || cheapestProvider?.offering || group.offerings[0];
  const quantization = quantizationOf(model);
  const reasons = [];
  const unknowns = [];
  if (group.qualityScore === null) {
    reasons.push('No use-case-weighted benchmark score is available; this model is listed as unbenchmarked and was not ranked.');
  } else {
    const coverage = Math.round(group.qualityCoverage * 100);
    const shrinkage = coverage < 100
      ? `; missing weight is shrunk toward the cohort median ${group.cohortMedianQualityScore.toFixed(1)}/100`
      : '';
    reasons.push(`Benchmark quality ${group.qualityScore.toFixed(1)}/100 (${coverage}% benchmark weight covered${shrinkage}; ${Object.keys(group.metrics).length} signal(s)).`);
  }
  if (candidateCount === 1) reasons.push('Only qualifying option: this is the sole model in this recommendation set.');
  if (cheapestProvider && providerRanking.ranked.length === 1) {
    reasons.push(`Only qualifying provider offering: $${cheapestProvider.blendedRate.toPrecision(4)} per million tokens at the ${useCase.id} mix.`);
  } else if (cheapestProvider) {
    reasons.push(`Lowest qualifying blended price: $${cheapestProvider.blendedRate.toPrecision(4)} per million tokens at the ${useCase.id} mix.`);
  } else unknowns.push('blended price unavailable for this workload');
  if (recommendedProvider) reasons.push(`Recommended provider: ${recommendedProvider.provider}, top-ranked after provider gates.`);
  if (recommendedProvider && cheapestProvider && recommendedProvider.provider !== cheapestProvider.provider) {
    reasons.push(`Cheapest qualifying provider is ${cheapestProvider.provider}; provider ranking prefers ${recommendedProvider.provider}.`);
  }
  if (meetsQualityFloor) {
    const { field, min } = useCase.qualityFloor;
    reasons.push(`Primary benchmark ${field} ${group.metrics[field]} meets the absolute floor of ${min}.`);
  }
  if (costsMoreThanBestValue) reasons.push('Note: this cheapest-above-floor pick costs more than bestValue at the use-case mix.');
  if (group.quantFallback) reasons.push('Low-bit quantization is the only qualifying option for this workload.');
  if (recommendedProvider && isBatchVariant(recommendedProvider.offering)) reasons.push('Asynchronous batch endpoint.');
  if (cheapestProvider && isBatchVariant(cheapestProvider.offering)
      && cheapestProvider.provider !== recommendedProvider?.provider) {
    reasons.push(`Cheapest provider ${cheapestProvider.provider} is an asynchronous batch endpoint.`);
  }
  if (model?.subscription === true) reasons.push('Subscription plan, not pay-as-you-go.');
  if (cheapestProvider?.offering?.subscription === true && model?.subscription !== true) {
    reasons.push(`Cheapest provider ${cheapestProvider.provider} is a subscription plan, not pay-as-you-go.`);
  }
  if (!quantization) unknowns.push('quantization not disclosed');
  if (useCase.id === 'reasoning-math') addReasoningInformation(model, reasons, unknowns);
  const openWeights = openWeightInfo(model);
  if (openWeights.source) reasons.push(`Open-weight status source: ${openWeights.source}.`);
  const license = model.license ?? model.modelsdev?.license ?? null;
  if (license) reasons.push(`License: ${license}.`);
  else unknowns.push('license not disclosed');

  return {
    id: group.id,
    name: group.name,
    org: group.org,
    provider: recommendedProvider?.provider ?? null,
    recommendedProvider,
    cheapestProvider: cheapestProvider && cheapestProvider.provider !== recommendedProvider?.provider
      ? cheapestProvider
      : null,
    blendedRate: cheapestProvider?.blendedRate ?? null,
    recommendedBlendedRate: recommendedProvider?.blendedRate ?? null,
    qualityScore: group.qualityScore,
    qualityCoverage: group.qualityCoverage,
    quantization,
    openWeights: openWeights.value,
    openWeightsSource: openWeights.source,
    license,
    reasons,
    unknowns,
    confidence: confidence || { level: 'uncompared', method: 'not-ranked', scoreMargin: null, runnerUpId: null, runnerUpScore: null },
    explanation: candidateExplanation(group, model, useCase, pick),
    unverifiedProviders: providerRanking.unverified,
    ...(unbenchmarked ? { group: 'unbenchmarked' } : {}),
    ...(group.qualityScore !== null && group.qualityCoverage < 0.5 ? { group: 'partiallyBenchmarked' } : {}),
    offering: recommendedProvider?.offering ?? cheapestProvider?.offering ?? null,
    cheapestOffering: cheapestProvider?.offering ?? null,
  };
}

function addReasoningInformation(model, reasons, unknowns) {
  const reasoning = model?.modelsdev?.reasoning
    ?? model?.modelsdev?.capabilities?.reasoning
    ?? model?.modelsdev_model?.reasoning
    ?? model?.modelsdev_model?.capabilities?.reasoning;
  if (reasoning === true) reasons.push('Reasoning capability is reported; informational only and not used as a gate.');
  else if (reasoning === false) reasons.push('No reasoning capability is reported; informational only and not used as a gate.');
  else unknowns.push('reasoning capability not disclosed (informational only; not a gate)');
}

function isBatchVariant(modelOrId) {
  const id = typeof modelOrId === 'string' ? modelOrId : modelOrId?.id;
  return typeof id === 'string' && canonicalId(id).endsWith(':batch');
}

function includeBatchVariants(useCase, options) {
  return useCase.id === 'high-volume-cheap' || options?.includeBatch === true;
}

function dominates(a, b) {
  const atLeastAsGood = a.qualityScore >= b.qualityScore && a.blendedRate <= b.blendedRate;
  const strictlyBetter = a.qualityScore > b.qualityScore || a.blendedRate < b.blendedRate;
  return atLeastAsGood && strictlyBetter;
}

function paretoFrontier(candidates, useCase, candidateCount) {
  const priced = candidates.filter((candidate) => candidate.blendedRate !== null);
  return priced
    .filter((candidate) => !priced.some((other) => other !== candidate && dominates(other, candidate)))
    .map((candidate) => candidateResult(candidate, useCase, { candidateCount }))
    .sort((a, b) => a.blendedRate - b.blendedRate || b.qualityScore - a.qualityScore || a.id.localeCompare(b.id));
}

function chooseParetoKnee(frontier) {
  if (!frontier.length) return null;
  const qualityMin = Math.min(...frontier.map((candidate) => candidate.qualityScore));
  const qualityMax = Math.max(...frontier.map((candidate) => candidate.qualityScore));
  const priceMin = Math.min(...frontier.map((candidate) => candidate.blendedRate));
  const priceMax = Math.max(...frontier.map((candidate) => candidate.blendedRate));
  const normalizedQuality = (candidate) => qualityMax === qualityMin ? 1 : (candidate.qualityScore - qualityMin) / (qualityMax - qualityMin);
  const normalizedPrice = (candidate) => priceMax === priceMin ? 1 : (priceMax - candidate.blendedRate) / (priceMax - priceMin);
  return [...frontier].sort((a, b) => {
    const distanceA = (1 - normalizedQuality(a)) ** 2 + (1 - normalizedPrice(a)) ** 2;
    const distanceB = (1 - normalizedQuality(b)) ** 2 + (1 - normalizedPrice(b)) ** 2;
    return distanceA - distanceB || b.qualityScore - a.qualityScore || a.blendedRate - b.blendedRate;
  })[0];
}

function paretoConfidenceScores(frontier) {
  if (!frontier.length) return [];
  const qualityMin = Math.min(...frontier.map((candidate) => candidate.qualityScore));
  const qualityMax = Math.max(...frontier.map((candidate) => candidate.qualityScore));
  const priceMin = Math.min(...frontier.map((candidate) => candidate.blendedRate));
  const priceMax = Math.max(...frontier.map((candidate) => candidate.blendedRate));
  return frontier.map((candidate) => {
    const quality = qualityMax === qualityMin ? 1 : (candidate.qualityScore - qualityMin) / (qualityMax - qualityMin);
    const price = priceMax === priceMin ? 1 : (priceMax - candidate.blendedRate) / (priceMax - priceMin);
    const distance = Math.sqrt((1 - quality) ** 2 + (1 - price) ** 2);
    return { id: candidate.id, score: 100 * (1 - distance / Math.sqrt(2)) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function unverifiedModelResult(group, providerResults) {
  const reasons = ['No provider has confirmed all required capability and context metadata; this model remains unverified.'];
  const unknowns = [];
  for (const provider of providerResults) {
    for (const reason of provider.reasons) reasons.push(`${provider.provider}: ${reason}`);
    for (const unknown of provider.unknowns) unknowns.push(`${provider.provider}: ${unknown}`);
  }
  return {
    id: group.id,
    name: group.name,
    org: group.org,
    provider: null,
    recommendedProvider: null,
    cheapestProvider: null,
    blendedRate: null,
    qualityScore: null,
    qualityCoverage: null,
    group: 'unverified',
    reasons,
    unknowns,
    providers: providerResults,
    offering: null,
  };
}

/**
 * Return quality, balanced Pareto, and quality-floor picks for open-weight models.
 * `opts.benchmarks` accepts public/benchmarks.json (or its `models` array).
 * Provider gates can be passed in `opts.constraints`; `opts.performance` supplies
 * the same canonicalId|provider measurements used by rankProviders().
 */
export function shortlistModels(useCaseId, catalog, opts = {}) {
  const priority = opts.priority ?? opts.constraints?.priority ?? 'balanced';
  const scenario = opts.scenario ?? opts.constraints?.scenario;
  const useCase = effectiveUseCase(useCaseId, { priority, scenario });
  const allowBatch = includeBatchVariants(useCase, opts);
  const groupsById = new Map();
  for (const model of modelsFrom(catalog)) {
    if (!model?.id) continue;
    if (!allowBatch && isBatchVariant(model)) continue;
    if (model.subscription === true && opts.includeSubscription !== true) continue;
    const openWeights = openWeightInfo(model);
    if (opts.includeProprietary !== true && openWeights.value !== true) continue;
    const id = canonicalId(String(model.id));
    if (!groupsById.has(id)) {
      groupsById.set(id, {
        id,
        name: model.name || String(model.id),
        org: model.org || null,
        allowProprietary: opts.includeProprietary === true,
        allowSubscription: opts.includeSubscription === true,
        offerings: [],
      });
    }
    const group = groupsById.get(id);
    group.offerings.push(model);
    if (!group.name && model.name) group.name = model.name;
    if (!group.org && model.org) group.org = model.org;
  }

  const performance = opts.performance ?? opts.perf ?? {};
  const constraints = { ...opts, ...(opts.constraints || {}), priority, scenario };
  const eligibleGroups = [];
  const unverified = [];
  for (const group of groupsById.values()) {
    const providerRanking = rankProviders(useCase, group.id, group.offerings, performance, constraints);
    if (providerRanking.ranked.length) {
      group.providerRanking = providerRanking;
      group.blendedRate = Math.min(...providerRanking.ranked.map((provider) => provider.blendedRate));
      group.quantFallback = providerRanking.ranked.some((provider) =>
        provider.reasons.some((reason) => /low-bit quantization is the only qualifying option/i.test(reason)));
      eligibleGroups.push(group);
    } else if (providerRanking.unverified.length) {
      unverified.push(unverifiedModelResult(group, providerRanking.unverified));
    }
  }

  scoreModelCandidates(eligibleGroups, opts.benchmarks, useCase);
  const scored = eligibleGroups.filter((candidate) => candidate.qualityScore !== null);
  const qualityEligible = scored.filter((candidate) => candidate.qualityCoverage >= 0.5);
  const unbenchmarked = eligibleGroups
    .filter((candidate) => candidate.qualityScore === null)
    .map((candidate) => candidateResult(candidate, useCase, { unbenchmarked: true }))
    .sort((a, b) => (a.blendedRate ?? Infinity) - (b.blendedRate ?? Infinity) || a.id.localeCompare(b.id));
  const partiallyBenchmarked = scored
    .filter((candidate) => candidate.qualityCoverage < 0.5)
    .map((candidate) => candidateResult(candidate, useCase, {
      candidateCount: scored.length,
    }))
    .sort((a, b) => b.qualityScore - a.qualityScore || a.id.localeCompare(b.id));

  const frontier = paretoFrontier(qualityEligible, useCase, qualityEligible.length);
  const qualityFloor = { ...useCase.qualityFloor };
  const bestQualityGroup = [...qualityEligible].sort((a, b) =>
    b.qualityScore - a.qualityScore || (a.blendedRate ?? Infinity) - (b.blendedRate ?? Infinity) || a.id.localeCompare(b.id)
  )[0];
  const floorEligible = scored
    .filter((candidate) => finite(candidate.metrics[qualityFloor.field])
      && candidate.metrics[qualityFloor.field] >= qualityFloor.min
      && candidate.blendedRate !== null)
    .sort((a, b) => a.blendedRate - b.blendedRate || b.qualityScore - a.qualityScore || a.id.localeCompare(b.id));
  const cheapestAboveFloorGroup = floorEligible[0];
  const bestValueCandidate = chooseParetoKnee(frontier);
  const bestValueGroup = bestValueCandidate
    ? qualityEligible.find((candidate) => candidate.id === bestValueCandidate.id)
    : null;
  const qualityConfidenceScores = [...qualityEligible]
    .map((candidate) => ({ id: candidate.id, score: candidate.qualityScore }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const floorMinimum = floorEligible.length ? Math.min(...floorEligible.map((candidate) => candidate.blendedRate)) : null;
  const floorConfidenceScores = floorEligible
    .map((candidate) => ({ id: candidate.id, score: floorMinimum > 0 ? 100 * floorMinimum / candidate.blendedRate : 100 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const bestValue = bestValueGroup
    ? candidateResult(bestValueGroup, useCase, {
      pick: 'bestValue',
      candidateCount: frontier.length,
      confidence: confidenceFromRanking(paretoConfidenceScores(frontier), bestValueGroup.id, 'pareto_ideal_score_margin'),
    })
    : null;
  const cheapestAboveFloor = cheapestAboveFloorGroup
    ? candidateResult(cheapestAboveFloorGroup, useCase, {
      meetsQualityFloor: true,
      candidateCount: floorEligible.length,
      costsMoreThanBestValue: Boolean(bestValue && cheapestAboveFloorGroup.blendedRate > bestValue.blendedRate),
      pick: 'cheapestAboveFloor',
      confidence: confidenceFromRanking(floorConfidenceScores, cheapestAboveFloorGroup.id, 'relative_blended_cost_margin'),
    })
    : null;
  const qualityRanking = [...qualityEligible]
    .sort((a, b) => b.qualityScore - a.qualityScore || (a.blendedRate ?? Infinity) - (b.blendedRate ?? Infinity) || a.id.localeCompare(b.id))
    .slice(0, 10)
    .map((candidate) => candidateResult(candidate, useCase, {
      pick: 'qualityRanking',
      candidateCount: qualityEligible.length,
      confidence: confidenceFromRanking(qualityConfidenceScores, candidate.id, 'quality_score_margin'),
    }));

  return {
    useCase: useCase.id,
    priority,
    qualityFloor,
    bestQuality: bestQualityGroup ? candidateResult(bestQualityGroup, useCase, {
      pick: 'bestQuality',
      candidateCount: qualityEligible.length,
      confidence: confidenceFromRanking(qualityConfidenceScores, bestQualityGroup.id, 'quality_score_margin'),
    }) : null,
    bestValue,
    cheapestAboveFloor,
    qualityRanking,
    paretoFrontier: frontier,
    unbenchmarked,
    partiallyBenchmarked,
    unverified: unverified.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function normalizedUptime(model) {
  if (finiteNonNegative(model?.uptime_30m)) return { value: model.uptime_30m, window: '30m' };
  if (finiteNonNegative(model?.uptime_1d)) return { value: model.uptime_1d, window: '1d' };
  return null;
}

function minUptimePercent(value) {
  return finite(value) ? value : null;
}

function uptimeWindowLabel(window) {
  if (window === '30m') return '30-minute';
  if (window === '1d') return '1-day';
  return window;
}

function headquartersOf(model, provider, constraints) {
  const metadata = constraints.providersMeta?.[provider]
    ?? constraints.providers_meta?.[provider]
    ?? model.provider_meta
    ?? {};
  return model.headquarters ?? model.hq ?? metadata.headquarters ?? null;
}

function matchesHeadquarters(value, requested) {
  if (requested === true) return Boolean(value);
  const allowed = Array.isArray(requested) ? requested : [requested];
  return Boolean(value) && allowed.some((country) => String(country).toLowerCase() === String(value).toLowerCase());
}

function matchingIssue(model, canonical, issues) {
  return (issues || []).filter((issue) => issue
    && canonicalId(String(issue.canonicalId || '')) === canonical
    && String(issue.provider || '').toLowerCase() === String(model.provider || '').toLowerCase());
}

function issueReason(issue) {
  const verdict = String(issue.verdict || '').toLowerCase() || 'unspecified';
  const label = verdict === 'degraded' ? 'degraded warning' : verdict;
  return `Known issue (${label}): ${issue.source || 'source not provided'}.`;
}

function perfFor(model, canonical, perf) {
  if (!perf || typeof perf !== 'object') return null;
  return perf[`${canonical}|${model.provider}`] || null;
}

function performanceSourceLabel(source) {
  const known = {
    openrouter: 'OpenRouter',
    coralbricks: 'CoralBricks',
    lilac: 'Lilac',
    umans: 'Umans',
  };
  const normalized = String(source).toLowerCase();
  if (known[normalized]) return known[normalized];
  return String(source).replace(/(^|[-_])([a-z])/gi, (_match, _boundary, letter) => letter.toUpperCase());
}

function performanceWindowLabel(window) {
  if (window === '30m') return '30-minute';
  if (window === '1d') return '1-day';
  if (window === '1h') return '1-hour';
  return window || 'window not disclosed';
}

function directPerformanceSource(provider) {
  const normalized = String(provider || '').toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'coralbricks') return 'coralbricks';
  if (normalized === 'lilac') return 'lilac';
  if (normalized === 'umans' || normalized === 'umansai') return 'umans';
  return null;
}

function metricsForProvider(model, canonical, perf, useCase) {
  const record = perfFor(model, canonical, perf);
  const rate = blendedPrice(model, useCase.mix);
  const ttft = finite(record?.latency?.p50) ? record.latency.p50
    : finite(record?.latency?.ttft_ms?.p50) ? record.latency.ttft_ms.p50
    : finite(record?.ttft?.p50) ? record.ttft.p50 : null;
  const throughput = finite(record?.throughput?.p50) ? record.throughput.p50 : null;
  const uptime = normalizedUptime(model);
  const source = record?.source || directPerformanceSource(model.provider) || 'openrouter';
  // OpenRouter endpoint telemetry is explicitly gathered over its last-30m window;
  // Lilac is fetched with window=1h; Umans has no disclosed measurement window.
  const latencyWindow = record?.latency?.window
    || (source === 'openrouter' ? '30m' : source === 'lilac' ? '1h' : null);
  const throughputWindow = record?.throughput?.window
    || (source === 'openrouter' ? '30m' : source === 'lilac' ? '1h' : null);
  const uptimeSource = model.uptime_source || 'openrouter';
  const pricingSource = model.pricing_source || 'TokenWatch pricing catalog';
  return {
    price: rate,
    priceSource: { name: pricingSource, provider: model.provider },
    ttft,
    ttftSource: performanceSourceLabel(source),
    ttftWindow: ttft !== null ? performanceWindowLabel(latencyWindow) : null,
    ttftSourceInfo: { name: performanceSourceLabel(source), window: latencyWindow },
    throughput,
    throughputSourceInfo: { name: performanceSourceLabel(source), window: throughputWindow },
    uptime: uptime?.value ?? null,
    uptimeWindow: uptime?.window ?? null,
    uptimeSourceInfo: { name: performanceSourceLabel(uptimeSource), window: uptime?.window ?? '30m' },
  };
}

function scaleMetric(value, values, lowerIsBetter) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return 1;
  return lowerIsBetter ? (max - value) / (max - min) : (value - min) / (max - min);
}

function gateProvider(model, useCase, constraints, canonical) {
  const hardRequirements = assessHardRequirements(model, useCase);
  if (hardRequirements.blocked) return null;
  if (constraints.requireZdr && model.zdr !== true) return null;

  const requireHQ = constraints.requireHQ ?? constraints.requireHq;
  const headquarters = headquartersOf(model, model.provider, constraints);
  if (requireHQ && !matchesHeadquarters(headquarters, requireHQ)) return null;
  const excludeHQ = constraints.excludeHQ ?? constraints.excludeHq;
  if (headquarters && matchesHeadquarters(headquarters, excludeHQ || [])) return null;

  const uptime = normalizedUptime(model);
  const minUptime = minUptimePercent(constraints.minUptime);
  if (minUptime !== null && (!uptime || uptime.value < minUptime)) return null;

  const issues = matchingIssue(model, canonical, constraints.knownIssues);
  if (issues.some((issue) => BLOCKING_ISSUES.has(String(issue.verdict || '').toLowerCase()))) return null;

  return {
    headquarters,
    uptime,
    issues,
    requirementUnknowns: hardRequirements.unknowns,
    capacity: hardRequirements.capacity,
  };
}

function providerGates(model, useCase, constraints, gate, quantFallback, price) {
  const requirements = useCase.hardRequirements || {};
  const requireHQ = constraints.requireHQ ?? constraints.requireHq;
  const excludeHQ = constraints.excludeHQ ?? constraints.excludeHq ?? [];
  const minUptime = minUptimePercent(constraints.minUptime);
  return [
    { key: 'tool_calling', applied: requirements.needsToolCalling === true, passed: capabilityValue(model, 'tool_call') !== false, required: requirements.needsToolCalling === true, observed: capabilityValue(model, 'tool_call'), source: capabilitySource(model) },
    { key: 'structured_output', applied: requirements.needsStructuredOutput === true, passed: capabilityValue(model, 'structured_output') !== false, required: requirements.needsStructuredOutput === true, observed: capabilityValue(model, 'structured_output'), source: capabilitySource(model) },
    { key: 'minimum_context', applied: finiteNonNegative(requirements.minContext) && requirements.minContext > 0, passed: gate.capacity === null ? null : gate.capacity >= (requirements.minContext || 0), minimum: requirements.minContext || 0, observed: gate.capacity },
    { key: 'zdr', applied: Boolean(constraints.requireZdr), passed: !constraints.requireZdr || model.zdr === true, observed: model.zdr === true },
    { key: 'headquarters', applied: Boolean(requireHQ), passed: !requireHQ || matchesHeadquarters(gate.headquarters, requireHQ), requested: requireHQ ?? null, observed: gate.headquarters },
    { key: 'excluded_headquarters', applied: excludeHQ.length > 0, passed: !gate.headquarters || !matchesHeadquarters(gate.headquarters, excludeHQ), excluded: excludeHQ, observed: gate.headquarters },
    { key: 'minimum_uptime', applied: minUptime !== null, passed: minUptime === null || Boolean(gate.uptime && gate.uptime.value >= minUptime), minimum: minUptime, observed: gate.uptime?.value ?? null, window: gate.uptime?.window ?? null },
    { key: 'known_issue', applied: true, passed: !gate.issues.some((issue) => BLOCKING_ISSUES.has(String(issue.verdict || '').toLowerCase())), blockingVerdicts: ['broken', 'unavailable'], observed: gate.issues.map((issue) => ({ verdict: issue.verdict || 'unspecified', source: issue.source || null })) },
    { key: 'priceable_mix', applied: true, passed: finiteNonNegative(price), mix: useCase.mix, observedBlendedRate: price },
    { key: 'quantization_policy', applied: Boolean(useCase.quantizationPolicy?.reject?.length), passed: true, rejected: useCase.quantizationPolicy?.reject || [], fallbackUsed: quantFallback },
  ];
}

function providerExplanation(row, useCase, constraints, gate) {
  const weights = useCase.providerWeights;
  const signals = PROVIDER_METRICS.map((field) => {
    const rawValue = finite(row.metrics[field]) ? row.metrics[field] : null;
    const weight = weights[field] ?? 0;
    const normalizedScore = finite(row.normalized[field]) ? row.normalized[field] : null;
    return {
      field,
      rawValue,
      source: row.metrics[`${field}SourceInfo`] ?? row.metrics[`${field}Source`] ?? null,
      weight,
      normalizedScore: rounded(normalizedScore, 6),
      effectiveWeight: rawValue === null || row.availableWeight <= 0 ? 0 : rounded(weight / row.availableWeight, 6),
      weightedContribution: rawValue === null || normalizedScore === null || row.availableWeight <= 0
        ? 0
        : rounded(normalizedScore * weight / row.availableWeight * 100, 4),
    };
  });
  const missingSignals = signals
    .filter((signal) => signal.rawValue === null)
    .map((signal) => ({
      ...signal,
      reason: 'No value is available for this provider in the selected telemetry snapshot.',
      scoreEffect: 'omitted; the remaining observed weights are renormalized rather than treated as zero',
    }));
  const missingWeight = signals.filter((signal) => signal.rawValue === null).reduce((sum, signal) => sum + signal.weight, 0);
  return {
    schemaVersion: 1,
    useCase: useCase.id,
    priority: useCase.priority || 'balanced',
    mix: { ...useCase.mix },
    weights: { ...weights },
    signals,
    missingSignals,
    score: {
      observedWeight: rounded(row.availableWeight, 6),
      missingWeight: rounded(missingWeight, 6),
      renormalizationFactor: row.availableWeight > 0 ? rounded(1 / row.availableWeight, 6) : null,
      weightedSumBeforeRenormalization: rounded(row.weightedScore, 6),
      finalScore: rounded(row.score, 4),
      missingnessEffect: 'Missing metrics are omitted, not scored as zero; remaining weights are renormalized. Their unknown effect cannot be estimated from the available data.',
    },
    gates: providerGates(row.model, useCase, constraints, gate, row.quantFallback, row.metrics.price),
  };
}

/**
 * Rank provider offerings for one canonical model after hard capability,
 * context, privacy, uptime, issue, and quantization gates.
 */
export function rankProviders(useCaseId, canonicalModelId, offerings, perf = {}, constraints = {}) {
  const useCase = effectiveUseCase(useCaseId, {
    priority: constraints.priority ?? 'balanced',
    scenario: constraints.scenario,
  });
  const canonical = canonicalId(String(canonicalModelId));
  const allowBatch = includeBatchVariants(useCase, constraints);
  const groups = [];
  const unverifiedGroups = [];
  for (const model of offerings || []) {
    if (!model?.id || !model.provider || canonicalId(String(model.id)) !== canonical) continue;
    if (!allowBatch && isBatchVariant(model)) continue;
    const gate = gateProvider(model, useCase, constraints, canonical);
    if (!gate) continue;
    const group = { id: canonical, name: model.name || String(model.id), org: model.org || null, offerings: [model], gate };
    (gate.requirementUnknowns.length ? unverifiedGroups : groups).push(group);
  }

  // A provider without a price for the exact workload mix is not a candidate;
  // exclude it before quantization fallback so it cannot block a usable option.
  const pricedGroups = groups.filter((group) => finiteNonNegative(blendedPrice(group.offerings[0], useCase.mix)));
  const quantized = applyQuantizationPolicy(pricedGroups, useCase);
  const rows = quantized.groups.map((group) => {
    const model = group.offerings[0];
    const metrics = metricsForProvider(model, canonical, perf, useCase);
    return { model, metrics, gate: group.gate, quantFallback: group.quantFallback, normalized: {} };
  }).filter((row) => finiteNonNegative(row.metrics.price));

  const values = Object.fromEntries(PROVIDER_METRICS.map((metric) => [
    metric,
    rows.map((row) => row.metrics[metric]).filter(finite),
  ]));
  for (const row of rows) {
    let availableWeight = 0;
    let weightedScore = 0;
    for (const [metric, weight] of Object.entries(useCase.providerWeights)) {
      const value = row.metrics[metric];
      if (!finite(value) || !values[metric].length) continue;
      const normalized = scaleMetric(value, values[metric], metric !== 'throughput' && metric !== 'uptime');
      row.normalized[metric] = normalized;
      availableWeight += weight;
      weightedScore += normalized * weight;
    }
    row.availableWeight = availableWeight;
    row.weightedScore = weightedScore;
    row.score = availableWeight ? weightedScore / availableWeight * 100 : null;
  }

  const cheapest = rows.filter((row) => finite(row.metrics.price)).sort((a, b) => a.metrics.price - b.metrics.price)[0];
  const fastestFirstToken = rows.filter((row) => finite(row.metrics.ttft)).sort((a, b) => a.metrics.ttft - b.metrics.ttft)[0];
  const highestThroughput = rows.filter((row) => finite(row.metrics.throughput)).sort((a, b) => b.metrics.throughput - a.metrics.throughput)[0];

  for (const row of rows) {
    const { model, metrics, gate } = row;
    const reasons = [];
    const unknowns = [];
    if (model.subscription === true) reasons.push('Subscription plan, not pay-as-you-go.');
    if (isBatchVariant(model)) reasons.push('Asynchronous batch endpoint.');
    if (useCase.hardRequirements.needsToolCalling) reasons.push('Meets required tool-calling capability.');
    if (useCase.hardRequirements.needsStructuredOutput) reasons.push('Meets required structured-output capability.');
    if (useCase.id === 'reasoning-math') addReasoningInformation(model, reasons, unknowns);
    const capacity = contextCapacity(model);
    if (capacity !== null) reasons.push(`Prompt capacity ${capacity.toLocaleString()} tokens meets the ${useCase.hardRequirements.minContext.toLocaleString()}-token minimum.`);
    if (constraints.requireZdr) reasons.push('Meets the requested ZDR requirement.');
    if (constraints.requireHQ ?? constraints.requireHq) reasons.push(`Headquarters requirement met: ${gate.headquarters}.`);
    if (finite(constraints.minUptime)) reasons.push(`Meets the requested ${minUptimePercent(constraints.minUptime)}% uptime threshold.`);
    if (gate.uptime) reasons.push(`Reported uptime over the ${uptimeWindowLabel(gate.uptime.window)} window: ${gate.uptime.value.toFixed(2)}%.`);

    const toolChoice = model.supports_tool_choice;
    if (useCase.hardRequirements.needsToolCalling && toolChoice === true) reasons.push('Provider reports tool-choice support.');
    else if (useCase.hardRequirements.needsToolCalling && toolChoice === false) reasons.push('Basic tool calling is available; tool-choice control is not reported as supported.');
    else if (useCase.hardRequirements.needsToolCalling) unknowns.push('tool-choice support not disclosed');

    const implicitCaching = model.supports_implicit_caching;
    if (useCase.mix.cacheReadPct > 0 && implicitCaching === true) reasons.push('Provider reports implicit prompt-caching support.');
    else if (useCase.mix.cacheReadPct > 0 && implicitCaching === false) reasons.push('Provider reports no implicit prompt-caching support.');
    else if (useCase.mix.cacheReadPct > 0) unknowns.push('implicit prompt-caching support not disclosed');

    if (finite(metrics.price)) {
      reasons.push(`Blended workload price: $${metrics.price.toPrecision(4)} per million tokens.`);
      if (cheapest === row && rows.length === 1) reasons.push('Only qualifying option: this is the sole priced provider offering that passes the requested gates.');
      else if (cheapest === row) reasons.push('Lowest blended price among eligible provider offerings.');
    } else unknowns.push('blended price unavailable for this workload');
    if (finite(metrics.ttft)) {
      const source = metrics.ttftSource ? `${metrics.ttftSource} ` : '';
      const window = metrics.ttftWindow ? `${metrics.ttftWindow} ` : '';
      reasons.push(`${source}${window}TTFT p50: ${metrics.ttft.toLocaleString()} ms.`);
      if (fastestFirstToken === row && rows.length === 1) reasons.push('Only qualifying option with disclosed TTFT p50.');
      else if (fastestFirstToken === row) reasons.push(`Lowest ${source}${window}TTFT p50 among eligible providers.`);
    } else unknowns.push('TTFT p50 not available');
    if (finite(metrics.throughput)) {
      reasons.push(`Throughput p50: ${metrics.throughput.toLocaleString()} tokens/s.`);
      if (highestThroughput === row && rows.length === 1) reasons.push('Only qualifying option with disclosed throughput p50.');
      else if (highestThroughput === row) reasons.push('Highest throughput p50 among eligible providers.');
    } else unknowns.push('throughput p50 not available');
    if (!gate.uptime) unknowns.push('uptime not disclosed');

    const quantization = quantizationOf(model);
    if (quantization) reasons.push(`Quantization: ${quantization}.`);
    else unknowns.push('quantization not disclosed');
    const license = model.license ?? model.modelsdev?.license ?? null;
    if (license) reasons.push(`License: ${license}.`);
    else unknowns.push('license not disclosed');
    if (row.quantFallback) reasons.push('Low-bit quantization is the only qualifying option for this workload.');
    if (gate.issues.length) {
      for (const issue of gate.issues) {
        reasons.push(issueReason(issue));
      }
    }
    if (row.score === null) unknowns.push('provider score unavailable because no weighted signals were reported');
    else reasons.push(`Provider score ${row.score.toFixed(1)}/100 from disclosed metrics, normalized against eligible providers.`);

    row.result = {
      canonicalId: canonical,
      provider: model.provider,
      score: row.score,
      blendedRate: metrics.price,
      ttftP50: metrics.ttft,
      throughputP50: metrics.throughput,
      uptime: gate.uptime?.value ?? null,
      uptimeWindow: gate.uptime?.window ?? null,
      quantization,
      license,
      reasons,
      unknowns,
      offering: model,
    };
  }

  const rankedRows = [...rows].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)
    || (a.metrics.price ?? Infinity) - (b.metrics.price ?? Infinity)
    || String(a.model.provider).localeCompare(String(b.model.provider)));
  const ranked = rankedRows.map((row, index) => {
    const runnerUp = rankedRows[index + 1];
    const confidence = confidenceFromRanking([
      { id: row.model.provider, score: row.score },
      ...(runnerUp ? [{ id: runnerUp.model.provider, score: runnerUp.score }] : []),
    ], row.model.provider, 'provider_score_margin');
    return {
      ...row.result,
      confidence,
      explanation: providerExplanation(row, useCase, constraints, row.gate),
    };
  });

  const unverified = unverifiedGroups.map((group) => {
    const model = group.offerings[0];
    const metrics = metricsForProvider(model, canonical, perf, useCase);
    const reasons = group.gate.requirementUnknowns.map((reason) => `${reason} Provider is listed as unverified and omitted from the confirmed ranking.`);
    const unknowns = [...group.gate.requirementUnknowns];
    if (model.subscription === true) reasons.push('Subscription plan, not pay-as-you-go.');
    if (group.gate.capacity !== null && group.gate.capacity !== undefined) {
      reasons.push(`Prompt capacity ${group.gate.capacity.toLocaleString()} tokens meets the ${useCase.hardRequirements.minContext.toLocaleString()}-token minimum.`);
    }
    if (constraints.requireZdr) reasons.push('Meets the requested ZDR requirement.');
    if (constraints.requireHQ ?? constraints.requireHq) reasons.push(`Headquarters requirement met: ${group.gate.headquarters}.`);
    if (group.gate.uptime) reasons.push(`Reported uptime over the ${uptimeWindowLabel(group.gate.uptime.window)} window: ${group.gate.uptime.value.toFixed(2)}%.`);
    if (finite(metrics.price)) reasons.push(`Blended workload price: $${metrics.price.toPrecision(4)} per million tokens.`);
    else unknowns.push('blended price unavailable for this workload');
    const quantization = quantizationOf(model);
    if (quantization) reasons.push(`Quantization: ${quantization}.`);
    else unknowns.push('quantization not disclosed');
    if (isRejectedQuantization(model, useCase)) reasons.push('Low-bit quantization is shown for inspection only; this provider is unverified and is not recommended.');
    const license = model.license ?? model.modelsdev?.license ?? null;
    if (license) reasons.push(`License: ${license}.`);
    else unknowns.push('license not disclosed');
    for (const issue of group.gate.issues) {
      reasons.push(issueReason(issue));
    }
    return {
      canonicalId: canonical,
      provider: model.provider,
      score: null,
      blendedRate: metrics.price,
      quantization,
      license,
      reasons,
      unknowns,
      offering: model,
    };
  });

  const message = ranked.length
    ? null
    : unverified.length
      ? `No confirmed providers meet this use case; ${unverified.length} provider offering(s) remain unverified because required metadata is missing.`
      : 'No confirmed providers meet this use case and the requested constraints.';
  return { ranked, unverified, message };
}
