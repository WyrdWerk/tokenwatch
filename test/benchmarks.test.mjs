import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conservativeBase, buildBenchmarkIndex, applyBenchmarkEnrichment } from '../shared/benchmarks.mjs';

// ── conservativeBase: quant suffix stripping ──

test('conservativeBase strips trailing fp8 suffix', () => {
  assert.equal(conservativeBase('z-ai/glm-5.2-fp8'), 'glm-5.2');
});

test('conservativeBase strips trailing nvfp4 suffix', () => {
  assert.equal(conservativeBase('z-ai/glm-5.2-nvfp4'), 'glm-5.2');
});

test('conservativeBase strips trailing int4 suffix', () => {
  assert.equal(conservativeBase('model-x-int4'), 'model-x');
});

test('conservativeBase does not strip mid-string quant tokens', () => {
  // fp8 must be the LAST token, not embedded
  assert.equal(conservativeBase('fp8-model'), 'fp8-model');
});

// ── conservativeBase: SKU suffix stripping ──

test('conservativeBase strips trailing turbo suffix', () => {
  assert.equal(conservativeBase('anthropic/claude-sonnet-5-turbo'), 'claude-sonnet-5');
});

test('conservativeBase strips trailing fast suffix', () => {
  assert.equal(conservativeBase('model-y-fast'), 'model-y');
});

test('conservativeBase strips trailing highspeed suffix', () => {
  assert.equal(conservativeBase('model-z-highspeed'), 'model-z');
});

// ── conservativeBase: NO over-stripping (the critical safety tests) ──

test('conservativeBase does NOT strip size tokens (Qwen3-30B stays distinct)', () => {
  // This is the false-match guard: aggressive stripping would turn this into 'qwen3'
  assert.equal(conservativeBase('qwen/qwen3-30b-a3b'), 'qwen3-30b-a3b');
});

test('conservativeBase does NOT strip version bits', () => {
  // claude-sonnet-4-6 must stay as-is, NOT collapse to claude-sonnet-4
  assert.equal(conservativeBase('anthropic/claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

test('conservativeBase strips only the LAST turbo when multiple suffixes present', () => {
  // -480b-a35b-instruct-turbo → only -turbo stripped, rest preserved
  assert.equal(
    conservativeBase('qwen/qwen3-coder-480b-a35b-instruct-turbo'),
    'qwen3-coder-480b-a35b-instruct'
  );
});

// ── buildBenchmarkIndex ──

test('buildBenchmarkIndex keys by conservativeBase', () => {
  const orModels = [
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
    { id: 'z-ai/glm-5.2-fp8', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  assert.ok(idx.has('glm-5.2'));
  assert.equal(idx.size, 1, 'both variants collapse to one base key');
});

test('buildBenchmarkIndex flattens AA indices to top-level fields', () => {
  const orModels = [
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  const entry = idx.get('glm-5.2');
  assert.equal(entry.intelligence_index, 51.1);
  assert.equal(entry.coding_index, 67.0);
  assert.equal(entry.agentic_index, 44.2);
  assert.equal(entry.design_arena_best, null);
});

test('buildBenchmarkIndex picks best design_arena entry (highest Elo)', () => {
  const orModels = [
    {
      id: 'model-x',
      benchmarks: {
        design_arena: [
          { category: '3d', elo: 1320, win_rate: 60, rank: 5 },
          { category: 'codecategories', elo: 1352, win_rate: 62, rank: 4 },
          { category: 'dataviz', elo: 1336, win_rate: 61, rank: 3 },
        ],
      },
    },
  ];
  const idx = buildBenchmarkIndex(orModels);
  const entry = idx.get('model-x');
  assert.equal(entry.design_arena_best.elo, 1352);
  assert.equal(entry.design_arena_best.category, 'codecategories');
  assert.equal(entry.intelligence_index, null);
});

test('buildBenchmarkIndex prefers AA entry on collision (richer signal)', () => {
  // When two OR models map to the same base, prefer the one with artificial_analysis
  const orModels = [
    { id: 'model-x', benchmarks: { design_arena: [{ category: '3d', elo: 1300, win_rate: 55, rank: 6 }] } },
    { id: 'model-x-turbo', benchmarks: { artificial_analysis: { intelligence_index: 50, coding_index: 60, agentic_index: 40 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  const entry = idx.get('model-x');
  assert.equal(entry.intelligence_index, 50, 'AA-wins collision preference');
});

test('buildBenchmarkIndex skips models with empty benchmarks blob', () => {
  const orModels = [
    { id: 'model-x', benchmarks: {} },
    { id: 'model-y', benchmarks: null },
    { id: 'model-z', /* no benchmarks field */ },
    { id: 'model-w', benchmarks: { artificial_analysis: { intelligence_index: 40, coding_index: 50, agentic_index: 30 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  assert.equal(idx.size, 1, 'only model-w with real benchmarks indexed');
});

// ── applyBenchmarkEnrichment ──

test('applyBenchmarkEnrichment attaches benchmarks block on match', () => {
  const models = [{ id: 'z-ai/glm-5.2', provider: 'z-ai', pricing: { input: 1.4, output: 4.4 } }];
  const idx = buildBenchmarkIndex([
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ]);
  const result = applyBenchmarkEnrichment(models, idx);
  assert.ok(models[0].benchmarks, 'benchmarks block attached');
  assert.equal(models[0].benchmarks.intelligence_index, 51.1);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.aaCount, 1);
});

test('applyBenchmarkEnrichment matches quant variant to base model', () => {
  const models = [{ id: 'z-ai/glm-5.2-fp8', provider: 'z-ai', pricing: { input: 1.4, output: 4.4 } }];
  const idx = buildBenchmarkIndex([
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ]);
  applyBenchmarkEnrichment(models, idx);
  assert.ok(models[0].benchmarks, 'fp8 variant matched base model benchmark');
});

test('applyBenchmarkEnrichment leaves unmatched models untouched (no benchmarks field)', () => {
  const models = [
    { id: 'unknown/model', provider: 'unknown', pricing: { input: 1, output: 2 } },
  ];
  const idx = buildBenchmarkIndex([
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51, coding_index: 67, agentic_index: 44 } } },
  ]);
  const result = applyBenchmarkEnrichment(models, idx);
  assert.equal(models[0].benchmarks, undefined, 'no benchmarks field added to unmatched');
  assert.equal(result.matchedCount, 0);
});

test('applyBenchmarkEnrichment counts design_arena-only matches in arenaCount', () => {
  const models = [{ id: 'model-x', provider: 'p', pricing: { input: 1, output: 2 } }];
  const idx = buildBenchmarkIndex([
    { id: 'model-x', benchmarks: { design_arena: [{ category: '3d', elo: 1300, win_rate: 55, rank: 6 }] } },
  ]);
  const result = applyBenchmarkEnrichment(models, idx);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.aaCount, 0);
  assert.equal(result.arenaCount, 1);
  assert.ok(models[0].benchmarks.design_arena_best);
  assert.equal(models[0].benchmarks.intelligence_index, null);
});

// ── Org-prefix doubling fallback (Nemotron / Meta-Llama case) ──

test('applyBenchmarkEnrichment falls back to org-prefix strip for nvidia-nemotron doubling', () => {
  // Our canonical keeps 'nvidia-' prefix when model name repeats the org;
  // OR's canonical strips it. The fallback resolves the mismatch.
  const models = [{ id: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B', provider: 'nvidia', pricing: { input: 1, output: 2 } }];
  const idx = buildBenchmarkIndex([
    { id: 'nvidia/nemotron-3-super-120b-a12b', benchmarks: { artificial_analysis: { intelligence_index: 42, coding_index: 55, agentic_index: 30 } } },
  ]);
  applyBenchmarkEnrichment(models, idx);
  assert.ok(models[0].benchmarks, 'nvidia-nemotron doubling resolved via prefix-strip fallback');
  assert.equal(models[0].benchmarks.intelligence_index, 42);
});

test('applyBenchmarkEnrichment falls back for meta-llama doubling (Meta-Llama)', () => {
  const models = [{ id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', provider: 'meta', pricing: { input: 1, output: 2 } }];
  const idx = buildBenchmarkIndex([
    { id: 'meta-llama/llama-3.1-8b-instruct', benchmarks: { artificial_analysis: { intelligence_index: 25, coding_index: 30, agentic_index: 20 } } },
  ]);
  applyBenchmarkEnrichment(models, idx);
  assert.ok(models[0].benchmarks, 'meta-llama doubling resolved via prefix-strip fallback');
  assert.equal(models[0].benchmarks.intelligence_index, 25);
});

test('org-prefix fallback does NOT fire when stripped key is not in index (no false match)', () => {
  // Stripping 'nvidia' from 'nvidia-some-unknown-model' yields 'some-unknown-model'
  // which is NOT in the index — must NOT match anything.
  const models = [{ id: 'nvidia/nvidia-some-unknown-model', provider: 'nvidia', pricing: { input: 1, output: 2 } }];
  const idx = buildBenchmarkIndex([
    { id: 'totally/different-model', benchmarks: { artificial_analysis: { intelligence_index: 50, coding_index: 60, agentic_index: 40 } } },
  ]);
  applyBenchmarkEnrichment(models, idx);
  assert.equal(models[0].benchmarks, undefined, 'fallback must not fire when stripped key absent from index');
});
