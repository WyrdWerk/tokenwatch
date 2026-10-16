import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBatchrate } from '../scripts/lib.mjs';

// Shape of https://batchrate.ai/pricing.json as served 2026-10-16.
const RESPONSE = {
  currency: 'USD',
  batch_window: '24h',
  models: [
    {
      model: 'Qwen3.6 35B', id: 'qwen3.6-35b-a3b', batch_window: '24h',
      context_tokens: 32768, unit: 'tokens',
      input_usd_per_million: '$0.05', output_usd_per_million: '$0.40',
      input_per_million_microusd: 50000, output_per_million_microusd: 400000,
      audio_per_minute_microusd: null,
    },
    {
      model: 'Qwen3.8 27B', id: 'qwen3.8-27b', batch_window: '24h',
      context_tokens: 32768, unit: 'tokens',
      input_usd_per_million: '$0.19', output_usd_per_million: '$1.12',
      input_per_million_microusd: 190000, output_per_million_microusd: 1120000,
      audio_per_minute_microusd: null,
    },
    {
      model: 'Whisper Large v3 Turbo', id: 'whisper-large-v3-turbo', batch_window: '24h',
      context_tokens: null, unit: 'audio_minute',
      input_usd_per_million: null, output_usd_per_million: null,
      input_per_million_microusd: null, output_per_million_microusd: null,
      audio_per_minute_microusd: 600,
    },
  ],
};

test('parseBatchrate keeps token-priced models as :batch rows and drops audio SKUs', () => {
  const rows = parseBatchrate(RESPONSE);
  assert.deepEqual(rows.map((m) => m.id), ['qwen3.6-35b-a3b:batch', 'qwen3.8-27b:batch']);
  assert.ok(rows.every((m) => m.provider === 'batchrate' && m.org === 'qwen'));
});

test('parseBatchrate converts micro-USD per 1M tokens to $/M and leaves cache null', () => {
  const [a, b] = parseBatchrate(RESPONSE);
  assert.equal(a.pricing.input, 0.05);
  assert.equal(a.pricing.output, 0.4);
  assert.equal(b.pricing.input, 0.19);
  assert.equal(b.pricing.output, 1.12);
  // No published cache tariff — must not be copied from input.
  assert.equal(a.pricing.cache_read, null);
  assert.equal(a.pricing.cache_write, null);
  assert.equal(a.context_length, 32768);
});

test('parseBatchrate does not double the :batch suffix and tolerates bad payloads', () => {
  const rows = parseBatchrate({ models: [{ ...RESPONSE.models[0], id: 'qwen3.6-35b-a3b:batch' }] });
  assert.equal(rows[0].id, 'qwen3.6-35b-a3b:batch');
  assert.deepEqual(parseBatchrate(null), []);
  assert.deepEqual(parseBatchrate({ models: [null, { unit: 'tokens' }] }), []);
});
