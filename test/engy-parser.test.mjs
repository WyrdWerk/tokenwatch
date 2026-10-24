import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEngy } from '../scripts/lib.mjs';

// Live snapshot of https://api.engy.ai/v1/models (2026-10-24). Public, no key.
const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/engy-models.json', import.meta.url), 'utf8')
);

test('parseEngy maps the live catalog fixture', () => {
  const rows = parseEngy(FIXTURE);
  assert.equal(rows.length, 9);
  assert.ok(rows.every((m) => m.provider === 'engy'));
  const flash = rows.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.equal(flash.pricing.input, 0.03);
  assert.equal(flash.pricing.output, 0.12);
  assert.equal(flash.pricing.cache_read, 0.006);
  assert.equal(flash.pricing.cache_write, null);
  assert.equal(flash.context_length, 1048576);
});

test('parseEngy leaves max_completion_tokens null when unpublished', () => {
  // engy publishes only context_length/max_model_len; no output cap.
  const rows = parseEngy(FIXTURE);
  assert.ok(rows.every((m) => m.max_completion_tokens === null));
});

test('parseEngy resolves the opaque alias and keeps dated variants separate', () => {
  const rows = parseEngy(FIXTURE);
  const glm = rows.find((m) => m.id === 'glm-5.3-flash');
  assert.equal(glm.org, 'z-ai');
  assert.equal(glm.pricing.input, 0.135);
  assert.ok(rows.some((m) => m.id === 'deepseek-v4.1-flash-1017'));
});

test('parseEngy ignores the per-request and image tariff fields', () => {
  // Both are "0" strings; they must never become a price or a zero row.
  const rows = parseEngy({ data: [{
    id: 'zero-extras',
    output_modalities: ['text'],
    pricing: { prompt: '0.000001', completion: '0.000002', request: '0', image: '0' },
  }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pricing.input, 1);
  assert.equal(rows[0].pricing.output, 2);
});

test('parseEngy derives org for qwen and moonshot ids', () => {
  const rows = parseEngy(FIXTURE);
  assert.equal(rows.find((m) => m.id === 'qwen3.8-27b').org, 'qwen');
  assert.equal(rows.find((m) => m.id === 'kimi-k3').org, 'moonshot');
});
