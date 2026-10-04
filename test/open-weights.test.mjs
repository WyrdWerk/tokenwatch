import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalId } from '../shared/normalize.mjs';
import {
  buildModelsDevOpenWeightIndex,
  resolveOpenWeights,
  resolveOpenWeightsForOfferings,
} from '../shared/open-weights.mjs';
import { buildIndexFromApi } from '../scripts/fetch-modelsdev.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('open-weight override takes precedence and returns its source', () => {
  const result = resolveOpenWeights({
    canonicalId: 'deepseek-v3.2',
    org: 'deepseek',
    modelsDevRecords: [{ open_weights: false, license: 'other' }],
    overrides: {
      'deepseek-v3.2': {
        open_weights: true,
        source_url: 'https://models.example/deepseek-v3.2',
      },
    },
  });

  assert.deepEqual(result, {
    open_weights: true,
    open_weights_source: 'override',
    license: 'other',
  });
});

test('models.dev strict majority wins over the org prior', () => {
  assert.deepEqual(resolveOpenWeights({
    canonicalId: 'qwen3.6-27b',
    org: 'qwen',
    modelsDevRecords: [
      { open_weights: true, license: 'apache-2.0' },
      { open_weights: true, license: 'apache-2.0' },
      { open_weights: false, license: null },
    ],
    overrides: {},
  }), {
    open_weights: true,
    open_weights_source: 'modelsdev',
    license: 'apache-2.0',
  });
});

test('models.dev records aggregate by canonical ID while preserving false and license values', () => {
  const index = buildModelsDevOpenWeightIndex(new Map([
    ['qwen', new Map([
      ['Qwen3.6-27B', { open_weights: true, license: 'apache-2.0' }],
    ])],
    ['another-provider', new Map([
      ['qwen3.6-27b', { open_weights: false, license: 'apache-2.0' }],
      ['qwen3.6-35b-a3b', { open_weights: false, license: null }],
    ])],
  ]));

  assert.deepEqual(index.get('qwen3.6-27b'), [
    { open_weights: true, license: 'apache-2.0' },
    { open_weights: false, license: 'apache-2.0' },
  ]);
  assert.deepEqual(index.get('qwen3.6-35b-a3b'), [
    { open_weights: false, license: null },
  ]);
});

test('a models.dev tie falls through to a known org prior', () => {
  assert.deepEqual(resolveOpenWeights({
    canonicalId: 'deepseek-r1',
    org: 'deepseek',
    modelsDevRecords: [
      { open_weights: true, license: null },
      { open_weights: false, license: null },
    ],
    overrides: {},
  }), {
    open_weights: true,
    open_weights_source: 'org_prior',
    license: null,
  });
});

test('known proprietary org prior resolves false, while unknown/mixed orgs stay null', () => {
  const resolve = (org) => resolveOpenWeights({
    canonicalId: 'model-x', org, modelsDevRecords: [], overrides: {},
  });

  assert.deepEqual(resolve('anthropic'), {
    open_weights: false,
    open_weights_source: 'org_prior',
    license: null,
  });
  assert.deepEqual(resolve('google'), {
    open_weights: null,
    open_weights_source: null,
    license: null,
  });
  assert.deepEqual(resolve('mixed'), {
    open_weights: null,
    open_weights_source: null,
    license: null,
  });
  assert.deepEqual(resolveOpenWeights({
    canonicalId: 'model-x',
    org: ['deepseek', 'anthropic'],
    modelsDevRecords: [],
    overrides: {},
  }), {
    open_weights: null,
    open_weights_source: null,
    license: null,
  });
  assert.deepEqual(resolveOpenWeights({
    canonicalId: 'model-x',
    org: ['DeepSeek', 'deepseek'],
    modelsDevRecords: [],
    overrides: {},
  }), {
    open_weights: true,
    open_weights_source: 'org_prior',
    license: null,
  });
});

test('offering projection resolves mixed orgs as unknown and shares one result per canonical ID', () => {
  const offerings = resolveOpenWeightsForOfferings([
    { id: 'deepseek/model-x', org: 'deepseek' },
    { id: 'anthropic/model-x', org: 'anthropic' },
    { id: 'model-y', org: 'deepseek' },
    { id: 'model-y:batch', org: 'deepseek' },
  ], new Map(), {});

  assert.deepEqual(offerings.map(({ id, open_weights, open_weights_source, license }) => ({
    id, open_weights, open_weights_source, license,
  })), [
    { id: 'deepseek/model-x', open_weights: null, open_weights_source: null, license: null },
    { id: 'anthropic/model-x', open_weights: null, open_weights_source: null, license: null },
    { id: 'model-y', open_weights: true, open_weights_source: 'org_prior', license: null },
    { id: 'model-y:batch', open_weights: true, open_weights_source: 'org_prior', license: null },
  ]);
});

test('every conflicting canonical model has a source-cited reviewed override', async () => {
  const [pricing, overrides] = await Promise.all([
    readFile(join(__dirname, '..', 'public', 'pricing.json'), 'utf8').then(JSON.parse),
    readFile(join(__dirname, '..', 'data', 'open-weights-overrides.json'), 'utf8').then(JSON.parse),
  ]);
  const valuesByCanonical = new Map();
  for (const model of pricing.models) {
    for (const source of [model.modelsdev, model.modelsdev_model]) {
      if (typeof source?.open_weights !== 'boolean') continue;
      const id = canonicalId(model.id);
      if (!valuesByCanonical.has(id)) valuesByCanonical.set(id, new Set());
      valuesByCanonical.get(id).add(source.open_weights);
    }
  }

  const conflicts = [...valuesByCanonical]
    .filter(([, values]) => values.size > 1)
    .map(([id]) => id);
  assert.ok(conflicts.length >= 21, `expected at least 21 current conflicts, found ${conflicts.length}`);
  for (const [id, override] of Object.entries(overrides)) {
    assert.equal(typeof override.open_weights, 'boolean', `${id} lacks a boolean override`);
    assert.match(override.source_url || '', /^https:\/\//, `${id} lacks an HTTPS source citation`);
    assert.ok(typeof override.source_note === 'string' && override.source_note.trim(), `${id} lacks a source note`);
  }
  for (const id of conflicts) {
    const override = overrides[id];
    assert.equal(typeof override?.open_weights, 'boolean', `${id} lacks a boolean override`);
  }
});

test('models.dev enrichment preserves explicit booleans, unknowns, and license', () => {
  const index = buildIndexFromApi({
    deepseek: {
      models: {
        'deepseek-v3.2': { open_weights: false, license: 'mit' },
        'deepseek-v3.3': { license: 'apache-2.0' },
      },
    },
  });

  assert.equal(index.get('deepseek').get('deepseek-v3.2').open_weights, false);
  assert.equal(index.get('deepseek').get('deepseek-v3.2').license, 'mit');
  assert.equal(index.get('deepseek').get('deepseek-v3.3').open_weights, null);
  assert.equal(index.get('deepseek').get('deepseek-v3.3').license, 'apache-2.0');
});
