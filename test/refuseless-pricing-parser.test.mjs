import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRefuselessPricingHtml, parseRefuselessPrice, parseRefuselessContext } from '../scripts/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = await readFile(join(__dirname, 'fixtures', 'refuseless-pricing.html'), 'utf8');

test('parseRefuselessPrice reads $/M amounts', () => {
  assert.equal(parseRefuselessPrice('$2.00'), 2);
  assert.equal(parseRefuselessPrice('$0.004'), 0.004);
  assert.equal(parseRefuselessPrice('—'), null);
});

test('parseRefuselessContext uses binary K/M units like /v1/models', () => {
  assert.equal(parseRefuselessContext('1M'), 1048576);
  assert.equal(parseRefuselessContext('256K'), 262144);
  assert.equal(parseRefuselessContext(''), null);
});

test('parseRefuselessPricingHtml reads rows from every pricing table', () => {
  const rows = parseRefuselessPricingHtml(fixture);
  assert.deepEqual(rows.map((r) => r.id).sort(), [
    'deepseek-v4.1-flash-abliterated',
    'deepseek-v4.1-flash-fast',
    'glm-5.3-flash-abliterated',
    'glm-5.3-abliterated',
    'qwen3.8-flash-next-abliterated',
  ].sort());
});

test('parseRefuselessPricingHtml maps labelled cells to prices and context', () => {
  const byId = new Map(parseRefuselessPricingHtml(fixture).map((r) => [r.id, r]));
  assert.deepEqual(byId.get('glm-5.3-abliterated'), {
    id: 'glm-5.3-abliterated', name: 'GLM 5.3 Abliterated', input: 2, output: 3, cache_read: 0.35, context_length: 1048576,
  });
  assert.equal(byId.get('qwen3.8-flash-next-abliterated').context_length, 262144);
  assert.equal(byId.get('deepseek-v4.1-flash-fast').cache_read, 0.004);
});

test('parseRefuselessPricingHtml returns [] without pricing rows', () => {
  assert.deepEqual(parseRefuselessPricingHtml('<html><table><tr><td>x</td></tr></table></html>'), []);
  assert.deepEqual(parseRefuselessPricingHtml(''), []);
});
