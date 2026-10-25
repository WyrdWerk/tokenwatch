import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDeliveryVariant, deliveryVariant, stripDeliveryVariant, canonicalId } from '../shared/normalize.mjs';
import { deliveryVariantIssues } from '../scripts/lib.mjs';
import { skuFromId } from '../shared/price-history.mjs';

// Real ids from public/pricing.json (2026-10-25) that published discounted
// prices under standard ids before normalization.
const SPELLED = [
  ['glm-5.3-flex', 'glm-5.3:flex'],
  ['kimi-k3-flex', 'kimi-k3:flex'],
  ['nw-small-flex', 'nw-small:flex'],
  ['deepseek-v4.1-flash-flex', 'deepseek-v4.1-flash:flex'],
  ['zai-org/glm-5.2-batch', 'zai-org/glm-5.2:batch'],
  ['deepseek-v4-pro-(off-peak)', 'deepseek-v4-pro:off-peak'],
  ['deepseek-v4.1-flash-(off-peak)', 'deepseek-v4.1-flash:off-peak'],
];

test('normalizeDeliveryVariant rewrites provider-spelled variants to colon form', () => {
  for (const [raw, want] of SPELLED) {
    assert.equal(normalizeDeliveryVariant(raw), want, raw);
    assert.notEqual(deliveryVariant(want), null, want);
  }
  assert.equal(normalizeDeliveryVariant('model-offpeak'), 'model:off-peak');
});

test('normalizeDeliveryVariant leaves distinct models and colon ids alone', () => {
  for (const id of ['gpt-oss-120b-fast', 'kimi-k3-fast', 'glm-5-turbo', 'qwen3.6-35b', 'openai/gpt-5-nano:batch', 'x:flex', 'flex', 'batch', 'gemini-flash', 'flexible-7b']) {
    assert.equal(normalizeDeliveryVariant(id), id, id);
  }
  assert.equal(normalizeDeliveryVariant(normalizeDeliveryVariant('glm-5.3-flex')), 'glm-5.3:flex');
});

test(':off-peak is a delivery variant everywhere the shared regex is used', () => {
  assert.equal(deliveryVariant('deepseek-v4-pro:off-peak'), 'off-peak');
  assert.equal(stripDeliveryVariant('deepseek-v4-pro:off-peak'), 'deepseek-v4-pro');
  assert.equal(canonicalId('deepseek-v4-pro:off-peak'), 'deepseek-v4-pro:off-peak');
  assert.equal(skuFromId('deepseek-v4-pro:off-peak'), ':off-peak');
});

test('deliveryVariantIssues flags variant-named standard ids and inverted variant prices', () => {
  const row = (id, name, input, output, provider = 'neuralwatt') => ({ id, name, provider, pricing: { input, output } });
  const issues = deliveryVariantIssues([
    row('glm-5.3', 'GLM 5.3', 1.45, 4.5),
    row('glm-5.3:flex', 'GLM 5.3 (flex)', 0.9425, 2.925),     // fine: discounted variant
    row('nw-new-tier', 'NW New (Flex)', 0.2, 1),               // unknown spelling
    row('kimi-k3', 'Kimi K3', 1, 5),
    row('kimi-k3:flex', 'Kimi K3 (flex)', 1.95, 9.75),          // standard cheaper than flex
    row('kimi-k3:flex', 'Kimi K3 (flex)', 0.5, 2, 'other'),     // no same-provider base
    row('kimi-k3:priority', 'Kimi K3', 2, 10),                  // premium tier: not checked
  ]);
  assert.equal(issues.length, 2, issues.join('\n'));
  assert.match(issues[0], /nw-new-tier/);
  assert.match(issues[1], /kimi-k3: standard 1\/5 is cheaper than its :flex/);
});
