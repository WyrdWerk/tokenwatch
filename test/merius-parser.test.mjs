import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercises the PRODUCTION parser (scripts/lib.mjs), not an inline copy.
import { parseMerius } from '../scripts/lib.mjs';

// Real 4-model fixture from https://api.merius.ai/v1/models (verified 2026-07-30)
const FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'deepseek-ai/DeepSeek-V4-Flash',
      name: 'DeepSeek-V4-Flash',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 1048576,
      max_output_length: 384000,
      is_ready: true,
      is_free: false,
      discount_to_user: 0,
      pricing: [{
        prompt: '0.6e-6',
        completion: '2.2e-6',
        input_cache_read: '0.19e-6',
      }],
    },
    {
      id: 'z-ai/glm-5.2',
      name: 'GLM-5.2',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 524288,
      max_output_length: 128000,
      is_ready: true,
      is_free: false,
      discount_to_user: 0,
      pricing: [{
        prompt: '0.6e-6',
        completion: '2.2e-6',
        input_cache_read: '0.14e-6',
      }],
    },
    {
      id: 'minimax/minimax-m3',
      name: 'MiniMax-M3',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 524288,
      max_output_length: 131072,
      is_ready: true,
      is_free: false,
      discount_to_user: 0,
      pricing: [{
        prompt: '0.3e-6',
        completion: '1.2e-6',
        input_cache_read: '0.06e-6',
      }],
    },
    {
      id: 'moonshotai/Kimi-K3',
      name: 'Kimi-K3',
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      context_length: 1048576,
      max_output_length: 131072,
      is_ready: true,
      is_free: false,
      discount_to_user: 0,
      pricing: [{
        prompt: '2.5e-6',
        completion: '13e-6',
        input_cache_read: '0.25e-6',
      }],
    },
  ],
};

test('parseMerius maps Merius API response to model records', () => {
  const result = parseMerius(FIXTURE);

  assert.equal(result.length, 4);

  const flash = result.find(m => m.id === 'deepseek-ai/DeepSeek-V4-Flash');
  assert.ok(flash, 'Flash should be in result');
  assert.equal(flash.provider, 'merius');
  assert.equal(flash.pricing.input, 0.6, 'Flash input $/M');
  assert.equal(flash.pricing.output, 2.2, 'Flash output $/M');
  assert.equal(flash.pricing.cache_read, 0.19, 'Flash cache_read $/M');
  assert.equal(flash.pricing.cache_write, null, 'Flash cache_write null');
  assert.equal(flash.context_length, 1048576);
  assert.equal(flash.max_output_length, 384000);
  assert.equal(flash.discount, 0, 'Flash discount_to_user mapped (currently 0)');

  const glm = result.find(m => m.id === 'z-ai/glm-5.2');
  assert.ok(glm, 'GLM should be in result');
  assert.equal(glm.pricing.input, 0.6, 'GLM input $/M');
  assert.equal(glm.pricing.output, 2.2, 'GLM output $/M');
  assert.equal(glm.pricing.cache_read, 0.14, 'GLM cache_read $/M');
  assert.equal(glm.context_length, 524288);

  const m3 = result.find(m => m.id === 'minimax/minimax-m3');
  assert.ok(m3, 'M3 should be in result');
  assert.equal(m3.pricing.input, 0.3, 'M3 input $/M');
  assert.equal(m3.pricing.output, 1.2, 'M3 output $/M');
  assert.equal(m3.pricing.cache_read, 0.06, 'M3 cache_read $/M');

  const k3 = result.find(m => m.id === 'moonshotai/Kimi-K3');
  assert.ok(k3, 'K3 should be in result');
  assert.equal(k3.pricing.input, 2.5, 'K3 input $/M');
  assert.equal(k3.pricing.output, 13, 'K3 output $/M');
  assert.equal(k3.pricing.cache_read, 0.25, 'K3 cache_read $/M');
  assert.equal(k3.max_output_length, 131072);
});

test('parseMerius includes multimodal input (text+image→text)', () => {
  const result = parseMerius(FIXTURE);
  const k3 = result.find(m => m.id === 'moonshotai/Kimi-K3');
  assert.ok(k3, 'Kimi K3 with text+image input should be included');
  assert.equal(k3.provider, 'merius');
});

test('parseMerius excludes is_ready:false', () => {
  const data = {
    data: [{
      id: 'test/unready',
      name: 'Unready',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 1000,
      max_output_length: 100,
      is_ready: false,
      is_free: false,
      pricing: [{ prompt: '1e-6', completion: '2e-6', input_cache_read: '0.5e-6' }],
    }],
  };
  const result = parseMerius(data);
  assert.equal(result.length, 0);
});

test('parseMerius excludes is_free:true', () => {
  const data = {
    data: [{
      id: 'test/free',
      name: 'Free',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 1000,
      max_output_length: 100,
      is_ready: true,
      is_free: true,
      pricing: [{ prompt: '1e-6', completion: '2e-6', input_cache_read: '0.5e-6' }],
    }],
  };
  const result = parseMerius(data);
  assert.equal(result.length, 0);
});

test('parseMerius excludes both-zero pricing', () => {
  const data = {
    data: [{
      id: 'test/zero',
      name: 'Zero',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 1000,
      max_output_length: 100,
      is_ready: true,
      is_free: false,
      pricing: [{ prompt: '0', completion: '0', input_cache_read: '0' }],
    }],
  };
  const result = parseMerius(data);
  assert.equal(result.length, 0);
});

test('parseMerius handles missing pricing array', () => {
  const data = {
    data: [{
      id: 'test/no-pricing',
      name: 'No Pricing',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 1000,
      max_output_length: 100,
      is_ready: true,
      is_free: false,
    }],
  };
  const result = parseMerius(data);
  assert.equal(result.length, 1);
  assert.equal(result[0].pricing.input, null);
  assert.equal(result[0].pricing.output, null);
  assert.equal(result[0].pricing.cache_read, null);
});

test('parseMerius handles empty data', () => {
  assert.deepEqual(parseMerius({}), []);
  assert.deepEqual(parseMerius({ data: [] }), []);
});

test('parseMerius excludes output_modalities != text', () => {
  const data = {
    data: [{
      id: 'test/image-gen',
      name: 'Image Gen',
      input_modalities: ['text'],
      output_modalities: ['image'],
      context_length: 1000,
      max_output_length: 100,
      is_ready: true,
      is_free: false,
      pricing: [{ prompt: '1e-6', completion: '2e-6', input_cache_read: '0.5e-6' }],
    }],
  };
  const result = parseMerius(data);
  assert.equal(result.length, 0);
});

test('parseMerius excludes missing text in input_modalities', () => {
  const data = {
    data: [{
      id: 'test/no-text-input',
      name: 'No Text Input',
      input_modalities: ['image'],
      output_modalities: ['text'],
      context_length: 1000,
      max_output_length: 100,
      is_ready: true,
      is_free: false,
      pricing: [{ prompt: '1e-6', completion: '2e-6', input_cache_read: '0.5e-6' }],
    }],
  };
  const result = parseMerius(data);
  assert.equal(result.length, 0);
});

test('parseMerius maps discount_to_user to discount field', () => {
  const data = {
    data: [{
      id: 'test/promo-model',
      name: 'Promo Model',
      input_modalities: ['text'],
      output_modalities: ['text'],
      context_length: 524288,
      max_output_length: 131072,
      is_ready: true,
      is_free: false,
      discount_to_user: 0.3,
      pricing: [{ prompt: '1e-6', completion: '2e-6', input_cache_read: '0.5e-6' }],
    }],
  };
  const result = parseMerius(data);
  assert.equal(result.length, 1);
  assert.equal(result[0].discount, 0.3, 'discount_to_user 0.3 mapped to discount');
});

test('merius provider is present in generated pricing.json', async () => {
  const raw = await readFile(new URL('../public/pricing.json', import.meta.url), 'utf8');
  const pricing = JSON.parse(raw);
  const rows = pricing.models.filter((m) => m.provider === 'merius');
  // Floor, not exact count — Merius adds/removes models in their live catalog;
  // this test guards presence + validity, not catalog size.
  assert.ok(rows.length >= 4, `expected >=4 merius rows in pricing.json, found ${rows.length}`);
  for (const m of rows) {
    assert.ok(m.pricing.input > 0 && m.pricing.output > 0, `${m.id} has positive pricing`);
    assert.equal(m.zdr, true, `${m.id} should be ZDR`);
  }
  assert.ok(pricing.providers_meta?.merius, 'providers_meta includes merius entry');
  assert.equal(pricing.providers_meta.merius.retains_prompts, false, 'merius retains_prompts false');
  assert.equal(pricing.providers_meta.merius.may_train, false, 'merius may_train false');
});
