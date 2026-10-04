import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USE_CASES } from '../shared/use-cases.mjs';
import { buildSensitivityScenarios, runSensitivityAnalysis } from '../scripts/recommender-sensitivity.mjs';

test('sensitivity scenarios perturb every weight, floor, and mix while preserving valid totals', () => {
  const useCase = USE_CASES['agentic-coding'];
  const scenarios = buildSensitivityScenarios(useCase);
  const benchmarkScenarios = scenarios.filter((scenario) => scenario.kind === 'benchmark_weight');
  const providerScenarios = scenarios.filter((scenario) => scenario.kind === 'provider_weight');
  const floorScenarios = scenarios.filter((scenario) => scenario.kind === 'quality_floor');
  const mixScenarios = scenarios.filter((scenario) => scenario.kind === 'mix');

  assert.equal(benchmarkScenarios.length, Object.keys(useCase.benchmarkWeights).length * 2);
  assert.equal(providerScenarios.length, Object.keys(useCase.providerWeights).length * 2);
  assert.equal(floorScenarios.length, 2);
  assert.equal(mixScenarios.length, 3);
  for (const scenario of [...benchmarkScenarios, ...providerScenarios]) {
    const weights = scenario.kind === 'benchmark_weight' ? scenario.override.benchmarkWeights : scenario.override.providerWeights;
    assert.ok(Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  }
  for (const scenario of mixScenarios) {
    const mix = scenario.override.mix;
    assert.equal(mix.inputPct + mix.cacheReadPct + mix.outputPct, 100);
    assert.ok(Object.values(mix).every((value) => value >= 0));
  }
});

test('sensitivity report counts changes and classifies all nine workloads', () => {
  const catalog = [
    ['open/a', 40, 0.2],
    ['open/b', 60, 0.5],
    ['open/c', 80, 1],
  ].map(([id, score, price]) => ({
    id,
    name: id,
    org: 'open',
    provider: id.slice(-1),
    open_weights: true,
    supported_parameters: ['tools', 'structured_outputs', 'response_format'],
    context_length: 1_000_000,
    quantization: 'fp8',
    pricing: { input: price, output: price * 2, cache_read: price / 2, cache_write: null },
    benchmarks: {
      intelligence_index: score,
      coding_index: id === 'open/a' ? 50 : id === 'open/b' ? 100 : 0,
      agentic_index: id === 'open/a' ? 100 : id === 'open/b' ? 50 : 0,
      design_arena_best: 1100 + score * 3,
      livebench_math: score,
      livebench_coding: score,
      livebench_language: score,
      livebench_data_analysis: score,
      livebench_agentic_coding: score,
      livebench_reasoning: score,
      livebench_instruction_following: score,
    },
  }));
  const performance = Object.fromEntries(catalog.map((model, index) => [
    `${model.id.slice(-1)}|${model.provider}`,
    { latency: { p50: 100 + index * 100 }, throughput: { p50: 100 - index * 10 } },
  ]));

  const report = runSensitivityAnalysis({ catalog, benchmarks: { sources: { livebench: { release: '2026-06-25' } }, models: [] }, performance });
  assert.equal(report.useCases.length, 9);
  for (const useCase of report.useCases) {
    for (const pick of ['bestQuality', 'bestValue', 'cheapestAboveFloor', 'topProvider', 'fixedModelTopProvider']) {
      assert.ok(Number.isInteger(useCase.changes[pick].changed));
      assert.ok(Number.isInteger(useCase.changes[pick].total));
      assert.ok(['stable', 'moderately_stable', 'close_call', 'unavailable'].includes(useCase.changes[pick].classification));
    }
  }
  const agentic = report.useCases.find((useCase) => useCase.useCase === 'agentic-coding');
  assert.equal(agentic.changes.topProvider.total, agentic.scenarioCounts.all);
  assert.equal(agentic.changes.fixedModelTopProvider.total, agentic.scenarioCounts.fixedModelTopProvider);
  assert.ok(agentic.changes.topProvider.changed > agentic.changes.fixedModelTopProvider.changed);
});
