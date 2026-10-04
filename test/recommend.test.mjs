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
  benchmarks: { intelligence_index: intelligence, coding_index: intelligence, agentic_index: intelligence },
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
  const shortlistPick = shortlist.bestQuality
    || shortlist.partiallyBenchmarked.find((candidate) => candidate.id === 'mimo-v2.6-pro');

  assert.ok(summary, 'Text model summary can price the same offering');
  assert.ok(shortlistPick, 'the shortlist retains the model even though its benchmark coverage is below the ranking threshold');
  assert.ok(Math.abs(shortlistPick.blendedRate - summary.eff) < 1e-12);
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
  assert.ok(result.bestQuality.reasons.some((reason) => /only qualifying option/i.test(reason)));
  assert.equal(shortlistModels('agentic-coding', catalog, { includeProprietary: true }).bestQuality?.id, 'model');
});

test('shortlist shrinks low-coverage scores and keeps them visible but out of quality and value picks', () => {
  const result = shortlistModels('agentic-coding', [
    mixOffering('open/thin-signal', 'thin', 46.3, 0.01, {
      benchmarks: { intelligence_index: 46.3 },
    }),
    mixOffering('open/full-signal', 'full', 20, 2, {
      benchmarks: {
        agentic_index: 60,
        coding_index: 40,
        intelligence_index: 20,
        livebench_agentic_coding: 60,
      },
    }),
  ]);

  assert.equal(result.bestQuality.id, 'full-signal');
  assert.equal(result.bestValue.id, 'full-signal');
  assert.ok(!result.paretoFrontier.some((candidate) => candidate.id === 'thin-signal'));
  const partial = result.partiallyBenchmarked.find((candidate) => candidate.id === 'thin-signal');
  assert.ok(partial);
  assert.equal(partial.qualityCoverage, 0.15);
  assert.ok(partial.qualityScore < 70, 'the one-signal score is shrunk toward the cohort median');
  assert.ok(partial.reasons.some((reason) => /15%.*cohort median/i.test(reason)));
});

test('shortlist surfaces unknown required capabilities as unverified models', () => {
  const result = shortlistModels('agentic-coding', [
    mixOffering('open/unknown-tools', 'unknown-provider', 80, 1, {
      supported_parameters: null,
      modelsdev: null,
      modelsdev_model: null,
    }),
  ]);

  assert.equal(result.bestQuality, null);
  assert.deepEqual(result.unverified.map((model) => model.id), ['unknown-tools']);
  assert.ok(result.unverified[0].unknowns.some((unknown) => /tool-calling capability not disclosed/i.test(unknown)));
});

test('shortlist excludes subscriptions by default and permits them explicitly', () => {
  const subscription = mixOffering('open/subscription-model', 'opencode-go', 80, 1, {
    subscription: true,
    benchmarks: { agentic_index: 80, coding_index: 80, intelligence_index: 80, livebench_agentic_coding: 80 },
  });
  assert.equal(shortlistModels('agentic-coding', [subscription]).bestQuality, null);

  const included = shortlistModels('agentic-coding', [subscription], { includeSubscription: true });
  assert.equal(included.bestQuality.id, 'subscription-model');
  assert.ok(included.bestQuality.recommendedProvider.reasons.some((reason) => /subscription plan, not pay-as-you-go/i.test(reason)));
});

test('shortlist applies low-bit quantization fallback per model, not across the catalog', () => {
  const result = shortlistModels('agentic-coding', [
    mixOffering('open/fp4-only', 'fp4-provider', 90, 1, {
      quantization: 'int4',
      benchmarks: { agentic_index: 90, coding_index: 90, intelligence_index: 90, livebench_agentic_coding: 90 },
    }),
    mixOffering('open/other-model', 'fp8-provider', 10, 10, {
      quantization: 'fp8',
      benchmarks: { agentic_index: 10, coding_index: 10, intelligence_index: 10, livebench_agentic_coding: 10 },
    }),
  ]);

  assert.equal(result.bestQuality.id, 'fp4-only');
  assert.ok(result.bestQuality.reasons.some((reason) => /low-bit quantization is the only qualifying option/i.test(reason)));
});

test('LiveBench-thin use cases use AA intelligence for the absolute floor', () => {
  for (const useCaseId of ['structured-extraction', 'creative-writing', 'reasoning-math']) {
    assert.deepEqual(USE_CASES[useCaseId].qualityFloor, { field: 'intelligence_index', min: 15 });
  }
  assert.ok(USE_CASES['structured-extraction'].benchmarkWeights.livebench_instruction_following > 0);
  assert.ok(USE_CASES['creative-writing'].benchmarkWeights.livebench_language > 0);
  assert.ok(USE_CASES['reasoning-math'].benchmarkWeights.livebench_math > 0);

  const result = shortlistModels('structured-extraction', [
    mixOffering('open/aa-only', 'structured-provider', 15.1, 1, {
      supported_parameters: ['structured_outputs'],
      benchmarks: { intelligence_index: 15.1 },
    }),
  ]);
  assert.equal(result.cheapestAboveFloor.id, 'aa-only');
  assert.equal(result.cheapestAboveFloor.group, 'partiallyBenchmarked');
  assert.ok(result.cheapestAboveFloor.reasons.some((reason) => /intelligence_index.*absolute floor of 15/i.test(reason)));
});

test('cheapest-above-floor explains when it costs more than bestValue', () => {
  const result = shortlistModels('agentic-coding', [
    mixOffering('open/cheap-below-floor', 'cheap', 100, 1, {
      benchmarks: { agentic_index: 100, coding_index: 24, intelligence_index: 100, livebench_agentic_coding: 100 },
    }),
    mixOffering('open/expensive-above-floor', 'expensive', 0, 10, {
      benchmarks: { agentic_index: 0, coding_index: 30, intelligence_index: 0, livebench_agentic_coding: 0 },
    }),
  ]);
  assert.equal(result.bestValue.id, 'cheap-below-floor');
  assert.equal(result.cheapestAboveFloor.id, 'expensive-above-floor');
  assert.ok(result.cheapestAboveFloor.reasons.some((reason) => /costs more than bestValue/i.test(reason)));
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
  const included = rankProviders('agentic-coding', 'model-a:batch', batchOnly, {}, { includeBatch: true });
  assert.equal(included.ranked[0].provider, 'batch-provider');
  assert.ok(included.ranked[0].reasons.some((reason) => /asynchronous batch endpoint/i.test(reason)));
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

test('rankProviders excludes known provider headquarters without treating unknown HQ as excluded', () => {
  const offerings = [
    mixOffering('open/model-a', 'us-provider', 90, 1),
    mixOffering('open/model-a', 'cn-provider', 90, 0.5),
    mixOffering('open/model-a', 'unknown-provider', 90, 2),
  ];
  const result = rankProviders('agentic-coding', 'model-a', offerings, {}, {
    providersMeta: { 'us-provider': { headquarters: 'US' }, 'cn-provider': { headquarters: 'CN' } },
    excludeHQ: ['CN'],
  });
  assert.deepEqual(result.ranked.map((provider) => provider.provider), ['us-provider', 'unknown-provider']);
});

test('rankProviders excludes requested provider headquarters and explains the exclusion gate', () => {
  const rows = rankProviders('chat-assistant', 'model-a', [
    mixOffering('open/model-a', 'us-host', 90, 1, { headquarters: 'US' }),
    mixOffering('open/model-a', 'cn-host', 90, 0.5, { headquarters: 'CN' }),
    mixOffering('open/model-a', 'unknown-host', 90, 2),
  ], {}, { excludeHQ: ['cn'] });

  assert.deepEqual(rows.ranked.map((row) => row.provider), ['us-host', 'unknown-host']);
  const gate = rows.ranked[0].explanation.gates.find((entry) => entry.key === 'excluded_headquarters');
  assert.deepEqual(gate, {
    key: 'excluded_headquarters',
    applied: true,
    passed: true,
    excluded: ['CN'],
    observed: 'US',
  });
  const unknownGate = rows.ranked.find((row) => row.provider === 'unknown-host').explanation.gates
    .find((entry) => entry.key === 'excluded_headquarters');
  assert.equal(unknownGate.passed, null, 'unknown headquarters remain eligible but are not called verified');
});

test('shortlist provider and price picks use rankProviders gates and expose the top-ranked provider', () => {
  const offerings = [
    mixOffering('open/model-a', 'fast-approved', 90, 5, { zdr: true, uptime_30m: 99.7 }),
    mixOffering('open/model-a', 'cheap-approved', 90, 1, { zdr: true, uptime_30m: 99.5 }),
    mixOffering('open/model-a', 'blocked-zdr', 90, 0.1, { zdr: false, uptime_30m: 100 }),
    mixOffering('open/model-a', 'blocked-issue', 90, 0.2, { zdr: true, uptime_30m: 99.9 }),
  ];
  const performance = {
    'model-a|fast-approved': { latency: { p50: 100 }, throughput: { p50: 100 } },
    'model-a|cheap-approved': { latency: { p50: 10000 }, throughput: { p50: 1 } },
  };
  const constraints = {
    requireZdr: true,
    minUptime: 99,
    knownIssues: [{ canonicalId: 'model-a', provider: 'blocked-issue', verdict: 'unavailable' }],
  };
  const result = shortlistModels('agentic-coding', offerings, { performance, constraints });

  assert.equal(result.bestQuality.recommendedProvider.provider, 'fast-approved');
  assert.equal(result.bestQuality.provider, 'fast-approved');
  assert.equal(result.bestQuality.recommendedProvider.blendedRate, 5);
  assert.deepEqual(result.bestQuality.providers.map((provider) => provider.provider), ['fast-approved', 'cheap-approved']);
  assert.equal(result.bestQuality.cheapestProvider.provider, 'cheap-approved');
  assert.equal(result.bestQuality.blendedRate, 1, 'Pareto price uses the cheapest provider that passes all gates');
  assert.ok(!['blocked-zdr', 'blocked-issue'].includes(result.bestQuality.cheapestProvider?.provider));
});

test('rankProviders makes a priced workload mix a hard gate', () => {
  const result = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'unpriced-fast', 90, 1, {
      pricing: { input: null, output: null, cache_read: null, cache_write: null },
      uptime_30m: 100,
    }),
    mixOffering('open/model-a', 'priced', 90, 2, { uptime_30m: 99 }),
  ], {
    'model-a|unpriced-fast': { latency: { p50: 1 }, throughput: { p50: 10000 } },
  });
  assert.deepEqual(result.ranked.map((row) => row.provider), ['priced']);
  assert.ok(result.ranked[0].reasons.some((reason) => /only qualifying option/i.test(reason)));
  assert.ok(!result.ranked[0].reasons.some((reason) => /lowest blended price among eligible/i.test(reason)));
});

test('uptime uses explicit percent units, prefers 30-minute data, and labels its window', () => {
  const result = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'short-window', 90, 1, { uptime_30m: 99.25, uptime_1d: 100 }),
    mixOffering('open/model-a', 'daily-fallback', 90, 2, { uptime_30m: null, uptime_1d: 99.75 }),
  ], {});
  const short = result.ranked.find((row) => row.provider === 'short-window');
  const daily = result.ranked.find((row) => row.provider === 'daily-fallback');
  assert.equal(short.uptime, 99.25);
  assert.equal(short.uptimeWindow, '30m');
  assert.ok(short.reasons.some((reason) => /30-minute.*99\.25%/i.test(reason)));
  assert.equal(daily.uptimeWindow, '1d');
  assert.ok(daily.reasons.some((reason) => /1-day.*99\.75%/i.test(reason)));

  const fractional = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'fraction-not-percent', 90, 1, { uptime_30m: 0.99 }),
  ], {}, { minUptime: 99 });
  assert.deepEqual(fractional.ranked, [], '0.99 in a percent-valued field means 0.99%, not 99%');
});

test('latency reasons name the telemetry source and measurement window', () => {
  const result = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'openrouter', 90, 1),
    mixOffering('open/model-a', 'coralbricks', 90, 2),
    mixOffering('open/model-a', 'lilac', 90, 3),
    mixOffering('open/model-a', 'umans', 90, 4),
  ], {
    'model-a|openrouter': { latency: { p50: 123 } },
    'model-a|coralbricks': { source: 'coralbricks', latency: { p50: 456, window: '1d' } },
    'model-a|lilac': { latency: { p50: 654 } },
    'model-a|umans': { latency: { ttft_ms: { p50: 789 } } },
  });
  assert.ok(result.ranked.find((row) => row.provider === 'openrouter').reasons
    .some((reason) => /OpenRouter 30-minute TTFT p50: 123 ms/i.test(reason)));
  assert.ok(result.ranked.find((row) => row.provider === 'coralbricks').reasons
    .some((reason) => /CoralBricks 1-day TTFT p50: 456 ms/i.test(reason)));
  assert.ok(result.ranked.find((row) => row.provider === 'lilac').reasons
    .some((reason) => /Lilac 1-hour TTFT p50: 654 ms/i.test(reason)));
  assert.ok(result.ranked.find((row) => row.provider === 'umans').reasons
    .some((reason) => /Umans window not disclosed TTFT p50: 789 ms/i.test(reason)));
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

test('each model pick and ranked provider carries a source-attributed explanation and confidence', () => {
  const result = shortlistModels('agentic-coding', FRONTIER_CATALOG, {
    benchmarks: {
      sources: { livebench: { release: '2026-06-25' } },
      models: [{ id: 'model-a', scores: { livebench_agentic_coding: 72 } }],
    },
    performance: {
      'model-a|alpha': { latency: { p50: 120 }, throughput: { p50: 90 } },
    },
  });

  for (const pick of [result.bestQuality, result.bestValue, result.cheapestAboveFloor]) {
    assert.ok(pick?.explanation, `${pick?.id} has an explanation payload`);
    assert.deepEqual(pick.explanation.mix, USE_CASES['agentic-coding'].mix);
    assert.equal(pick.explanation.priority, 'balanced');
    assert.ok(pick.explanation.weights.benchmark.agentic_index > 0);
    assert.ok(pick.explanation.gates.some((gate) => gate.key === 'tool_calling' && gate.passed));
    assert.equal(typeof pick.confidence.level, 'string');
    assert.ok(pick.explanation.benchmark.signals.some((signal) =>
      signal.field === 'agentic_index'
      && signal.rawValue === pick.offering.benchmarks.agentic_index
      && signal.source.name === 'Artificial Analysis via OpenRouter'));
    assert.ok(Number.isFinite(pick.explanation.benchmark.shrinkage.missingWeight));
  }
  const bestValueLiveBench = result.bestValue.explanation.benchmark.signals.find((signal) => signal.field === 'livebench_agentic_coding');
  assert.equal(bestValueLiveBench.rawValue, 72);
  assert.equal(bestValueLiveBench.source.release, '2026-06-25');
  assert.ok(result.bestQuality.explanation.benchmark.missingSignals.some((signal) => signal.field === 'livebench_agentic_coding'));

  const providers = rankProviders('agentic-coding', 'model-a', [
    mixOffering('open/model-a', 'alpha', 90, 1, { uptime_30m: 99.8 }),
    mixOffering('open/model-a', 'beta', 90, 2, { uptime_30m: 99.6 }),
  ], {
    'model-a|alpha': { latency: { p50: 120 }, throughput: { p50: 90 } },
  });
  assert.ok(providers.ranked.every((provider) => provider.explanation));
  assert.ok(providers.ranked.every((provider) => provider.confidence));
  const alpha = providers.ranked.find((provider) => provider.provider === 'alpha');
  assert.ok(alpha.explanation.signals.some((signal) =>
    signal.field === 'ttft' && signal.source.name === 'OpenRouter' && signal.source.window === '30m'));
  assert.ok(alpha.explanation.signals.some((signal) =>
    signal.field === 'uptime' && signal.source.name === 'OpenRouter' && signal.source.window === '30m'));
  const beta = providers.ranked.find((provider) => provider.provider === 'beta');
  assert.ok(beta.explanation.missingSignals.some((signal) => signal.field === 'throughput'));
  assert.ok(alpha.explanation.gates.some((gate) => gate.key === 'minimum_context' && gate.passed));
});

test('provider priority presets override use-case weights and reject unknown priorities', () => {
  const offerings = [
    mixOffering('open/model-a', 'cheap', 90, 1, { uptime_30m: 99 }),
    mixOffering('open/model-a', 'fast', 90, 10, { uptime_30m: 99.5 }),
    mixOffering('open/model-a', 'reliable', 90, 5, { uptime_30m: 99.99 }),
  ];
  const performance = {
    'model-a|cheap': { latency: { p50: 10000 }, throughput: { p50: 1 } },
    'model-a|fast': { latency: { p50: 100 }, throughput: { p50: 100 } },
    'model-a|reliable': { latency: { p50: 1000 }, throughput: { p50: 20 } },
  };

  assert.equal(rankProviders('agentic-coding', 'model-a', offerings, performance, { priority: 'cheapest' }).ranked[0].provider, 'cheap');
  assert.equal(rankProviders('agentic-coding', 'model-a', offerings, performance, { priority: 'fastest' }).ranked[0].provider, 'fast');
  assert.equal(rankProviders('agentic-coding', 'model-a', offerings, performance, { priority: 'most-reliable' }).ranked[0].provider, 'reliable');
  const shortlist = shortlistModels('agentic-coding', offerings, { performance, priority: 'fastest' });
  assert.equal(shortlist.bestQuality.recommendedProvider.provider, 'fast');
  assert.equal(shortlist.bestQuality.explanation.priority, 'fastest');
  assert.equal(shortlist.bestQuality.explanation.weights.provider.throughput, 0.4);
  assert.throws(() => rankProviders('agentic-coding', 'model-a', offerings, performance, { priority: 'fastest-ish' }), /Unknown provider priority/);
  assert.throws(() => shortlistModels('agentic-coding', offerings, {
    priority: 'fastest-ish',
    scenario: { providerWeights: { price: 1 } },
  }), /Unknown provider priority/);
});
