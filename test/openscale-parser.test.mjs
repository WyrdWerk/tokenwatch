import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseOpenscale } from '../scripts/lib.mjs';

// Live snapshot of https://api.openscale.so/v1/models (2026-10-24). Public, no key.
const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/openscale-models.json', import.meta.url), 'utf8')
);

test('parseOpenscale maps the nested modality pricing arrays', () => {
  const rows = parseOpenscale(FIXTURE);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((m) => m.provider === 'openscale'));
  const flash = rows.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.equal(flash.pricing.input, 0.06);
  assert.equal(flash.pricing.output, 0.24);
  assert.equal(flash.pricing.cache_read, 0.003);
  assert.equal(flash.pricing.cache_write, null);
  assert.equal(flash.context_length, 1048568);
  assert.equal(flash.max_completion_tokens, 384000);
});

test('parseOpenscale resolves vendor-prefixed and aliased ids', () => {
  const rows = parseOpenscale(FIXTURE);
  assert.ok(rows.some((m) => m.id === 'glm-5.3-flash' && m.org === 'z-ai'));
  assert.ok(rows.some((m) => m.id === 'glm-5.3-flash-0828' && m.org === 'z-ai'));
  assert.ok(rows.some((m) => m.id === 'deepseek-v4.1-flash-0910'));
});

test('parseOpenscale keeps :fast as a delivery variant suffix', () => {
  const rows = parseOpenscale(FIXTURE);
  const fast = rows.filter((m) => m.id.endsWith(':fast'));
  assert.equal(fast.length, 2);
  assert.ok(fast.every((m) => m.pricing.input === 0.28));
});

test('parseOpenscale drops non-text output rows and unpriced rows', () => {
  const rows = parseOpenscale({ data: [
    { id: 'ok', input_modalities: [{ type: 'text', pricing: [{ type: 'prompt', cost_usd: '0.000001' }] }],
      output_modalities: [{ type: 'text', pricing: [{ type: 'completion', cost_usd: '0.000002' }] }] },
    { id: 'img', input_modalities: [{ type: 'text' }], output_modalities: [{ type: 'image' }] },
    { id: 'unpriced', input_modalities: [], output_modalities: [{ type: 'text', pricing: [] }] },
  ] });
  assert.deepEqual(rows.map((m) => m.id), ['ok']);
});
