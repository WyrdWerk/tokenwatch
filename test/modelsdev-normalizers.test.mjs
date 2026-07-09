import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_MAP, REVERSE_PROVIDER_MAP, normalizeForMatch } from '../shared/modelsdev.mjs';

// ── PROVIDER_MAP ──────────────────────────────────────────────────────────────

test('PROVIDER_MAP maps known TW providers to models.dev provider_ids', () => {
  assert.equal(PROVIDER_MAP['deepinfra'], 'deep-infra');
  assert.equal(PROVIDER_MAP['fireworks'], 'fireworks-ai');
  assert.equal(PROVIDER_MAP['together'], 'togetherai');
  assert.equal(PROVIDER_MAP['novita'], 'novita-ai');
  assert.equal(PROVIDER_MAP['moonshot'], 'moonshotai');
  assert.equal(PROVIDER_MAP['sambanova'], 'nova');
  assert.equal(PROVIDER_MAP['z-ai'], 'zai');
  assert.equal(PROVIDER_MAP['xiaomimimo'], 'xiaomi');
  assert.equal(PROVIDER_MAP['wafer'], 'wafer.ai');
  assert.equal(PROVIDER_MAP['amazon'], 'amazon-bedrock');
  assert.equal(PROVIDER_MAP['cloudflare'], 'cloudflare-workers-ai');
});

test('PROVIDER_MAP has no undefined or self-mapping entries except identity', () => {
  for (const [tw, md] of Object.entries(PROVIDER_MAP)) {
    assert.ok(typeof md === 'string' && md.length > 0, `${tw} maps to empty/invalid`);
  }
});

// ── REVERSE_PROVIDER_MAP ──────────────────────────────────────────────────────

test('REVERSE_PROVIDER_MAP round-trips every PROVIDER_MAP entry', () => {
  // The map must stay injective so the reverse lookup is unambiguous.
  for (const [tw, md] of Object.entries(PROVIDER_MAP)) {
    assert.equal(REVERSE_PROVIDER_MAP[md], tw, `reverse[${md}] does not round-trip to ${tw}`);
  }
});

// ── normalizeForMatch: default path (canonicalId only) ───────────────────────

test('normalizeForMatch default: org-prefix IDs collapse via canonicalId', () => {
  // moonshot has no bespoke normalizer → default canonicalId
  assert.equal(normalizeForMatch('moonshot', 'moonshotai/kimi-k2.7-code'), 'kimi-k2.7-code');
  assert.equal(normalizeForMatch('moonshot', 'kimi-k2.7-code'), 'kimi-k2.7-code');
});

test('normalizeForMatch default: case-folded and trimmed', () => {
  assert.equal(normalizeForMatch('openai', 'openai/GPT-5 '), 'gpt-5');
});

test('normalizeForMatch default: unknown provider falls back to canonicalId', () => {
  assert.equal(normalizeForMatch('unknownprov', 'org/model-name'), 'model-name');
});
