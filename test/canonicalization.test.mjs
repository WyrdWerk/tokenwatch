import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalId, orgLookupKey, quantFromId } from '../shared/normalize.mjs';

// ── canonicalId: org/ prefix stripping ────────────────────────────────────────

test('canonicalId strips org/ prefix (full org/model IDs)', () => {
  assert.equal(canonicalId('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(canonicalId('google/gemini-3.1-pro'), 'gemini-3.1-pro');
  assert.equal(canonicalId('z-ai/glm-5.2'), 'glm-5.2');
});

test('canonicalId passes through bare IDs (no slash)', () => {
  assert.equal(canonicalId('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(canonicalId('glm-5.2'), 'glm-5.2');
});

test('canonicalId takes only the last slash segment', () => {
  assert.equal(canonicalId('a/b/claude-sonnet-5'), 'claude-sonnet-5');
});

// ── canonicalId: suffix stripping ─────────────────────────────────────────────

test('canonicalId strips :free suffix', () => {
  assert.equal(canonicalId('openai/gpt-4:free'), 'gpt-4');
  assert.equal(canonicalId('gpt-4:free'), 'gpt-4');
});

test('canonicalId strips :thinking suffix', () => {
  assert.equal(canonicalId('qwen/qwen3:thinking'), 'qwen3');
  assert.equal(canonicalId('qwen3:thinking'), 'qwen3');
});

test('canonicalId strips -YYYY-MM-DD date suffix', () => {
  assert.equal(canonicalId('org/model-2024-08-06'), 'model');
  assert.equal(canonicalId('org/model-2025-01-30'), 'model');
});

test('canonicalId strips -YYYYMMDD date suffix (8 digits)', () => {
  assert.equal(canonicalId('org/model-20260420'), 'model');
  assert.equal(canonicalId('org/model-20250130'), 'model');
});

test('canonicalId strips -YYMMDD date suffix (6 digits)', () => {
  assert.equal(canonicalId('org/model-250712'), 'model');
  assert.equal(canonicalId('org/model-241130'), 'model');
});

// ── canonicalId: preview suffix handling (THE REGRESSION FIX) ─────────────────

test('canonicalId strips bare -preview suffix', () => {
  assert.equal(canonicalId('org/model-preview'), 'model');
  assert.equal(canonicalId('google/gemini-3.1-pro-preview'), 'gemini-3.1-pro');
});

test('canonicalId strips known -preview-MM-YYYY suffix', () => {
  assert.equal(canonicalId('org/model-preview-09-2025'), 'model');
});

test('canonicalId strips known -preview-YYYY-MM-DD suffix', () => {
  assert.equal(canonicalId('org/model-preview-2024-08-06'), 'model');
});

test('canonicalId strips known -preview-MM-YY suffix', () => {
  assert.equal(canonicalId('org/model-preview-05-06'), 'model');
});

test('canonicalId PRESERVES unknown -preview-<foo> suffixes (regression for gemini-3.1-pro)', () => {
  // This was the bug: the API's former normalizeId used -preview-.*$ and
  // over-stripped, causing gemini-3.1-pro-preview-customtools to collapse
  // into gemini-3.1-pro in /models/:id/providers responses.
  assert.equal(
    canonicalId('google/gemini-3.1-pro-preview-customtools'),
    'gemini-3.1-pro-preview-customtools'
  );
  assert.notEqual(
    canonicalId('google/gemini-3.1-pro-preview-customtools'),
    'gemini-3.1-pro'
  );
  assert.notEqual(
    canonicalId('google/gemini-3.1-pro-preview-customtools'),
    'gemini-3.1-pro-preview'
  );
});

// ── canonicalId: quantization preservation ────────────────────────────────────

test('canonicalId preserves quantization suffixes baked into the ID', () => {
  // These are distinct model entries — NOT collapsed by dedup.
  assert.equal(canonicalId('z-ai/glm-5.2-fp8'), 'glm-5.2-fp8');
  assert.equal(canonicalId('z-ai/glm-5.2-nvfp4'), 'glm-5.2-nvfp4');
  assert.equal(canonicalId('z-ai/glm-5.2-int4'), 'glm-5.2-int4');
  assert.notEqual(
    canonicalId('z-ai/glm-5.2-fp8'),
    canonicalId('z-ai/glm-5.2-nvfp4')
  );
});

test('canonicalId lowercases and trims', () => {
  assert.equal(canonicalId('Anthropic/Claude-Sonnet-5'), 'claude-sonnet-5');
  assert.equal(canonicalId('  claude-sonnet-5  '), 'claude-sonnet-5');
});

// ── orgLookupKey: quantization stripping (org resolution only) ─────────────────

test('orgLookupKey strips quantization suffixes that canonicalId keeps', () => {
  // canonicalId keeps glm-5.2-fp8 distinct, but orgLookupKey strips the
  // quant suffix so both resolve to the same org lookup key.
  assert.equal(orgLookupKey('z-ai/glm-5.2-fp8'), 'glm-5.2');
  assert.equal(orgLookupKey('z-ai/glm-5.2-nvfp4'), 'glm-5.2');
  assert.equal(orgLookupKey('z-ai/glm-5.2-int4-mixed-ar'), 'glm-5.2');
  assert.equal(orgLookupKey('z-ai/glm-5.2-bf16'), 'glm-5.2');
});

test('orgLookupKey strips -long tier suffix', () => {
  assert.equal(orgLookupKey('org/model-long'), 'model');
});

test('orgLookupKey still strips the same suffixes canonicalId does', () => {
  assert.equal(orgLookupKey('org/model:free'), 'model');
  assert.equal(orgLookupKey('org/model-preview'), 'model');
  assert.equal(orgLookupKey('org/model-2024-08-06'), 'model');
});

// ── quantFromId: quantization extraction (shares QUANT_SUFFIX_RE with orgLookupKey) ──

test('quantFromId extracts quant suffixes from canonical IDs', () => {
  assert.equal(quantFromId('z-ai/glm-5.2-fp8'), 'fp8');
  assert.equal(quantFromId('z-ai/glm-5.2-nvfp4'), 'nvfp4');
  assert.equal(quantFromId('z-ai/glm-5.2-int4-mixed-ar'), 'int4-mixed-ar');
  assert.equal(quantFromId('z-ai/glm-5.2-int4'), 'int4');
  assert.equal(quantFromId('z-ai/glm-5.2-bf16'), 'bf16');
  assert.equal(quantFromId('qwen3-coder-480b-a35b-instruct-int4-mixed-ar'), 'int4-mixed-ar');
  assert.equal(quantFromId('meta-llama/llama-4-maverick-17b-128e-instruct-fp8'), 'fp8');
});

test('quantFromId matches the canonical ID, not the raw ID (date suffixes stripped first)', () => {
  // -fp8-20260803 → canonicalId strips the date → ends with -fp8 → hit.
  assert.equal(quantFromId('glm-5.2-fp8-20260803'), 'fp8');
});

test('quantFromId returns null for non-quant suffixes (turbo/SKU/size tokens preserved)', () => {
  assert.equal(quantFromId('meta-llama/llama-4-scout-17b-instruct-v1:0-turbo'), null);
  assert.equal(quantFromId('org/model-fast'), null);
  assert.equal(quantFromId('org/model-highspeed'), null);
  assert.equal(quantFromId('org/qwen3-30b-a3b'), null); // size tokens are NOT quants
  assert.equal(quantFromId('anthropic/claude-sonnet-5'), null);
});
