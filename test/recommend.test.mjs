import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USE_CASES } from '../shared/use-cases.mjs';
import { rankProviders, shortlistModels } from '../shared/recommend.mjs';

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
  benchmarks: { intelligence_index: intelligence },
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
    assert.ok(Math.abs(Object.values(useCase.benchmarkWeights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
    assert.ok(Math.abs(Object.values(useCase.providerWeights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  }
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
  const result = shortlistModels('agentic-coding', FRONTIER_CATALOG, { qualityFloor: 30 });
  assert.equal(result.bestQuality.id, 'model-d');
  assert.equal(result.bestValue.id, 'model-a');
  assert.equal(result.cheapestAboveFloor.id, 'model-b');
  assert.deepEqual(result.paretoFrontier.map((model) => model.id), ['model-b', 'model-a', 'model-d']);
  assert.ok(result.paretoFrontier.every((model) => Number.isFinite(model.blendedRate)));
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
  assert.deepEqual(rows.map((row) => row.provider), ['eligible']);
  assert.ok(rows[0].reasons.some((reason) => /tool.calling/i.test(reason)));
  assert.ok(rows[0].reasons.some((reason) => /ZDR/i.test(reason)));
});

test('structured-extraction requires explicit structured-output support', () => {
  const rows = rankProviders('structured-extraction', 'model-a', [
    mixOffering('open/model-a', 'response-format', 90, 1, { supported_parameters: ['response_format'] }),
    mixOffering('open/model-a', 'structured-outputs', 90, 2, { supported_parameters: ['structured_outputs'] }),
    mixOffering('open/model-a', 'modelsdev-flag', 90, 3, { supported_parameters: null, modelsdev: { capabilities: { structured_output: true } } }),
    mixOffering('open/model-a', 'unknown', 90, 0.1, { supported_parameters: null }),
  ], {});
  assert.deepEqual(rows.map((row) => row.provider), ['response-format', 'structured-outputs', 'modelsdev-flag']);
  assert.ok(rows[0].reasons.some((reason) => /structured.output/i.test(reason)));
});

test('rankProviders resolves tool support from supported_parameters then models.dev fallbacks', () => {
  const offerings = [
    mixOffering('open/model-a', 'explicit', 90, 1, { supported_parameters: ['tools'], modelsdev: { capabilities: { tool_call: false } } }),
    mixOffering('open/model-a', 'modelsdev', 90, 2, { supported_parameters: null, modelsdev: { capabilities: { tool_call: true } } }),
    mixOffering('open/model-a', 'modelsdev-model', 90, 3, { supported_parameters: null, modelsdev_model: { tool_call: true } }),
    mixOffering('open/model-a', 'unknown', 90, 0.1, { supported_parameters: null }),
  ];
  const rows = rankProviders('agentic-coding', 'model-a', offerings, {});
  assert.deepEqual(rows.map((row) => row.provider), ['explicit', 'modelsdev', 'modelsdev-model']);
});

test('demanding-use-case quant policy prefers non-fp4/int4 and falls back only if needed', () => {
  const mixed = [
    mixOffering('open/model-a', 'full', 90, 10, { quantization: 'fp8' }),
    mixOffering('open/model-a', 'lowbit', 90, 1, { quantization: 'int4' }),
    mixOffering('open/model-a', 'unknown-quant', 90, 2, { quantization: 'unknown' }),
  ];
  const preferred = rankProviders('agentic-coding', 'model-a', mixed, {});
  assert.deepEqual(preferred.map((row) => row.provider).sort(), ['full', 'unknown-quant']);
  assert.ok(preferred.find((row) => row.provider === 'unknown-quant').unknowns.includes('quantization not disclosed'));

  const fallback = rankProviders('agentic-coding', 'model-a', [mixed[1]], {});
  assert.deepEqual(fallback.map((row) => row.provider), ['lowbit']);
  assert.ok(fallback[0].reasons.some((reason) => /low-bit quantization is the only qualifying/i.test(reason)));
});

test('rankProviders uses shared blended cost, exposes performance unknowns, and reports known issues', () => {
  const offerings = [
    mixOffering('open/model-a', 'fast', 90, 1, { quantization: 'fp8' }),
    mixOffering('open/model-a', 'slow', 90, 2, { quantization: 'fp8' }),
  ];
  const rows = rankProviders('agentic-coding', 'model-a', offerings, {
    'model-a|fast': { latency: { p50: 100 }, throughput: { p50: 100 }, uptime: { p50: 99 } },
  }, {
    knownIssues: [{ canonicalId: 'model-a', provider: 'slow', verdict: 'warn', source: 'provider status page' }],
  });
  assert.equal(rows[0].provider, 'fast');
  assert.ok(rows[0].score > rows[1].score);
  assert.ok(rows[0].reasons.some((reason) => /blended/i.test(reason)));
  assert.ok(rows[1].unknowns.some((reason) => /TTFT/i.test(reason)));
  assert.ok(rows[1].reasons.some((reason) => /known issue.*provider status page/i.test(reason)));
});

test('known issues with an avoid verdict gate a provider out', () => {
  const rows = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'avoid', 90, 1),
    mixOffering('open/model-a', 'ok', 90, 2),
  ], {}, {
    knownIssues: [{ canonicalId: 'model-a', provider: 'avoid', verdict: 'avoid', source: 'incident report' }],
  });
  assert.deepEqual(rows.map((row) => row.provider), ['ok']);
});
