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
import { ISSUE_MARKER, findUnreviewedConflicts, reportOpenWeightsConflicts } from '../scripts/report-open-weights-conflicts.mjs';

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

// Refresh workflows set TW_OPEN_WEIGHTS_COVERAGE=0: new upstream conflicts are reported to an
// issue there instead of blocking the fetch that could resolve them. PR CI stays strict.
const OPEN_WEIGHTS_COVERAGE = process.env.TW_OPEN_WEIGHTS_COVERAGE !== '0';

test('open-weights overrides are source-cited and reviewed', async () => {
  const overrides = JSON.parse(await readFile(join(__dirname, '..', 'data', 'open-weights-overrides.json'), 'utf8'));
  for (const [id, override] of Object.entries(overrides)) {
    assert.equal(typeof override.open_weights, 'boolean', `${id} lacks a boolean override`);
    assert.match(override.source_url || '', /^https:\/\//, `${id} lacks an HTTPS source citation`);
    assert.ok(typeof override.source_note === 'string' && override.source_note.trim(), `${id} lacks a source note`);
    assert.ok(typeof override.license === 'string' && override.license.trim(), `${id} lacks a cited license`);
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

test('every conflicting canonical model has a reviewed override', {
  skip: !OPEN_WEIGHTS_COVERAGE && 'TW_OPEN_WEIGHTS_COVERAGE=0 (refresh reports conflicts to an issue)',
}, async () => {
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
  // Non-vacuity floor only: the count shrinks as models.dev resolves conflicts (21 → 19 on 2026-10-09).
  assert.ok(conflicts.length >= 10, `expected at least 10 current conflicts, found ${conflicts.length}`);
  assert.deepEqual(
    findUnreviewedConflicts(pricing, overrides).map(({ id }) => id),
    [],
    'add reviewed entries to data/open-weights-overrides.json for these conflicting models',
  );
});

test('conflict finder flags only unreviewed disagreements and reuses base overrides', () => {
  const pricing = { models: [
    { id: 'a-model', provider: 'p1', modelsdev: { open_weights: true } },
    { id: 'a-model', provider: 'p2', modelsdev_model: { open_weights: false } },
    { id: 'b-model', provider: 'p1', modelsdev: { open_weights: true } },
    { id: 'b-model', provider: 'p2', modelsdev: { open_weights: true } },
    { id: 'c-model:batch', provider: 'p1', modelsdev: { open_weights: true } },
    { id: 'c-model:batch', provider: 'p2', modelsdev: { open_weights: false } },
  ] };
  const conflicts = findUnreviewedConflicts(pricing, { 'c-model': { open_weights: true } });
  assert.deepEqual(conflicts.map(({ id }) => id), [canonicalId('a-model')]);
  assert.deepEqual(conflicts[0].sources.map(s => [s.provider, s.open_weights]), [['p1', true], ['p2', false]]);
});

function conflictIssueDouble(issues) {
  const calls = [];
  const listForRepo = () => {};
  const record = (action) => async (params) => { calls.push({ action, ...params }); return { data: {} }; };
  return { calls, github: {
    paginate: async (method) => { assert.equal(method, listForRepo); return issues; },
    rest: { issues: { listForRepo, create: record('create'), update: record('update'), createComment: record('comment') } },
  } };
}
const issueContext = { repo: { owner: 'WyrdWerk', repo: 'tokenwatch' }, serverUrl: 'https://github.com', runId: 1 };
const sampleConflict = [{ id: 'a-model', sources: [{ provider: 'p1', open_weights: true }, { provider: 'p2', open_weights: false }] }];

test('conflict report opens one issue, then edits it in place', async () => {
  const fresh = conflictIssueDouble([]);
  await reportOpenWeightsConflicts({ github: fresh.github, context: issueContext, conflicts: sampleConflict });
  assert.deepEqual(fresh.calls.map(c => c.action), ['create']);
  assert.match(fresh.calls[0].body, /`a-model` \| p1 `true`, p2 `false`/);

  const existing = conflictIssueDouble([{ number: 9, body: ISSUE_MARKER, pull_request: {} }, { number: 12, body: ISSUE_MARKER }]);
  await reportOpenWeightsConflicts({ github: existing.github, context: issueContext, conflicts: sampleConflict });
  assert.deepEqual(existing.calls.map(c => [c.action, c.issue_number]), [['update', 12]]);
});

test('conflict report closes the tracking issue once every conflict is reviewed', async () => {
  const resolved = conflictIssueDouble([{ number: 12, body: ISSUE_MARKER }]);
  await reportOpenWeightsConflicts({ github: resolved.github, context: issueContext, conflicts: [] });
  assert.deepEqual(resolved.calls.map(c => c.action), ['comment', 'update']);
  assert.equal(resolved.calls[1].state, 'closed');

  const none = conflictIssueDouble([]);
  await reportOpenWeightsConflicts({ github: none.github, context: issueContext, conflicts: [] });
  assert.equal(none.calls.length, 0);
});

test('refresh workflows report open-weights conflicts instead of blocking; PR CI stays strict', async () => {
  const read = (f) => readFile(join(__dirname, '..', '.github', 'workflows', f), 'utf8');
  for (const f of ['refresh-aa.yml', 'refresh-performance.yml', 'refresh-pricing.yml']) {
    assert.match(await read(f), /TW_OPEN_WEIGHTS_COVERAGE: '0'/, `${f} should skip the coverage gate`);
  }
  assert.doesNotMatch(await read('ci.yml'), /TW_OPEN_WEIGHTS_COVERAGE/);
  assert.match(await read('refresh-pricing.yml'), /reportOpenWeightsConflicts/);
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
