#!/usr/bin/env node
/**
 * Local robustness check for recommender defaults. Each scenario changes one
 * input family at a time; it is a sensitivity screen, not a probability model.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { USE_CASES } from '../shared/use-cases.mjs';
import { canonicalId } from '../shared/normalize.mjs';
import { rankProviders, shortlistModels } from '../shared/recommend.mjs';

const WEIGHT_DELTA = 0.1;
const FLOOR_DELTA = 0.2;

function renormalize(weights) {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) throw new RangeError('Sensitivity weights must have a positive finite total');
  return Object.fromEntries(Object.entries(weights).map(([field, weight]) => [field, weight / total]));
}

function weightScenarios(kind, weights) {
  return Object.entries(weights).flatMap(([field, baseWeight]) => [-WEIGHT_DELTA, WEIGHT_DELTA].map((delta) => {
    const adjusted = { ...weights, [field]: Math.max(0, baseWeight + delta) };
    const key = kind === 'benchmark_weight' ? 'benchmarkWeights' : 'providerWeights';
    return {
      kind,
      label: `${field} ${delta > 0 ? '+' : ''}${Math.round(delta * 100)}pp`,
      override: { [key]: renormalize(adjusted) },
    };
  }));
}

function mixAlternatives(mix) {
  const noCache = {
    inputPct: mix.inputPct + mix.cacheReadPct,
    cacheReadPct: 0,
    outputPct: mix.outputPct,
  };
  const cacheShift = Math.min(10, mix.inputPct);
  const cacheHeavy = {
    inputPct: mix.inputPct - cacheShift,
    cacheReadPct: mix.cacheReadPct + cacheShift,
    outputPct: mix.outputPct,
  };
  const outputShift = Math.min(10, mix.inputPct + mix.cacheReadPct);
  const fromInput = Math.min(outputShift, mix.inputPct);
  const outputHeavy = {
    inputPct: mix.inputPct - fromInput,
    cacheReadPct: mix.cacheReadPct - (outputShift - fromInput),
    outputPct: mix.outputPct + outputShift,
  };
  return [
    { label: 'uncached-input', mix: noCache },
    { label: 'cache-heavier-by-up-to-10pp', mix: cacheHeavy },
    { label: 'output-heavier-by-up-to-10pp', mix: outputHeavy },
  ];
}

/** Create one-at-a-time ±10pp weight, ±20% floor, and plausible mix scenarios. */
export function buildSensitivityScenarios(useCase) {
  const floor = useCase.qualityFloor;
  return [
    ...weightScenarios('benchmark_weight', useCase.benchmarkWeights),
    ...weightScenarios('provider_weight', useCase.providerWeights),
    { kind: 'quality_floor', label: 'quality floor -20%', override: { qualityFloor: { ...floor, min: floor.min * (1 - FLOOR_DELTA) } } },
    { kind: 'quality_floor', label: 'quality floor +20%', override: { qualityFloor: { ...floor, min: floor.min * (1 + FLOOR_DELTA) } } },
    ...mixAlternatives(useCase.mix).map(({ label, mix }) => ({ kind: 'mix', label, override: { mix } })),
  ];
}

function pickId(result, name) {
  return result[name]?.id ?? null;
}

function classifyChanges(changed, total, baseline) {
  if (baseline === null || total === 0) return 'unavailable';
  const rate = changed / total;
  if (rate <= 0.1) return 'stable';
  if (rate <= 0.35) return 'moderately_stable';
  return 'close_call';
}

function summarizeChanges(baseline, variants) {
  const total = variants.length;
  const changes = variants.filter((value) => value !== baseline);
  const changedTo = {};
  for (const value of changes) {
    const label = value ?? '(no pick)';
    changedTo[label] = (changedTo[label] || 0) + 1;
  }
  return {
    baseline,
    changed: changes.length,
    total,
    changeRate: total ? changes.length / total : null,
    classification: classifyChanges(changes.length, total, baseline),
    changedTo,
  };
}

/** Run sensitivity scenarios for all registered (or requested) use cases. */
export function runSensitivityAnalysis({ catalog, benchmarks, performance = {}, useCaseIds = Object.keys(USE_CASES) }) {
  const models = Array.isArray(catalog) ? catalog : catalog?.models || [];
  const useCases = useCaseIds.map((id) => {
    const useCase = USE_CASES[id];
    if (!useCase) throw new RangeError(`Unknown use case: ${id}`);
    const scenarios = buildSensitivityScenarios(useCase);
    const optionsFor = (scenario) => ({
      benchmarks,
      performance,
      priority: 'balanced',
      ...(scenario ? { scenario: scenario.override } : {}),
    });
    const baseline = shortlistModels(id, models, optionsFor(null));
    const variantResults = scenarios.map((scenario) => ({
      scenario,
      result: shortlistModels(id, models, optionsFor(scenario)),
    }));
    const changes = Object.fromEntries(['bestQuality', 'bestValue', 'cheapestAboveFloor'].map((pick) => [
      pick,
      summarizeChanges(
        pickId(baseline, pick),
        variantResults.map(({ result }) => pickId(result, pick)),
      ),
    ]));

    const bestQualityId = pickId(baseline, 'bestQuality');
    const fixedModelOfferings = bestQualityId === null
      ? []
      : models.filter((model) => canonicalId(String(model.id || '')) === bestQualityId);
    const providerScenarios = scenarios.filter((scenario) => scenario.kind === 'provider_weight' || scenario.kind === 'mix');
    const baselineTopProvider = baseline.bestQuality?.recommendedProvider?.provider ?? null;
    const selectedModelProviderVariants = variantResults.map(({ result }) =>
      result.bestQuality?.recommendedProvider?.provider ?? null);
    const fixedModelProviderVariants = bestQualityId === null
      ? []
      : providerScenarios.map((scenario) => rankProviders(
        id,
        bestQualityId,
        fixedModelOfferings,
        performance,
        { priority: 'balanced', scenario: scenario.override },
      ).ranked[0]?.provider ?? null);
    changes.topProvider = summarizeChanges(baselineTopProvider, selectedModelProviderVariants);
    changes.fixedModelTopProvider = summarizeChanges(baselineTopProvider, fixedModelProviderVariants);

    const scenarioCounts = Object.fromEntries([...new Set(scenarios.map((scenario) => scenario.kind))]
      .map((kind) => [kind, scenarios.filter((scenario) => scenario.kind === kind).length]));
    return {
      useCase: id,
      baseline: {
        bestQuality: pickId(baseline, 'bestQuality'),
        bestValue: pickId(baseline, 'bestValue'),
        cheapestAboveFloor: pickId(baseline, 'cheapestAboveFloor'),
        topProvider: baselineTopProvider,
      },
      scenarioCounts: {
        all: scenarios.length,
        byKind: scenarioCounts,
        topProvider: scenarios.length,
        fixedModelTopProvider: providerScenarios.length,
      },
      changes,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    snapshots: {
      catalog: catalog?.generated_at ?? null,
      benchmarks: benchmarks?.generated_at ?? null,
    },
    perturbations: {
      weightPoints: 10,
      qualityFloorPercent: 20,
      mixAlternatives: mixAlternatives(USE_CASES['agentic-coding'].mix).map((item) => item.label),
      classificationThresholds: { stableMaxChangeRate: 0.1, moderatelyStableMaxChangeRate: 0.35 },
      method: 'one input family at a time; topProvider follows the best-quality model selected in each scenario, while fixedModelTopProvider holds the baseline best-quality model across provider-weight and mix scenarios only',
    },
    useCases,
  };
}

function labelStability(change) {
  return change.classification.replaceAll('_', ' ');
}

export function renderSensitivityMarkdown(report) {
  const lines = [
    '# Recommender sensitivity',
    '',
    `Generated ${report.generatedAt}. Catalog snapshot: ${report.snapshots.catalog || 'unknown'}; benchmark snapshot: ${report.snapshots.benchmarks || 'unknown'}.`,
    '',
    'Each row tests one perturbation at a time. A pick is **stable** at ≤10% changed scenarios, **moderately stable** at >10% through 35%, and a **close call** above 35%. The first provider column follows whichever best-quality model each scenario selects across all scenarios; the second holds the baseline best-quality model fixed and tests only provider-weight and mix changes.',
    '',
    '| Use case | Best quality pick | Best value pick | Cheapest above floor | #1 provider (selected model, all scenarios) | #1 provider (fixed baseline model, provider/mix only) |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of report.useCases) {
    const formatPick = (name) => {
      const change = row.changes[name];
      return `${change.baseline ?? '—'}; ${change.changed}/${change.total} changed; ${labelStability(change)}`;
    };
    const provider = row.changes.topProvider;
    const fixedProvider = row.changes.fixedModelTopProvider;
    lines.push(`| ${row.useCase} | ${formatPick('bestQuality')} | ${formatPick('bestValue')} | ${formatPick('cheapestAboveFloor')} | ${provider.baseline ?? '—'}; ${provider.changed}/${provider.total} changed; ${labelStability(provider)} | ${fixedProvider.baseline ?? '—'}; ${fixedProvider.changed}/${fixedProvider.total} changed; ${labelStability(fixedProvider)} |`);
  }
  lines.push('', 'Scenario counts vary by use case because each configured benchmark signal is perturbed independently. The counts are deterministic for the input snapshots; they are not statistical confidence intervals.');
  return lines.join('\n');
}

async function main() {
  const [pricing, benchmarks, performance] = await Promise.all([
    readFile('public/pricing.json', 'utf8').then(JSON.parse),
    readFile('public/benchmarks.json', 'utf8').then(JSON.parse),
    readFile('public/performance.json', 'utf8').then(JSON.parse).catch(() => ({})),
  ]);
  const report = runSensitivityAnalysis({ catalog: pricing, benchmarks, performance });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(renderSensitivityMarkdown(report));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
