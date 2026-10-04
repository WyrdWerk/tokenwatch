/**
 * Workload presets for recommendation. All cost mixes are percentage shares;
 * benchmark percentiles and provider metric scores are catalog-relative;
 * qualityFloor is an absolute minimum on the use case's primary benchmark.
 * Worker-safe: no Node built-ins or runtime-only dependencies.
 */

import { AGENTIC_MIX } from './cost.mjs';

const LOW_BIT_QUANTS = ['fp4', 'nvfp4', 'mxfp4', 'int4', 'int4-mixed-ar'];

export const USE_CASES = Object.freeze({
  'agentic-coding': {
    id: 'agentic-coding',
    label: 'Agentic coding',
    mix: AGENTIC_MIX,
    // Agentic benchmark results lead; coding and broad intelligence backfill
    // the thin agentic set, with LiveBench agentic coding as a smaller signal.
    benchmarkWeights: { agentic_index: 0.45, coding_index: 0.3, intelligence_index: 0.15, livebench_agentic_coding: 0.1 },
    // Agents reward decode speed and uptime, while a cache-heavy mix keeps
    // price material without allowing the cheapest weak model to win outright.
    providerWeights: { price: 0.25, ttft: 0.2, throughput: 0.35, uptime: 0.2 },
    hardRequirements: { needsToolCalling: true, needsStructuredOutput: false, minContext: 32768 },
    quantizationPolicy: { reject: LOW_BIT_QUANTS, fallbackWhenNoAlternative: true },
    // Current tool-capable open weights have coding-index p25≈20.7 and median≈43.4.
    qualityFloor: { field: 'coding_index', min: 25 },
  },
  'tool-agents': {
    id: 'tool-agents',
    label: 'Tool-using agents',
    mix: { inputPct: 5, cacheReadPct: 90, outputPct: 5 },
    // Agentic and instruction-following scores best approximate tool loops;
    // intelligence and coding add coverage when LiveBench is absent.
    benchmarkWeights: { agentic_index: 0.4, intelligence_index: 0.25, coding_index: 0.2, livebench_instruction_following: 0.15 },
    // Reliability and token generation dominate repeated tool turns; price
    // still matters because loops multiply both input and output volume.
    providerWeights: { price: 0.25, ttft: 0.2, throughput: 0.35, uptime: 0.2 },
    hardRequirements: { needsToolCalling: true, needsStructuredOutput: false, minContext: 16384 },
    quantizationPolicy: { reject: LOW_BIT_QUANTS, fallbackWhenNoAlternative: true },
    // Current tool-capable open weights have agentic-index p25≈1 and median≈13.1.
    qualityFloor: { field: 'agentic_index', min: 10 },
  },
  'long-context-rag': {
    id: 'long-context-rag',
    label: 'Long-context RAG',
    mix: { inputPct: 8, cacheReadPct: 87, outputPct: 5 },
    // Broad intelligence and reasoning/data-analysis are useful proxies for
    // retrieval synthesis; LiveBench category coverage is explicitly sparse.
    benchmarkWeights: { intelligence_index: 0.4, agentic_index: 0.2, livebench_reasoning: 0.15, livebench_data_analysis: 0.15, livebench_language: 0.1 },
    // Large prompts make input price important; TTFT and uptime matter for
    // interactive retrieval chains that repeatedly fetch context.
    providerWeights: { price: 0.35, ttft: 0.2, throughput: 0.2, uptime: 0.25 },
    hardRequirements: { needsToolCalling: false, needsStructuredOutput: false, minContext: 131072 },
    quantizationPolicy: { reject: LOW_BIT_QUANTS, fallbackWhenNoAlternative: true },
    // Long-context open weights have intelligence-index p25≈11.2 and median≈19.5.
    qualityFloor: { field: 'intelligence_index', min: 15 },
  },
  'structured-extraction': {
    id: 'structured-extraction',
    label: 'Structured extraction',
    mix: { inputPct: 25, cacheReadPct: 65, outputPct: 10 },
    // Instruction-following and data analysis most closely reflect schema
    // adherence; broad intelligence and coding provide thinner-data backstops.
    benchmarkWeights: { livebench_instruction_following: 0.4, livebench_data_analysis: 0.25, intelligence_index: 0.25, coding_index: 0.1 },
    // Extraction often runs at scale; price leads, with generation speed and
    // availability preserving useful batch/interactive behavior.
    providerWeights: { price: 0.35, ttft: 0.2, throughput: 0.25, uptime: 0.2 },
    hardRequirements: { needsToolCalling: false, needsStructuredOutput: true, minContext: 16384 },
    quantizationPolicy: { reject: LOW_BIT_QUANTS, fallbackWhenNoAlternative: true },
    // Only seven current structured-output models have this LiveBench score; 60 is near their median.
    qualityFloor: { field: 'livebench_instruction_following', min: 60 },
  },
  'high-volume-cheap': {
    id: 'high-volume-cheap',
    label: 'High-volume, low-cost',
    mix: { inputPct: 70, cacheReadPct: 20, outputPct: 10 },
    // Broad intelligence sets a quality floor; instruction following and
    // coding are secondary checks for common production text tasks.
    benchmarkWeights: { intelligence_index: 0.5, livebench_instruction_following: 0.3, coding_index: 0.2 },
    // Unit cost dominates at scale; throughput and uptime retain practical
    // weight because a cheap endpoint that cannot serve volume is not cheap.
    providerWeights: { price: 0.55, ttft: 0.1, throughput: 0.2, uptime: 0.15 },
    hardRequirements: { needsToolCalling: false, needsStructuredOutput: false, minContext: 8192 },
    quantizationPolicy: { reject: [], fallbackWhenNoAlternative: true },
    // Current open weights have intelligence-index p25≈11.1; keep this cost-led floor permissive.
    qualityFloor: { field: 'intelligence_index', min: 10 },
  },
  'chat-assistant': {
    id: 'chat-assistant',
    label: 'Chat assistant',
    mix: { inputPct: 60, cacheReadPct: 20, outputPct: 20 },
    // General intelligence anchors quality, with language and instruction
    // following as user-facing conversational signals.
    benchmarkWeights: { intelligence_index: 0.55, livebench_language: 0.25, livebench_instruction_following: 0.2 },
    // Interactive chat values first-token responsiveness and availability;
    // moderate price/throughput weights account for longer sessions.
    providerWeights: { price: 0.25, ttft: 0.3, throughput: 0.2, uptime: 0.25 },
    hardRequirements: { needsToolCalling: false, needsStructuredOutput: false, minContext: 8192 },
    quantizationPolicy: { reject: [], fallbackWhenNoAlternative: true },
    // Current open weights have intelligence-index p25≈11.1 and median≈19.5.
    qualityFloor: { field: 'intelligence_index', min: 15 },
  },
  'creative-writing': {
    id: 'creative-writing',
    label: 'Creative writing',
    mix: { inputPct: 35, cacheReadPct: 10, outputPct: 55 },
    // LiveBench language is the closest available style/fluency proxy; broad
    // intelligence adds coverage without pretending a dedicated writing test exists.
    benchmarkWeights: { livebench_language: 0.65, intelligence_index: 0.35 },
    // Long generations make throughput important, while low TTFT and price
    // still affect the writing-feedback loop and sustained use.
    providerWeights: { price: 0.25, ttft: 0.25, throughput: 0.3, uptime: 0.2 },
    hardRequirements: { needsToolCalling: false, needsStructuredOutput: false, minContext: 16384 },
    quantizationPolicy: { reject: [], fallbackWhenNoAlternative: true },
    // Seven current open weights have LiveBench language scores; p25≈70.1.
    qualityFloor: { field: 'livebench_language', min: 70 },
  },
  'reasoning-math': {
    id: 'reasoning-math',
    label: 'Reasoning and math',
    mix: { inputPct: 25, cacheReadPct: 15, outputPct: 60 },
    // LiveBench math/reasoning lead; AA intelligence and agentic scores fill
    // gaps rather than treating a thin category sample as complete coverage.
    benchmarkWeights: { livebench_math: 0.5, livebench_reasoning: 0.25, intelligence_index: 0.15, agentic_index: 0.1 },
    // Reasoning outputs are long, so throughput matters; price and reliability
    // still constrain repeated or production workloads.
    providerWeights: { price: 0.25, ttft: 0.15, throughput: 0.35, uptime: 0.25 },
    hardRequirements: { needsToolCalling: false, needsStructuredOutput: false, minContext: 32768 },
    quantizationPolicy: { reject: LOW_BIT_QUANTS, fallbackWhenNoAlternative: true },
    // Seven current open weights have LiveBench math scores; the median is≈79.9.
    qualityFloor: { field: 'livebench_math', min: 80 },
  },
  'frontend-ui': {
    id: 'frontend-ui',
    label: 'Frontend and UI development',
    mix: { inputPct: 35, cacheReadPct: 15, outputPct: 50 },
    // Design Arena is the most direct UI signal; coding/agentic and LiveBench
    // coding back it up when Arena coverage is missing.
    benchmarkWeights: { design_arena_best: 0.4, coding_index: 0.35, agentic_index: 0.15, livebench_coding: 0.1 },
    // Coding agents need sustained generation and usable uptime; price and
    // first-token delay remain meaningful for iterative UI work.
    providerWeights: { price: 0.25, ttft: 0.2, throughput: 0.35, uptime: 0.2 },
    hardRequirements: { needsToolCalling: true, needsStructuredOutput: false, minContext: 32768 },
    quantizationPolicy: { reject: LOW_BIT_QUANTS, fallbackWhenNoAlternative: true },
    // UI Arena Elo p25 is≈1120 among current tool-capable open weights.
    qualityFloor: { field: 'design_arena_best', min: 1120 },
  },
});

/** Resolve either a registry key or a use-case object. */
export function getUseCase(useCase) {
  if (typeof useCase === 'string') {
    const resolved = USE_CASES[useCase];
    if (!resolved) throw new RangeError(`Unknown use case: ${useCase}`);
    return resolved;
  }
  if (useCase && typeof useCase === 'object' && useCase.id && useCase.mix) return useCase;
  throw new TypeError('useCase must be a registered id or use-case object');
}
