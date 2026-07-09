import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnrichment } from '../shared/modelsdev.mjs';

function buildIdx(entries) {
  const idx = new Map();
  for (const [prov, nid, rec] of entries) {
    if (!idx.has(prov)) idx.set(prov, new Map());
    idx.get(prov).set(nid, rec);
  }
  return idx;
}

test('applyEnrichment: fills cache_read when TW is null', () => {
  const models = [{ id: 'moonshotai/kimi-k2.7-code', provider: 'moonshot', pricing: { input: 0.95, output: 4.0, cache_read: null, cache_write: null } }];
  const idx = buildIdx([
    ['moonshot', 'kimi-k2.7-code', { base_url: 'https://m', model_id: 'kimi-k2.7-code', cache_read: 0.19, cache_write: null, context_length: null, max_output: null }],
  ]);
  const log = [];
  applyEnrichment(models, idx, log);
  assert.equal(models[0].pricing.cache_read, 0.19);
  assert.equal(models[0].pricing.cache_write, null);
});

test('applyEnrichment: KEEPS TW value when both present (never overwrite)', () => {
  const models = [{ id: 'moonshotai/kimi-k2.7-code', provider: 'moonshot', pricing: { input: 0.95, output: 4.0, cache_read: 0.20, cache_write: null } }];
  const idx = buildIdx([
    ['moonshot', 'kimi-k2.7-code', { base_url: 'https://m', model_id: 'kimi-k2.7-code', cache_read: 0.19, cache_write: 0.5, context_length: null, max_output: null }],
  ]);
  const log = [];
  applyEnrichment(models, idx, log);
  assert.equal(models[0].pricing.cache_read, 0.20, 'TW value kept');
  assert.equal(models[0].pricing.cache_write, 0.5, 'null filled from MD');
  assert.ok(log.some((l) => l.includes('cache_read') && l.includes('disagreement')), 'disagreement logged');
});

test('applyEnrichment: fills context_length when TW is null', () => {
  const models = [{ id: 'moonshotai/kimi-k2.7-code', provider: 'moonshot', context_length: null, pricing: { input: 0.95, output: 4.0, cache_read: null, cache_write: null } }];
  const idx = buildIdx([
    ['moonshot', 'kimi-k2.7-code', { base_url: 'https://m', model_id: 'kimi-k2.7-code', cache_read: null, cache_write: null, context_length: 262144, max_output: 262144 }],
  ]);
  applyEnrichment(models, idx, []);
  assert.equal(models[0].context_length, 262144);
});

test('applyEnrichment: attaches modelsdev block on Tier A match', () => {
  const models = [{ id: 'moonshotai/kimi-k2.7-code', provider: 'moonshot', pricing: { input: 0.95, output: 4.0, cache_read: null, cache_write: null } }];
  const idx = buildIdx([
    ['moonshot', 'kimi-k2.7-code', { base_url: 'https://api.moonshot.com/v1', model_id: 'kimi-k2.7-code', doc_url: 'https://docs.m', cache_read: 0.19, cache_write: null, context_length: 262144, max_output: 262144, release_date: '2026-06-12', knowledge_cutoff: '2025-01', description: 'desc', capabilities: { reasoning: true }, modalities: { input: ['text'], output: ['text'] }, open_weights: true }],
  ]);
  applyEnrichment(models, idx, []);
  assert.equal(models[0].modelsdev.base_url, 'https://api.moonshot.com/v1');
  assert.equal(models[0].modelsdev.model_id, 'kimi-k2.7-code');
  assert.equal(models[0].modelsdev.confidence, 'high');
  assert.equal(models[0].modelsdev.source, 'models.dev');
});

test('applyEnrichment: confidence medium on Tier B match', () => {
  const models = [{ id: 'fireworks/moonshotai/kimi-k2.7-code', provider: 'fireworks', pricing: { input: 0.95, output: 4.0, cache_read: null, cache_write: null } }];
  // Note: 'fireworks/moonshotai/kimi-k2.7-code' canonicalizes via the fireworks
  // normalizer to 'kimi-k2.7-code'. The MD side has 'kimi-k2.7-code-fast'.
  const idx = buildIdx([
    ['fireworks', 'kimi-k2.7-code-fast', { base_url: 'https://fw', model_id: 'acc/fw/x', cache_read: null, cache_write: null, context_length: null, max_output: null }],
  ]);
  applyEnrichment(models, idx, []);
  assert.equal(models[0].modelsdev.confidence, 'medium');
});

test('applyEnrichment: no match leaves modelsdev undefined', () => {
  const models = [{ id: 'unknown/model-x', provider: 'unknownprov', pricing: { input: 1, output: 2, cache_read: null, cache_write: null } }];
  applyEnrichment(models, buildIdx([]), []);
  assert.equal(models[0].modelsdev, undefined);
});

test('applyEnrichment: cache_write=0 from MD is a real value, filled into TW null', () => {
  const models = [{ id: 'z-ai/glm-5.2', provider: 'z-ai', pricing: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: null } }];
  const idx = buildIdx([
    ['z-ai', 'glm-5.2', { base_url: 'https://z', model_id: 'glm-5.2', cache_read: 0.26, cache_write: 0, context_length: null, max_output: null }],
  ]);
  applyEnrichment(models, idx, []);
  assert.equal(models[0].pricing.cache_write, 0, '0 filled (distinct from null)');
});
