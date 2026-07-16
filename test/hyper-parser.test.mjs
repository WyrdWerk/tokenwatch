import { test } from 'node:test';
import assert from 'node:assert/strict';

// Inline parseHyper for testing (mirrors the implementation in fetch-pricing.mjs)
function parseHyper(data) {
  const passthrough = (val) => (val != null ? Number(val) : null);
  const dataArray = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return dataArray
    .filter((m) => m.pricing && (m.pricing.input != null || m.pricing.output != null))
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      provider: 'hyper',
      quantization: null,
      discount: 0,
      context_length: m.context_window ?? null,
      pricing: {
        input: passthrough(m.pricing?.input),
        output: passthrough(m.pricing?.output),
        cache_read: passthrough(m.pricing?.cache_hit),
        cache_write: passthrough(m.pricing?.cache_create),
      },
    }));
}

test('parseHyper maps Hyper API response to model records', () => {
  const mockApiResponse = {
    data: [
      {
        id: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash',
        context_window: 1000000,
        max_output_tokens: 384000,
        owned_by: 'hyper',
        pricing: {
          input: 0.2,
          output: 0.4,
          cache_create: 0.01,
          cache_hit: 0.04,
        },
        capabilities: { vision: false },
        reasoning: { effort_levels: ['none', 'low', 'medium', 'high'] },
      },
      {
        id: 'deepseek-v4-pro',
        display_name: 'DeepSeek V4 Pro',
        context_window: 1000000,
        max_output_tokens: 384000,
        owned_by: 'hyper',
        pricing: {
          input: 2.4,
          output: 4.8,
          cache_create: 0,
          cache_hit: 0,
        },
        capabilities: { vision: false },
        reasoning: { effort_levels: ['none', 'low', 'medium', 'high'] },
      },
      {
        id: 'glm-5.2',
        display_name: 'GLM 5.2',
        context_window: 1048576,
        max_output_tokens: 409600,
        owned_by: 'hyper',
        pricing: {
          input: 1.4,
          output: 4.4,
          cache_create: 0.26,
          cache_hit: 0.26,
        },
        capabilities: { vision: false },
        reasoning: { effort_levels: [] },
      },
    ],
  };

  const result = parseHyper(mockApiResponse);

  assert.equal(result.length, 3, 'Should parse 3 models');

  // Test deepseek-v4-flash
  const flash = result.find((m) => m.id === 'deepseek-v4-flash');
  assert.equal(flash.name, 'DeepSeek V4 Flash', 'display_name maps to name');
  assert.equal(flash.provider, 'hyper', 'provider is hyper');
  assert.equal(flash.context_length, 1000000, 'context_window maps to context_length');
  assert.equal(flash.quantization, null, 'quantization is null');
  assert.equal(flash.discount, 0, 'discount is 0');
  assert.equal(flash.pricing.input, 0.2, 'input price passthrough');
  assert.equal(flash.pricing.output, 0.4, 'output price passthrough');
  assert.equal(flash.pricing.cache_read, 0.04, 'cache_hit maps to cache_read');
  assert.equal(flash.pricing.cache_write, 0.01, 'cache_create maps to cache_write');

  // Test deepseek-v4-pro (with zero cache values)
  const pro = result.find((m) => m.id === 'deepseek-v4-pro');
  assert.equal(pro.name, 'DeepSeek V4 Pro');
  assert.equal(pro.pricing.cache_read, 0, 'cache_hit:0 stays numeric 0, not null');
  assert.equal(pro.pricing.cache_write, 0, 'cache_create:0 stays numeric 0, not null');
  assert.strictEqual(pro.pricing.cache_read, 0, 'cache_read is strictly 0 (number)');
  assert.strictEqual(pro.pricing.cache_write, 0, 'cache_write is strictly 0 (number)');

  // Test glm-5.2
  const glm = result.find((m) => m.id === 'glm-5.2');
  assert.equal(glm.name, 'GLM 5.2');
  assert.equal(glm.context_length, 1048576);
  assert.equal(glm.pricing.input, 1.4);
  assert.equal(glm.pricing.output, 4.4);
  assert.equal(glm.pricing.cache_read, 0.26);
  assert.equal(glm.pricing.cache_write, 0.26);
});

test('parseHyper handles empty/missing data array', () => {
  assert.equal(parseHyper({}).length, 0, 'empty object returns empty array');
  assert.equal(parseHyper({ data: null }).length, 0, 'null data returns empty array');
  assert.equal(parseHyper({ data: [] }).length, 0, 'empty array returns empty array');
});

test('parseHyper filters out models without pricing', () => {
  const mockResponse = {
    data: [
      {
        id: 'model-with-pricing',
        display_name: 'Model With Pricing',
        context_window: 100000,
        pricing: { input: 0.1, output: 0.2, cache_create: 0, cache_hit: 0.01 },
      },
      {
        id: 'model-no-pricing',
        display_name: 'Model No Pricing',
        context_window: 100000,
      },
      {
        id: 'model-empty-pricing',
        display_name: 'Model Empty Pricing',
        context_window: 100000,
        pricing: {},
      },
    ],
  };

  const result = parseHyper(mockResponse);
  assert.equal(result.length, 1, 'Should filter to 1 model with pricing');
  assert.equal(result[0].id, 'model-with-pricing');
});

test('parseHyper uses id as name fallback when display_name missing', () => {
  const mockResponse = {
    data: [
      {
        id: 'bare-model-id',
        context_window: 100000,
        pricing: { input: 0.1, output: 0.2, cache_create: 0, cache_hit: 0.01 },
      },
    ],
  };

  const result = parseHyper(mockResponse);
  assert.equal(result[0].name, 'bare-model-id', 'id used as name fallback');
});
