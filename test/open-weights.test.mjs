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
        license: 'apache-2.0',
        source_url: 'https://models.example/deepseek-v3.2',
      },
    },
  });

  assert.deepEqual(result, {
    open_weights: true,
    open_weights_source: 'override',
    license: 'apache-2.0',
  });
});

test('override license is optional and models.dev license remains the fallback', () => {
  assert.deepEqual(resolveOpenWeights({
    canonicalId: 'model-with-override',
    org: 'unknown-org',
    modelsDevRecords: [{ open_weights: false, license: 'mit' }],
    overrides: { 'model-with-override': { open_weights: true } },
  }), {
    open_weights: true,
    open_weights_source: 'override',
    license: 'mit',
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

test('a models.dev tie stays unknown when the org has no safe prior', () => {
  assert.deepEqual(resolveOpenWeights({
    canonicalId: 'deepseek-r1',
    org: 'deepseek',
    modelsDevRecords: [
      { open_weights: true, license: null },
      { open_weights: false, license: null },
    ],
    overrides: {},
  }), {
    open_weights: null,
    open_weights_source: null,
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
    open_weights: null,
    open_weights_source: null,
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
    { id: 'model-y', open_weights: null, open_weights_source: null, license: null },
    { id: 'model-y:batch', open_weights: null, open_weights_source: null, license: null },
  ]);
});

test('variant suffixes resolve from the base override without changing offering IDs', () => {
  const offerings = resolveOpenWeightsForOfferings([
    { id: 'qwen-model:batch', org: 'qwen' },
    { id: 'qwen-model-turbo', org: 'qwen' },
    { id: 'qwen-model-fast', org: 'qwen' },
  ], new Map(), {
    'qwen-model': {
      open_weights: true,
      license: 'apache-2.0',
      source_url: 'https://huggingface.co/Qwen/Qwen3-32B',
    },
  });

  assert.deepEqual(offerings.map(({ id, open_weights, open_weights_source, license }) => ({
    id, open_weights, open_weights_source, license,
  })), [
    { id: 'qwen-model:batch', open_weights: true, open_weights_source: 'override', license: 'apache-2.0' },
    { id: 'qwen-model-turbo', open_weights: true, open_weights_source: 'override', license: 'apache-2.0' },
    { id: 'qwen-model-fast', open_weights: true, open_weights_source: 'override', license: 'apache-2.0' },
  ]);
});

test('variant suffixes use base models.dev records and preserve their original IDs', () => {
  const offerings = resolveOpenWeightsForOfferings([
    { id: 'mistral-saba:batch', org: 'mistral' },
    { id: 'mistral-saba-turbo', org: 'mistral' },
    { id: 'mistral-saba-fast', org: 'mistral' },
  ], new Map([
    ['unmapped-provider', new Map([
      ['mistral-saba', { open_weights: false, license: 'apache-2.0' }],
    ])],
  ]), {});

  assert.deepEqual(offerings.map(({ id, open_weights, open_weights_source }) => ({
    id, open_weights, open_weights_source,
  })), [
    { id: 'mistral-saba:batch', open_weights: false, open_weights_source: 'modelsdev' },
    { id: 'mistral-saba-turbo', open_weights: false, open_weights_source: 'modelsdev' },
    { id: 'mistral-saba-fast', open_weights: false, open_weights_source: 'modelsdev' },
  ]);
});

test('models.dev voting includes unmapped providers and closed Mistral SKUs', async () => {
  const { buildOpenWeightIndexFromApi } = await import('../scripts/fetch-modelsdev.mjs');
  assert.equal(typeof buildOpenWeightIndexFromApi, 'function');
  const ids = [
    'codestral-2508',
    'mistral-medium-3',
    'mistral-medium-3.1',
    'mistral-saba',
    'mistral-large',
    'mistral-medium-3-5',
  ];
  const provider = Object.fromEntries(ids.map((id) => [id, { open_weights: false }]));
  const index = buildOpenWeightIndexFromApi({
    openrouter: { models: provider },
    kilo: { models: provider },
    llmgateway: { models: provider },
  });
  const offerings = resolveOpenWeightsForOfferings([
    ...ids.map((id) => ({ id, org: 'mistral' })),
    { id: 'mistral-saba:batch', org: 'mistral' },
  ], index, {});

  for (const offering of offerings) {
    assert.equal(offering.open_weights, false, `${offering.id} must not be resolved open`);
    assert.equal(offering.open_weights_source, 'modelsdev');
  }
});

test('all-provider index retains non-enrichment providers for voting', async () => {
  const { buildOpenWeightIndexFromApi } = await import('../scripts/fetch-modelsdev.mjs');
  assert.equal(typeof buildOpenWeightIndexFromApi, 'function');
  const apiData = {
    deepinfra: { models: { 'sample-model': { open_weights: true, license: 'apache-2.0' } } },
    unmappedA: { models: { 'sample-model': { open_weights: false, license: 'mit' } } },
    unmappedB: { models: { 'sample-model': { open_weights: false, license: 'mit' } } },
  };

  const enrichment = buildIndexFromApi(apiData);
  const allProviders = buildOpenWeightIndexFromApi(apiData);
  assert.equal(enrichment.has('unmappedA'), false, 'unmapped provider is excluded from enrichment');
  assert.equal(allProviders.has('unmappedA'), true, 'unmapped provider contributes weight metadata');
  assert.deepEqual(resolveOpenWeightsForOfferings([
    { id: 'sample-model', org: 'unknown-org' },
  ], allProviders, {})[0], {
    id: 'sample-model',
    org: 'unknown-org',
    open_weights: false,
    open_weights_source: 'modelsdev',
    license: 'mit',
  });
});

test('models.dev models.json licenses remain available even without provider records', async () => {
  const { buildModelsDevLicenseIndex } = await import('../scripts/fetch-modelsdev.mjs');
  assert.equal(typeof buildModelsDevLicenseIndex, 'function');
  const licenses = buildModelsDevLicenseIndex({
    'deepseek/deepseek-v3.2': { license: 'MIT License' },
  });

  assert.deepEqual(resolveOpenWeightsForOfferings([
    { id: 'deepseek-v3.2', org: 'deepseek' },
  ], new Map(), {}, licenses)[0], {
    id: 'deepseek-v3.2',
    org: 'deepseek',
    open_weights: null,
    open_weights_source: null,
    license: 'MIT License',
  });
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
    assert.ok(typeof override.license === 'string' && override.license.trim(), `${id} lacks a cited license`);
  }
  for (const id of conflicts) {
    const lookupId = id.replace(/(:batch|-turbo|-fast)$/i, '');
    const override = overrides[id] || overrides[lookupId];
    assert.equal(typeof override?.open_weights, 'boolean', `${id} lacks a boolean override`);
  }
  assert.equal(overrides['gpt-oss-120b:batch'], undefined, 'batch variants should reuse the base override');
  assert.equal(overrides['gpt-oss-20b:batch'], undefined, 'batch variants should reuse the base override');
  assert.deepEqual(overrides['qwen3-vl-32b-instruct'], {
    open_weights: true,
    license: 'apache-2.0',
    source_url: 'https://huggingface.co/Qwen/Qwen3-VL-32B-Instruct',
    source_note: 'Official Qwen model repository publishes the Apache-2.0-licensed Qwen3-VL-32B-Instruct weights.',
  });
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
