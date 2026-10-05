import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAvian } from '../scripts/lib.mjs';

const RESPONSE = {
  object: 'list',
  data: [
    {
      id: 'deepseek/deepseek-v4-flash',
      object: 'model',
      created: 1791191833,
      owned_by: 'DeepSeek',
      display_name: 'DeepSeek V4 Flash',
      context_length: 1000000,
      max_output: 393216,
      reasoning: true,
      pricing: {
        input_per_million: 0.14,
        output_per_million: 0.28,
        cache_read_per_million: 0.0028,
      },
    },
    {
      id: 'z-ai/glm-5.2',
      object: 'model',
      created: 1791191833,
      owned_by: 'Zhipu AI',
      display_name: 'GLM-5.2',
      context_length: 1000000,
      max_output: 393216,
      reasoning: false,
      pricing: {
        input_per_million: 0.495,
        output_per_million: 1.733,
        cache_read_per_million: 0.124,
      },
    },
    {
      id: 'moonshotai/kimi-k2.6',
      object: 'model',
      created: 1791191833,
      owned_by: 'Moonshot AI',
      context_length: 262144,
      max_output: 131072,
      reasoning: false,
      pricing: {
        input_per_million: 0.95,
        output_per_million: 4,
        cache_read_per_million: 0.16,
      },
    },
  ],
};

test('parseAvian maps every catalog row to an avian provider record', () => {
  const rows = parseAvian(RESPONSE);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((m) => m.provider === 'avian'));
  assert.deepEqual(rows.map((m) => m.id), [
    'deepseek/deepseek-v4-flash',
    'z-ai/glm-5.2',
    'moonshotai/kimi-k2.6',
  ]);
});

test('parseAvian passes through per-million prices unchanged', () => {
  const [flash] = parseAvian(RESPONSE);
  assert.equal(flash.pricing.input, 0.14);
  assert.equal(flash.pricing.output, 0.28);
  assert.equal(flash.pricing.cache_read, 0.0028);
  // Avian publishes no cache-write tariff — must stay null, never guessed.
  assert.equal(flash.pricing.cache_write, null);
});

test('parseAvian captures context window and max output tokens', () => {
  const rows = parseAvian(RESPONSE);
  const kimi = rows.find((m) => m.id === 'moonshotai/kimi-k2.6');
  assert.equal(kimi.context_length, 262144);
  assert.equal(kimi.max_completion_tokens, 131072);
  assert.equal(kimi.quantization, null);
  assert.equal(kimi.discount, 0);
});

test('parseAvian falls back to the id when display_name is absent', () => {
  const rows = parseAvian(RESPONSE);
  const kimi = rows.find((m) => m.id === 'moonshotai/kimi-k2.6');
  assert.equal(kimi.name, 'moonshotai/kimi-k2.6');
  const glm = rows.find((m) => m.id === 'z-ai/glm-5.2');
  assert.equal(glm.name, 'GLM-5.2');
});

test('parseAvian keeps rows with null prices for the fetch-time filters', () => {
  const rows = parseAvian({
    data: [
      { id: 'deepseek/deepseek-v4-pro', pricing: {} },
      { id: 'deepseek/deepseek-v4-flash', pricing: { input_per_million: 1.305 } },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pricing.input, null);
  assert.equal(rows[0].pricing.output, null);
  assert.equal(rows[0].context_length, null);
  assert.equal(rows[0].max_completion_tokens, null);
  assert.equal(rows[1].pricing.input, 1.305);
});

test('parseAvian tolerates a missing data array', () => {
  assert.deepEqual(parseAvian({}), []);
  assert.deepEqual(parseAvian({ data: null }), []);
});
