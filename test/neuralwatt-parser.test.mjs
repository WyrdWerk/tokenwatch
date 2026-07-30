import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNeuralwatt } from '../scripts/lib.mjs';

const GEMMA = {
  id: 'google/gemma-4-31b',
  object: 'model',
  created: 1710000000,
  owned_by: 'neuralwatt',
  max_model_len: 262128,
  metadata: {
    display_name: 'Gemma 4 31B',
    description: 'Google Gemma 4 31B',
    provider: 'google',
    huggingface_id: 'google/gemma-4-31b',
    pricing: {
      input_per_million: 0.144,
      output_per_million: 0.42,
      cached_input_per_million: 0.036,
      cached_output_per_million: 0.105,
      currency: 'USD',
      pricing_tbd: false,
    },
    capabilities: { vision: false, tools: true, json: true },
    limits: { max_context_length: 262128, max_output_tokens: 16384, max_images: 0 },
    deprecated: false,
  },
};

const FAST_VARIANT = {
  ...GEMMA,
  id: 'google/gemma-4-31b-fast',
  metadata: {
    ...GEMMA.metadata,
    display_name: 'Gemma 4 31B Fast',
    pricing: {
      input_per_million: 0.144,
      output_per_million: 0.42,
      cached_input_per_million: 0.036,
      cached_output_per_million: 0.105,
      currency: 'USD',
      pricing_tbd: false,
    },
  },
};

const DEPRECATED = {
  ...GEMMA,
  id: 'google/old-model',
  metadata: { ...GEMMA.metadata, deprecated: true },
};

const NO_DISPLAY_NAME = {
  ...GEMMA,
  id: 'google/plain-id',
  metadata: { ...GEMMA.metadata, display_name: undefined },
};

const NO_PRICING = {
  ...GEMMA,
  id: 'google/no-pricing',
  metadata: { ...GEMMA.metadata, pricing: {} },
};

test('parseNeuralwatt maps the verified envelope to a model record', () => {
  const result = parseNeuralwatt({ data: [GEMMA] });

  assert.equal(result.length, 1);
  const m = result[0];
  assert.equal(m.id, 'google/gemma-4-31b');
  assert.equal(m.name, 'Gemma 4 31B', 'display_name maps to name');
  assert.equal(m.provider, 'neuralwatt');
  assert.equal(m.quantization, null);
  assert.equal(m.discount, 0);
  assert.equal(m.context_length, 262128, 'limits.max_context_length maps to context_length');
  assert.equal(m.pricing.input, 0.144, 'input $/M passthrough');
  assert.equal(m.pricing.output, 0.42, 'output $/M passthrough');
  assert.equal(m.pricing.cache_read, 0.036, 'cached_input_per_million maps to cache_read');
  assert.equal(m.pricing.cache_write, null, 'cache_write not provided by provider');
});

test('parseNeuralwatt keeps -fast/-short variants as separate rows', () => {
  const result = parseNeuralwatt({ data: [GEMMA, FAST_VARIANT] });
  assert.equal(result.length, 2);
  const ids = result.map((r) => r.id);
  assert.ok(ids.includes('google/gemma-4-31b'));
  assert.ok(ids.includes('google/gemma-4-31b-fast'));
});

test('parseNeuralwatt excludes records with metadata.deprecated === true', () => {
  const result = parseNeuralwatt({ data: [GEMMA, DEPRECATED] });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'google/gemma-4-31b');
});

test('parseNeuralwatt returns [] for empty/missing data array', () => {
  assert.deepEqual(parseNeuralwatt({}), []);
  assert.deepEqual(parseNeuralwatt({ data: [] }), []);
});

test('parseNeuralwatt falls back to id when display_name is missing', () => {
  const result = parseNeuralwatt({ data: [NO_DISPLAY_NAME] });
  assert.equal(result[0].name, 'google/plain-id');
});

test('parseNeuralwatt maps missing pricing fields to null', () => {
  const result = parseNeuralwatt({ data: [NO_PRICING] });
  assert.equal(result[0].pricing.input, null);
  assert.equal(result[0].pricing.output, null);
  assert.equal(result[0].pricing.cache_read, null);
});

test('parseNeuralwatt handles null/undefined metadata gracefully', () => {
  const bare = { id: 'org/model', object: 'model', metadata: null };
  const result = parseNeuralwatt({ data: [bare] });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'org/model');
  assert.equal(result[0].name, 'org/model', 'id fallback when display_name missing');
  assert.equal(result[0].context_length, null);
  assert.equal(result[0].pricing.input, null);
  assert.equal(result[0].pricing.output, null);
  assert.equal(result[0].pricing.cache_read, null);
});
