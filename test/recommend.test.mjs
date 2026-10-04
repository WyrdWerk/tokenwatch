import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USE_CASES } from '../shared/use-cases.mjs';
import { rankProviders, shortlistModels } from '../shared/recommend.mjs';
import { AGENTIC_MIX } from '../shared/cost.mjs';
import { rankOfferings } from '../shared/model-summary.mjs';

const mixOffering = (id, provider, intelligence, input, extra = {}) => ({
  id,
  name: id,
  provider,
  open_weights: true,
  open_weights_source: 'fixture',
  supported_parameters: ['tools'],
  context_length: 65536,
  quantization: 'fp8',
  pricing: { input, output: input, cache_read: input, cache_write: null },
  benchmarks: { intelligence_index: intelligence, coding_index: intelligence },
  ...extra,
});

const FRONTIER_CATALOG = [
  mixOffering('open/model-a', 'alpha', 90, 10),
  mixOffering('open/model-b', 'beta', 80, 2),
  mixOffering('open/model-c', 'gamma', 70, 10),
  mixOffering('open/model-d', 'delta', 95, 20),
];

test('use-case registry defines all nine workloads with complete token mixes and policies', () => {
  assert.deepEqual(Object.keys(USE_CASES), [
    'agentic-coding', 'tool-agents', 'long-context-rag', 'structured-extraction',
    'high-volume-cheap', 'chat-assistant', 'creative-writing', 'reasoning-math', 'frontend-ui',
  ]);
  for (const useCase of Object.values(USE_CASES)) {
    const mix = useCase.mix;
    assert.equal(mix.inputPct + mix.cacheReadPct + mix.outputPct, 100, `${useCase.id} mix`);
    assert.ok(useCase.benchmarkWeights && Object.keys(useCase.benchmarkWeights).length);
    assert.ok(useCase.providerWeights && Object.keys(useCase.providerWeights).length);
    assert.ok(useCase.qualityFloor?.field && Number.isFinite(useCase.qualityFloor.min));
    assert.ok(Object.hasOwn(useCase.benchmarkWeights, useCase.qualityFloor.field), `${useCase.id} floors a weighted primary benchmark`);
    assert.ok(Math.abs(Object.values(useCase.benchmarkWeights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
    assert.ok(Math.abs(Object.values(useCase.providerWeights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  }
});

test('shortlist blended price stays in parity with the Text model summary in dollars per million', () => {
  const mimo = mixOffering('XiaomiMiMo/MiMo-V2.6-Pro', 'deepinfra', 46.3, 0.43, {
    context_length: 1048576,
    quantization: null,
    pricing: { input: 0.43, output: 0.87, cache_read: 0.0036, cache_write: null },
    benchmarks: { intelligence_index: 46.3, coding_index: 46.3 },
  });
  const summary = rankOfferings([mimo], AGENTIC_MIX)[0];
  const shortlist = shortlistModels('agentic-coding', [mimo]);

  assert.ok(summary, 'Text model summary can price the same offering');
  assert.ok(Math.abs(shortlist.bestQuality.blendedRate - summary.eff) < 1e-12);
  assert.ok(Math.abs(summary.eff - 0.018592) < 1e-12);
  assert.ok(Math.abs((summary.eff * 1000 / 1e6) - 0.000018592) < 1e-12,
    '1,000-token session cost is distinct from the $/M blended rate');
});

test('shortlist applies open-weight, capability, and context hard requirements', () => {
  const catalog = [
    mixOffering('open/qualified', 'p1', 80, 1),
    mixOffering('open/no-tools', 'p2', 95, 1, { supported_parameters: [], modelsdev: { capabilities: { tool_call: false } } }),
    mixOffering('open/short-context', 'p3', 99, 1, { context_length: 4096 }),
    mixOffering('closed/model', 'p4', 100, 1, { open_weights: false }),
    mixOffering('unknown/model', 'p5', 100, 1, { open_weights: null }),
  ];
  const result = shortlistModels('agentic-coding', catalog);
  assert.deepEqual(
    [result.bestQuality?.id, result.bestValue?.id, result.cheapestAboveFloor?.id],
    ['qualified', 'qualified', 'qualified'],
  );
  assert.equal(shortlistModels('agentic-coding', catalog, { includeProprietary: true }).bestQuality?.id, 'model');
});

test('shortlist selects a quality/price Pareto knee without ranking by score-to-price ratio', () => {
  const result = shortlistModels('agentic-coding', FRONTIER_CATALOG);
  assert.equal(result.bestQuality.id, 'model-d');
  assert.equal(result.bestValue.id, 'model-a');
  assert.equal(result.cheapestAboveFloor.id, 'model-b');
  assert.deepEqual(result.paretoFrontier.map((model) => model.id), ['model-b', 'model-a', 'model-d']);
  assert.ok(result.paretoFrontier.every((model) => Number.isFinite(model.blendedRate)));
});

test('cheapest-above-floor uses the use-case absolute primary-benchmark threshold', () => {
  const result = shortlistModels('agentic-coding', [
    mixOffering('open/below-floor', 'cheap', 90, 0.01, {
      benchmarks: { intelligence_index: 90, coding_index: 24.9 },
    }),
    mixOffering('open/at-floor', 'qualified', 25, 2, {
      benchmarks: { intelligence_index: 25, coding_index: 25 },
    }),
  ]);
  assert.deepEqual(result.qualityFloor, { field: 'coding_index', min: 25 });
  assert.equal(result.cheapestAboveFloor.id, 'at-floor');
  assert.ok(result.cheapestAboveFloor.reasons.some((reason) => /coding_index.*absolute floor of 25/i.test(reason)));
});

test('unbenchmarked models are returned explicitly and never enter ranked picks', () => {
  const catalog = [
    ...FRONTIER_CATALOG,
    mixOffering('open/no-benchmark', 'cheap', null, 0.01, { benchmarks: null }),
  ];
  const result = shortlistModels('agentic-coding', catalog);
  assert.deepEqual(result.unbenchmarked.map((model) => model.id), ['no-benchmark']);
  assert.ok(![
    result.bestQuality.id,
    result.bestValue.id,
    result.cheapestAboveFloor.id,
  ].includes('no-benchmark'));
});

test('batch variants are excluded by default and enabled only by option or high-volume-cheap', () => {
  const batchOnly = [mixOffering('open/model-a:batch', 'batch-provider', 90, 1)];
  assert.equal(shortlistModels('agentic-coding', batchOnly).bestQuality, null);
  assert.equal(shortlistModels('agentic-coding', batchOnly, { includeBatch: true }).bestQuality.id, 'model-a:batch');
  assert.equal(shortlistModels('high-volume-cheap', batchOnly).bestQuality.id, 'model-a:batch');

  assert.deepEqual(rankProviders('agentic-coding', 'model-a:batch', batchOnly, {}).ranked, []);
  assert.equal(rankProviders('agentic-coding', 'model-a:batch', batchOnly, {}, { includeBatch: true }).ranked[0].provider, 'batch-provider');
  assert.equal(rankProviders('high-volume-cheap', 'model-a:batch', batchOnly, {}).ranked[0].provider, 'batch-provider');
});

test('shortlist loads thin LiveBench fields and falls back to models.dev only when the direct field is absent', () => {
  const legacy = mixOffering('open/a', 'a', null, 10, { modelsdev: { open_weights: true } });
  delete legacy.open_weights;
  const catalog = [
    legacy,
    mixOffering('open/b', 'b', null, 1, { open_weights: false, modelsdev: { open_weights: true } }),
    mixOffering('open/c', 'c', null, 0.5, { open_weights: null, modelsdev: { open_weights: true } }),
  ];
  const result = shortlistModels('reasoning-math', catalog, {
    benchmarks: {
      models: [
        { id: 'a', scores: { livebench_math: 90, livebench_reasoning: 85 } },
        { id: 'b', scores: { livebench_math: 99, livebench_reasoning: 95 } },
        { id: 'c', scores: { livebench_math: 100, livebench_reasoning: 100 } },
      ],
    },
  });
  assert.equal(result.bestQuality.id, 'a');
  assert.equal(result.bestQuality.openWeightsSource, 'models.dev');
  assert.deepEqual(result.paretoFrontier.map((model) => model.id), ['a']);
});

test('shortlist consumes AA aliases from public benchmarks.json when catalog benchmark fields are absent', () => {
  const catalog = [
    mixOffering('open/a', 'a', null, 2, { benchmarks: null }),
    mixOffering('open/b', 'b', null, 1, { benchmarks: null }),
  ];
  const result = shortlistModels('agentic-coding', catalog, {
    benchmarks: {
      models: [
        { id: 'a', scores: { aa_agentic: 80, aa_coding: 70 } },
        { id: 'b', scores: { aa_agentic: 60, aa_coding: 50 } },
      ],
    },
  });
  assert.equal(result.bestQuality.id, 'a');
  assert.equal(result.unbenchmarked.length, 0);
});

test('rankProviders gates required capability, context, ZDR, HQ, and uptime before ranking', () => {
  const offerings = [
    mixOffering('open/model-a', 'eligible', 90, 1, {
      zdr: true,
      headquarters: 'US',
      uptime_1d: 99.9,
      supports_tool_choice: true,
    }),
    mixOffering('open/model-a', 'no-zdr', 90, 0.5, { zdr: false, headquarters: 'US', uptime_1d: 99.9 }),
    mixOffering('open/model-a', 'low-uptime', 90, 0.2, { zdr: true, headquarters: 'US', uptime_1d: 95 }),
    mixOffering('open/model-a', 'wrong-hq', 90, 0.3, { zdr: true, headquarters: 'CN', uptime_1d: 99.9 }),
    mixOffering('open/model-a', 'missing-tools', 90, 0.1, { supported_parameters: [], modelsdev: { capabilities: { tool_call: false } } }),
  ];
  const rows = rankProviders('agentic-coding', 'open/model-a', offerings, {}, {
    requireZdr: true,
    requireHQ: 'US',
    minUptime: 99,
  });
  assert.deepEqual(rows.ranked.map((row) => row.provider), ['eligible']);
  assert.ok(rows.ranked[0].reasons.some((reason) => /tool.calling/i.test(reason)));
  assert.ok(rows.ranked[0].reasons.some((reason) => /ZDR/i.test(reason)));
});

test('structured-extraction requires explicit structured-output support', () => {
  const rows = rankProviders('structured-extraction', 'model-a', [
    mixOffering('open/model-a', 'response-format', 90, 1, { supported_parameters: ['response_format'] }),
    mixOffering('open/model-a', 'structured-outputs', 90, 2, { supported_parameters: ['structured_outputs'] }),
    mixOffering('open/model-a', 'parameter-list-omits-structured-output', 90, 2.5, { supported_parameters: ['tools'], modelsdev: { capabilities: { structured_output: true } } }),
    mixOffering('open/model-a', 'modelsdev-flag', 90, 3, { supported_parameters: null, modelsdev: { capabilities: { structured_output: true } } }),
    mixOffering('open/model-a', 'unknown', 90, 0.1, { supported_parameters: null }),
  ], {});
  assert.deepEqual(rows.ranked.map((row) => row.provider), ['response-format', 'structured-outputs', 'modelsdev-flag']);
  assert.deepEqual(rows.unverified.map((row) => row.provider), ['unknown']);
  assert.ok(rows.ranked[0].reasons.some((reason) => /structured.output/i.test(reason)));
});

test('rankProviders resolves tool support from supported_parameters then models.dev fallbacks', () => {
  const offerings = [
    mixOffering('open/model-a', 'explicit', 90, 1, { supported_parameters: ['tools'], modelsdev: { capabilities: { tool_call: false } } }),
    mixOffering('open/model-a', 'parameter-list-omits-tools', 90, 1.5, { supported_parameters: ['response_format'], modelsdev: { tool_call: true } }),
    mixOffering('open/model-a', 'modelsdev', 90, 2, { supported_parameters: null, modelsdev: { tool_call: true } }),
    mixOffering('open/model-a', 'modelsdev-nested', 90, 2.5, { supported_parameters: null, modelsdev: { capabilities: { tool_call: true } } }),
    mixOffering('open/model-a', 'modelsdev-model', 90, 3, { supported_parameters: null, modelsdev_model: { tool_call: true } }),
    mixOffering('open/model-a', 'unknown', 90, 0.1, { supported_parameters: null }),
  ];
  const rows = rankProviders('agentic-coding', 'model-a', offerings, {});
  assert.ok(!rows.ranked.some((row) => row.provider === 'parameter-list-omits-tools'),
    'a present supported_parameters array is authoritative even when models.dev claims tool support');
  assert.deepEqual(rows.ranked.map((row) => row.provider), ['explicit', 'modelsdev', 'modelsdev-nested', 'modelsdev-model']);
  assert.deepEqual(rows.unverified.map((row) => row.provider), ['unknown']);
});

test('unknown required capabilities are returned separately, while confirmed providers stay ranked', () => {
  const offerings = [
    mixOffering('open/model-a', 'confirmed', 90, 1),
    mixOffering('open/model-a', 'unknown', 90, 2, { supported_parameters: null }),
    mixOffering('open/model-a', 'unknown-lowbit', 90, 2.5, { supported_parameters: null, quantization: 'int4' }),
    mixOffering('open/model-a', 'unknown-context', 90, 3, { supported_parameters: ['tools'], context_length: null }),
    mixOffering('open/model-a', 'unsupported', 90, 0.1, {
      supported_parameters: null,
      modelsdev: { capabilities: { tool_call: false } },
    }),
  ];
  const result = rankProviders('agentic-coding', 'model-a', offerings, {});
  assert.deepEqual(result.ranked.map((row) => row.provider), ['confirmed']);
  assert.deepEqual(result.unverified.map((row) => row.provider), ['unknown', 'unknown-lowbit', 'unknown-context']);
  assert.ok(result.unverified[0].reasons.some((reason) => /tool.calling.*unknown/i.test(reason)));
  assert.ok(result.unverified[0].unknowns.some((reason) => /tool.calling capability not disclosed/i.test(reason)));
  assert.ok(result.unverified[1].reasons.some((reason) => /unverified and is not recommended/i.test(reason)));
  assert.ok(result.unverified[2].unknowns.some((reason) => /prompt capacity is unknown/i.test(reason)));
  assert.equal(result.message, null);

  const noConfirmed = rankProviders('agentic-coding', 'model-a', [offerings[1]], {});
  assert.deepEqual(noConfirmed.ranked, []);
  assert.match(noConfirmed.message, /no confirmed providers/i);
});

test('demanding-use-case quant policy prefers non-fp4/int4 and falls back only if needed', () => {
  const mixed = [
    mixOffering('open/model-a', 'full', 90, 10, { quantization: 'fp8' }),
    mixOffering('open/model-a', 'lowbit', 90, 1, { quantization: 'int4' }),
    ...['fp4', 'nvfp4', 'mxfp4', 'int4-mixed-ar'].map((quantization, index) =>
      mixOffering('open/model-a', `lowbit-${quantization}`, 90, index + 2, { quantization })),
    mixOffering('open/model-a', 'unknown-quant', 90, 2, { quantization: 'unknown' }),
  ];
  const preferred = rankProviders('agentic-coding', 'model-a', mixed, {});
  assert.deepEqual(preferred.ranked.map((row) => row.provider).sort(), ['full', 'unknown-quant']);
  assert.ok(preferred.ranked.find((row) => row.provider === 'unknown-quant').unknowns.includes('quantization not disclosed'));

  for (const lowBit of mixed.filter((row) => row.provider.startsWith('lowbit'))) {
    const fallback = rankProviders('agentic-coding', 'model-a', [lowBit], {});
    assert.deepEqual(fallback.ranked.map((row) => row.provider), [lowBit.provider]);
    assert.ok(fallback.ranked[0].reasons.some((reason) => /low-bit quantization is the only qualifying/i.test(reason)));
  }
});

test('rankProviders uses shared blended cost, exposes performance unknowns, and reports known issues', () => {
  const offerings = [
    mixOffering('open/model-a', 'fast', 90, 1, { quantization: 'fp8' }),
    mixOffering('open/model-a', 'slow', 90, 2, { quantization: 'fp8' }),
  ];
  const rows = rankProviders('agentic-coding', 'model-a', offerings, {
    'model-a|fast': { latency: { p50: 100 }, throughput: { p50: 100 }, uptime: { p50: 99 } },
  }, {
    knownIssues: [{ canonicalId: 'model-a', provider: 'slow', verdict: 'degraded', source: 'provider status page' }],
  });
  assert.equal(rows.ranked[0].provider, 'fast');
  assert.ok(rows.ranked[0].score > rows.ranked[1].score);
  assert.ok(rows.ranked[0].reasons.some((reason) => /blended/i.test(reason)));
  assert.ok(rows.ranked[1].unknowns.some((reason) => /TTFT/i.test(reason)));
  assert.ok(rows.ranked[1].reasons.some((reason) => /known issue.*degraded warning.*provider status page/i.test(reason)));
});

test('rankProviders labels subscription offerings as not pay-as-you-go', () => {
  const result = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'confirmed-subscription', 90, 1, { subscription: true }),
    mixOffering('open/model-a', 'unverified-subscription', 90, 2, { subscription: true, supported_parameters: null }),
  ], {});

  assert.ok(result.ranked[0].reasons.some((reason) => /subscription plan, not pay-as-you-go/i.test(reason)));
  assert.ok(result.unverified[0].reasons.some((reason) => /subscription plan, not pay-as-you-go/i.test(reason)));
});

test('broken and unavailable known-issue verdicts gate providers while degraded only warns', () => {
  const rows = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'broken', 90, 1),
    mixOffering('open/model-a', 'unavailable', 90, 1.5),
    mixOffering('open/model-a', 'degraded', 90, 2),
  ], {}, {
    knownIssues: [
      { canonicalId: 'model-a', provider: 'broken', verdict: 'broken', source: 'incident report' },
      { canonicalId: 'model-a', provider: 'unavailable', verdict: 'unavailable', source: 'status page' },
      { canonicalId: 'model-a', provider: 'degraded', verdict: 'degraded', source: 'status page' },
    ],
  });
  assert.deepEqual(rows.ranked.map((row) => row.provider), ['degraded']);
  assert.ok(rows.ranked[0].reasons.some((reason) => /known issue \(degraded warning\).*status page/i.test(reason)));
});

test('reasoning flag is informational and never a reasoning-math gate', () => {
  const result = rankProviders('reasoning-math', 'model-a', [
    mixOffering('open/model-a', 'reports-false', 90, 1, { modelsdev: { capabilities: { reasoning: false } } }),
    mixOffering('open/model-a', 'not-disclosed', 90, 2, { modelsdev: null, modelsdev_model: null }),
  ], {});
  assert.equal(USE_CASES['reasoning-math'].hardRequirements.needsReasoning, undefined);
  assert.deepEqual(result.ranked.map((row) => row.provider), ['reports-false', 'not-disclosed']);
  assert.ok(result.ranked[0].reasons.some((reason) => /reasoning.*informational only/i.test(reason)));
  assert.ok(result.ranked[1].unknowns.some((reason) => /reasoning.*informational only/i.test(reason)));
});
