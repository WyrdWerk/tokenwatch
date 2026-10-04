import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USE_CASES } from '../shared/use-cases.mjs';
import { applyArenaEnrichment, buildArenaIndex } from '../shared/benchmarks.mjs';
import { shortlistModels } from '../shared/recommend.mjs';
import { parseArenaPage, parseArenaRowsPage } from '../scripts/fetch-arena.mjs';

test('Arena dataset pages validate and preserve the published score metadata', () => {
  const page = parseArenaPage({
    num_rows_total: 1,
    rows: [{ row: {
      model_name: 'glm-5.3', organization: 'zai', license: 'MIT', rating: 1400,
      rating_lower: 1390, rating_upper: 1410, vote_count: 1234, rank: 7,
      category: 'overall', leaderboard_publish_date: '2026-10-02',
    } }],
  }, 'overall');

  assert.equal(page.total, 1);
  assert.equal(page.rows[0].rating, 1400);
  assert.equal(page.rows[0].vote_count, 1234);
  assert.throws(() => parseArenaPage({ num_rows_total: 1, rows: [{ row: {
    model_name: 'math-model', rating: 1300, rank: 1, category: 'math', leaderboard_publish_date: '2026-10-02',
  } }] }, 'overall'), /unexpected category/);
});

test('Arena rows pages accept the full dataset table so selected categories can be extracted client-side', () => {
  const page = parseArenaRowsPage({
    num_rows_total: 3,
    rows: ['overall', 'creative_writing', 'math'].map((category, index) => ({ row: {
      model_name: `model-${index}`, category, rating: 1300 + index, rank: index + 1,
      leaderboard_publish_date: '2026-10-02',
    } })),
  });

  assert.deepEqual(page.rows.map((row) => row.category), ['overall', 'creative_writing', 'math']);
  assert.equal(page.rows[1].rating, 1301);
});

test('Arena matching preserves model size and version tokens while normalizing display names', () => {
  const index = buildArenaIndex([
    { model_name: 'Qwen3.8 27B', category: 'creative_writing', rating: 1401, rank: 17 },
    { model_name: 'Qwen3.8 2.4T A95B', category: 'creative_writing', rating: 1432, rank: 8 },
    { model_name: 'DeepSeek V4.1 Flash', category: 'creative_writing', rating: 1450, rank: 5 },
    { model_name: 'DeepSeek V4 Flash', category: 'creative_writing', rating: 1300, rank: 40 },
  ]);
  const models = [
    { id: 'Qwen/Qwen3.8-27B' },
    { id: 'Qwen/Qwen3.8-2.4T-A95B' },
    { id: 'deepseek-v4.1-flash' },
    { id: 'deepseek-v4-flash' },
    { id: 'qwen3.8' },
  ];

  const result = applyArenaEnrichment(models, index);

  assert.equal(models[0].benchmarks.arena_creative_writing, 1401);
  assert.equal(models[1].benchmarks.arena_creative_writing, 1432);
  assert.equal(models[2].benchmarks.arena_creative_writing, 1450);
  assert.equal(models[3].benchmarks.arena_creative_writing, 1300);
  assert.equal(models[4].benchmarks, undefined, 'a size-less model must not inherit a size-specific score');
  assert.equal(result.creativeWritingCount, 4);
});

test('Arena effort labels are fallback aliases and never replace an exact model score', () => {
  const index = buildArenaIndex([
    { model_name: 'GLM 5.3 (Max)', category: 'creative_writing', rating: 1450, rank: 3 },
    { model_name: 'GLM 5.3', category: 'creative_writing', rating: 1400, rank: 9 },
  ]);
  const models = [{ id: 'glm-5.3' }, { id: 'glm-5.3-max' }];

  applyArenaEnrichment(models, index);

  assert.equal(models[0].benchmarks.arena_creative_writing, 1400);
  assert.equal(models[1].benchmarks.arena_creative_writing, 1450);
});

test('creative-writing ranks primarily on Arena preference and floors on that score', () => {
  const useCase = USE_CASES['creative-writing'];

  assert.deepEqual(useCase.qualityFloor, { field: 'arena_creative_writing', min: 1310 });
  assert.deepEqual(useCase.benchmarkWeights, { arena_creative_writing: 0.75, intelligence_index: 0.25 });
  assert.equal(Object.hasOwn(useCase.benchmarkWeights, 'livebench_language'), false);
});

test('chat keeps capability ranking and returns an independent human-preference ranking', () => {
  const catalog = [
    {
      id: 'open/capable', name: 'Capable', provider: 'alpha', open_weights: true, context_length: 32768,
      pricing: { input: 1, output: 1, cache_read: 1 },
      benchmarks: { intelligence_index: 90, livebench_language: 90, livebench_instruction_following: 90, arena_text: 1200 },
    },
    {
      id: 'open/preferred', name: 'Preferred', provider: 'beta', open_weights: true, context_length: 32768,
      pricing: { input: 1, output: 1, cache_read: 1 },
      benchmarks: { intelligence_index: 20, livebench_language: 20, livebench_instruction_following: 20, arena_text: 1500 },
    },
  ];

  const result = shortlistModels('chat-assistant', catalog);

  assert.equal(result.bestQuality.id, 'capable');
  assert.equal(result.preference.field, 'arena_text');
  assert.equal(result.preference.ranking[0].id, 'preferred');
  assert.equal(result.preference.ranking[0].score, 1500);
  assert.equal(result.preference.ranking[0].rank, 1);
});
