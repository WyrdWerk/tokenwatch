import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseRefuselessPricingHtml,
  parseRefuselessPrice,
  parseRefuselessContext,
  REFUSELESS_MODELS,
} from '../scripts/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = await readFile(join(__dirname, 'fixtures', 'refuseless-pricing.html'), 'utf8');

test('parseRefuselessPrice reads $/M amounts, preferring the current price over a struck-through list price', () => {
  assert.equal(parseRefuselessPrice('$2.00'), 2);
  assert.equal(parseRefuselessPrice('$0.004'), 0.004);
  assert.equal(parseRefuselessPrice('—'), null);
  assert.equal(parseRefuselessPrice('$0.22 $0.14'), 0.14, 'list price first, current price last');
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
    'minimax-m3.1-flash',
  ].sort());
});

test('parseRefuselessPricingHtml maps labelled cells to prices and context', () => {
  const byId = new Map(parseRefuselessPricingHtml(fixture).map((r) => [r.id, r]));
  assert.deepEqual(byId.get('glm-5.3-abliterated'), {
    id: 'glm-5.3-abliterated',
    name: 'GLM 5.3 Abliterated',
    input: 1,
    output: 2,
    cache_read: 0.15,
    context_length: 1048576,
    original_input: null,
    original_output: null,
    original_cache_read: null,
    discount: 0,
  });
  assert.equal(byId.get('minimax-m3.1-flash').cache_read, 0.002);
  assert.equal(byId.get('minimax-m3.1-flash').context_length, 1048576);
});

test('parseRefuselessPricingHtml prices a discounted row at the current price and keeps the list price', () => {
  const byId = new Map(parseRefuselessPricingHtml(fixture).map((r) => [r.id, r]));
  const promo = byId.get('deepseek-v4.1-flash-abliterated');
  assert.equal(promo.input, 0.14, 'current promotional input is authoritative');
  assert.equal(promo.output, 0.5);
  assert.equal(promo.cache_read, 0.035);
  assert.equal(promo.original_input, 0.22, 'struck-through list input is preserved');
  assert.equal(promo.original_output, 0.75);
  assert.equal(promo.original_cache_read, 0.045);
  assert.ok(Math.abs(promo.discount - 0.363636) < 1e-6, `discount fraction from the input price, got ${promo.discount}`);

  const cachedOnly = byId.get('glm-5.3-flash-abliterated');
  assert.equal(cachedOnly.input, 0.12);
  assert.equal(cachedOnly.cache_read, 0.03);
  assert.equal(cachedOnly.original_cache_read, 0.04);
  assert.equal(cachedOnly.discount, 0.25);
});

test('parseRefuselessPricingHtml takes the fraction from a "% off" badge when no list price renders', () => {
  const html = `<table><tbody><tr class="pt-row"><td><span class="pt-title"><a class="pt-name" href="/models/x">X Model</a><span class="pt-tag">30% off</span></span><button class="pt-id"><span>x-model</span></button></td><td data-label="Input">$0.70</td><td data-label="Output">$1.40</td><td data-label="Cached">$0.07</td><td data-label="Context">1M</td></tr></tbody></table>`;
  const [row] = parseRefuselessPricingHtml(html);
  assert.equal(row.input, 0.7);
  assert.equal(row.original_input, null);
  assert.equal(row.discount, 0.3);
});

test('parseRefuselessPricingHtml keeps a badge inside the name link out of the model name', () => {
  const html = `<table><tbody><tr class="pt-row"><td><span class="pt-title"><a class="pt-name" href="/models/x">X Model <span class="pt-tag">Best at cyber</span></a></span><button class="pt-id"><span>x-model</span></button></td><td data-label="Input">$1.00</td><td data-label="Output">$2.00</td><td data-label="Cached">$0.10</td><td data-label="Context">1M</td></tr></tbody></table>`;
  assert.equal(parseRefuselessPricingHtml(html)[0].name, 'X Model');
});

test('parseRefuselessPricingHtml returns [] without pricing rows', () => {
  assert.deepEqual(parseRefuselessPricingHtml('<html><table><tr><td>x</td></tr></table></html>'), []);
  assert.deepEqual(parseRefuselessPricingHtml(''), []);
});

test('REFUSELESS_MODELS mirrors the live page, promos included', () => {
  const byId = new Map(REFUSELESS_MODELS.map((m) => [m.id, m]));
  assert.deepEqual([...byId.keys()].sort(), [
    'deepseek-v4.1-flash-abliterated',
    'deepseek-v4.1-flash-fast',
    'glm-5.3-flash-abliterated',
    'glm-5.3-abliterated',
    'minimax-m3.1-flash',
  ].sort());
  assert.equal(byId.has('qwen3.8-flash-next-abliterated'), false, 'qwen3.8 is no longer listed');

  const glm = byId.get('glm-5.3-abliterated');
  assert.deepEqual([glm.input, glm.output, glm.cache_read, glm.context_length], [1, 2, 0.15, 1048576]);

  const flash = byId.get('glm-5.3-flash-abliterated');
  assert.deepEqual([flash.input, flash.output, flash.cache_read], [0.12, 0.5, 0.03]);
  assert.equal(flash.discount, 0.25);
  assert.equal(flash.original_cache_read, 0.04);

  const deepseek = byId.get('deepseek-v4.1-flash-abliterated');
  assert.deepEqual([deepseek.input, deepseek.output, deepseek.cache_read], [0.14, 0.5, 0.035]);
  assert.deepEqual(
    [deepseek.original_input, deepseek.original_output, deepseek.original_cache_read],
    [0.22, 0.75, 0.045],
  );
  assert.ok(Math.abs(deepseek.discount - 0.363636) < 1e-6);

  const fast = byId.get('deepseek-v4.1-flash-fast');
  assert.equal(fast.name, 'DeepSeek V4.1 Flash 1017');
  assert.deepEqual([fast.input, fast.output, fast.cache_read, fast.discount ?? 0], [0.01, 0.08, 0.002, 0]);

  const minimax = byId.get('minimax-m3.1-flash');
  assert.equal(minimax.org, 'minimax');
  assert.deepEqual([minimax.input, minimax.output, minimax.cache_read], [0.02, 0.08, 0.002]);

  for (const model of REFUSELESS_MODELS) {
    assert.ok(model.input > 0 && model.output > 0, `${model.id}: positive prices`);
    assert.equal(model.context_length, 1048576);
  }
});
