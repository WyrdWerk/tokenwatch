import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRunanywhere } from '../scripts/lib.mjs';

// Live snapshot of https://inference.runanywhere.ai/v1/models (2026-10-24). Public, no key.
const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/runanywhere-models.json', import.meta.url), 'utf8')
);

test('parseRunanywhere maps the live catalog fixture', () => {
  const rows = parseRunanywhere(FIXTURE);
  assert.equal(rows.length, 9);
  assert.ok(rows.every((m) => m.provider === 'runanywhere'));
  const flash = rows.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.equal(flash.pricing.input, 0.3);
  assert.equal(flash.pricing.output, 1.2);
  assert.equal(flash.pricing.cache_read, 0.006);
  assert.equal(flash.pricing.cache_write, null);
  assert.equal(flash.context_length, 1048576);
  assert.equal(flash.max_completion_tokens, 65536);
  assert.equal(flash.quantization, 'fp8');
  assert.equal(flash.org, 'deepseek');
});

test('parseRunanywhere resolves opaque shipped aliases to canonical ids', () => {
  const rows = parseRunanywhere(FIXTURE);
  // HF card for the GLM alias identifies GLM-5.3-Flash; DeepSeek alias is V4.1 Flash 1017.
  assert.ok(rows.some((m) => m.id === 'glm-5.3-flash' && m.org === 'z-ai'));
  assert.ok(rows.some((m) => m.id === 'deepseek-v4.1-flash-1017' && m.org === 'deepseek'));
  // The opaque alias must not leak through as a second row.
  assert.equal(rows.filter((m) => m.org === 'z-ai').length, 2);
});

test('parseRunanywhere keeps -fast ids distinct without doubling the tier suffix', () => {
  const rows = parseRunanywhere(FIXTURE);
  const ids = rows.map((m) => m.id);
  assert.ok(ids.includes('deepseek-v4.1-flash-fast'));
  assert.ok(ids.includes('glm-5.3-fast'));
  assert.ok(!ids.some((id) => id.endsWith(':fast')));
});

test('parseRunanywhere derives org from bare ids', () => {
  const rows = parseRunanywhere(FIXTURE);
  assert.equal(rows.find((m) => m.id === 'minimax-m3').org, 'minimax');
  assert.equal(rows.find((m) => m.id === 'kimi-k3').org, 'moonshot');
});

test('parseRunanywhere drops non-text output and unpriced rows', () => {
  const rows = parseRunanywhere({ data: [
    { id: 'text-model', output_modalities: ['text'], pricing: { prompt: '1e-6', completion: '2e-6' } },
    { id: 'image-model', output_modalities: ['image'], pricing: { prompt: '1e-6', completion: '2e-6' } },
    { id: 'unpriced', output_modalities: ['text'], pricing: {} },
  ] });
  assert.deepEqual(rows.map((m) => m.id), ['text-model']);
});
