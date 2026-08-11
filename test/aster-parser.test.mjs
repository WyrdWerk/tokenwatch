import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseAster } from '../scripts/lib.mjs';

const RESPONSE = {
  object: 'list',
  data: [
    {
      id: 'gpt-oss-120b',
      object: 'model',
      owned_by: 'aster',
      context_length: 131072,
      pricing: {
        input: 0.15,
        output: 0.6,
        input_per_million_tokens_usd: 0.15,
        output_per_million_tokens_usd: 0.6,
      },
    },
    {
      id: 'gpt-oss-120b-fast',
      object: 'model',
      owned_by: 'aster',
      context_length: 131072,
      pricing: {
        input: 0.15,
        output: 0.6,
        input_per_million_tokens_usd: 0.15,
        output_per_million_tokens_usd: 0.6,
      },
    },
    {
      id: 'glm-5.2',
      object: 'model',
      owned_by: 'aster',
      context_length: 1048576,
      pricing: {
        input: 1,
        output: 4,
        input_per_million_tokens_usd: 1,
        output_per_million_tokens_usd: 4,
        cached_input_per_million_tokens_usd: 0.2,
      },
    },
    {
      id: 'kimi-k3',
      object: 'model',
      owned_by: 'aster',
      context_length: 1048576,
      pricing: {
        input: 2,
        output: 10,
        input_per_million_tokens_usd: 2,
        output_per_million_tokens_usd: 10,
        cached_input_per_million_tokens_usd: 0.25,
      },
    },
    {
      id: 'zai-org/glm-5.2-batch',
      object: 'model',
      owned_by: 'aster',
      context_length: 1048576,
      pricing: {
        input: 0.75,
        output: 2.5,
        input_per_million_tokens_usd: 0.75,
        output_per_million_tokens_usd: 2.5,
      },
    },
    {
      id: 'aster/wildflower',
      object: 'model',
      owned_by: 'aster',
      pricing: { per_search_usd: 0.0005 },
    },
  ],
};

test('parseAster maps the five token-priced text models', () => {
  const rows = parseAster(RESPONSE);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((m) => m.id), [
    'gpt-oss-120b',
    'gpt-oss-120b-fast',
    'glm-5.2',
    'kimi-k3',
    'zai-org/glm-5.2-batch',
  ]);
  assert.ok(rows.every((m) => m.provider === 'aster'));
});

test('parseAster prefers explicit per-million prices over aliases', () => {
  const record = structuredClone(RESPONSE.data[0]);
  record.pricing.input = 99;
  record.pricing.output = 98;
  const [model] = parseAster({ data: [record] });
  assert.equal(model.pricing.input, 0.15);
  assert.equal(model.pricing.output, 0.6);
});

test('parseAster maps context and model-specific cache prices', () => {
  const rows = parseAster(RESPONSE);
  const glm = rows.find((m) => m.id === 'glm-5.2');
  const kimi = rows.find((m) => m.id === 'kimi-k3');
  assert.equal(glm.context_length, 1048576);
  assert.equal(glm.pricing.cache_read, 0.2);
  assert.equal(kimi.pricing.cache_read, 0.25);
  assert.equal(glm.pricing.cache_write, null);
});

test('parseAster preserves model variants and assigns their creators', () => {
  const rows = parseAster(RESPONSE);
  assert.equal(rows.find((m) => m.id === 'gpt-oss-120b-fast').org, 'openai');
  assert.equal(rows.find((m) => m.id === 'glm-5.2').org, 'z-ai');
  assert.equal(rows.find((m) => m.id === 'kimi-k3').org, 'moonshot');
  assert.equal(rows.find((m) => m.id === 'zai-org/glm-5.2-batch').org, 'z-ai');
});

test('parseAster excludes per-search and unpriced products', () => {
  const rows = parseAster({
    data: [
      RESPONSE.data.at(-1),
      { id: 'unpriced', pricing: {} },
      { id: 'partially-priced', pricing: { input_per_million_tokens_usd: 0.4 } },
    ],
  });
  assert.deepEqual(rows.map((m) => m.id), ['partially-priced']);
  assert.equal(rows[0].pricing.output, null);
});

test('parseAster handles malformed or missing data safely', () => {
  assert.deepEqual(parseAster({}), []);
  assert.deepEqual(parseAster({ data: null }), []);
  assert.deepEqual(parseAster({ data: [{ id: null, pricing: { input: 1 } }] }), []);
});

test('aster provider is present in generated pricing.json', async () => {
  const raw = await readFile(new URL('../public/pricing.json', import.meta.url), 'utf8');
  const pricing = JSON.parse(raw);
  const rows = pricing.models.filter((m) => m.provider === 'aster');
  assert.ok(rows.length >= 5, `expected at least five Aster rows, found ${rows.length}`);
  assert.ok(rows.every((m) => (m.pricing.input ?? 0) > 0 || (m.pricing.output ?? 0) > 0));
  assert.equal(pricing.providers.find((p) => p.key === 'aster')?.name, 'Aster Labs');
  assert.equal(pricing.providers_meta?.aster?.retains_prompts, false);
});

test('aster providers_meta emits defensible official policy metadata', async () => {
  const raw = await readFile(new URL('../public/pricing.json', import.meta.url), 'utf8');
  const meta = JSON.parse(raw).providers_meta?.aster;
  assert.ok(meta, 'aster entry missing from providers_meta');
  assert.equal(meta.privacy_policy_url, 'https://www.asterlab.ai/privacy');
  assert.equal(meta.terms_of_service_url, 'https://www.asterlab.ai/terms');
  assert.equal(meta.headquarters, 'US');
  assert.equal(meta.retains_prompts, false);
  assert.equal(meta.may_train, null);
  assert.equal(meta.retention_days, 0);
});
