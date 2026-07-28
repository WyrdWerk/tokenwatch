import { test } from 'node:test';
import assert from 'node:assert/strict';

// Inline parseSference for testing (mirrors the implementation in fetch-pricing.mjs)
function parseSference(data) {
  const passthrough = (val) => (val != null ? Number(val) : null);
  return (data.data || [])
    .filter((m) => m.modality === 'text_generation')
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      provider: 'sference',
      quantization: null,
      discount: 0,
      context_length: m.context_tokens ?? null,
      pricing: {
        input: passthrough(m.pricing?.input_per_million_usd),
        output: passthrough(m.pricing?.output_per_million_usd),
        cache_read: passthrough(m.pricing?.cached_input_per_million_usd),
        cache_write: null,
      },
    }));
}

const GLM = {
  id: 'zai-org/GLM-5.2',
  display_name: 'GLM 5.2',
  modality: 'text_generation',
  context_tokens: 1048576,
  pricing: {
    input_per_million_usd: 1.2,
    output_per_million_usd: 4.2,
    cached_input_per_million_usd: 0.26,
  },
};

test('parseSference maps Sference API response to model records', () => {
  const result = parseSference({ data: [GLM] });

  assert.equal(result.length, 1);
  const m = result[0];
  assert.equal(m.id, 'zai-org/GLM-5.2');
  assert.equal(m.name, 'GLM 5.2', 'display_name maps to name');
  assert.equal(m.provider, 'sference');
  assert.equal(m.quantization, null);
  assert.equal(m.discount, 0);
  assert.equal(m.context_length, 1048576, 'context_tokens maps to context_length');
  assert.equal(m.pricing.input, 1.2, 'input price passthrough ($/M)');
  assert.equal(m.pricing.output, 4.2, 'output price passthrough ($/M)');
  assert.equal(m.pricing.cache_read, 0.26, 'cached_input maps to cache_read');
  assert.equal(m.pricing.cache_write, null, 'cache_write not available from API');
});

test('parseSference filters out non-text-generation modalities', () => {
  const imageGen = { ...GLM, id: 'org/img-1', modality: 'image_generation' };
  const embed = { ...GLM, id: 'org/emb-1', modality: 'embedding' };
  const result = parseSference({ data: [GLM, imageGen, embed] });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'zai-org/GLM-5.2');
});

test('parseSference handles empty/missing data array', () => {
  assert.deepEqual(parseSference({}), []);
  assert.deepEqual(parseSference({ data: [] }), []);
});

test('parseSference uses id as name fallback when display_name missing', () => {
  const noName = { ...GLM };
  delete noName.display_name;
  const result = parseSference({ data: [noName] });
  assert.equal(result[0].name, 'zai-org/GLM-5.2');
});

test('parseSference maps missing pricing fields to null', () => {
  const noPricing = { ...GLM };
  delete noPricing.pricing;
  const result = parseSference({ data: [noPricing] });
  assert.equal(result[0].pricing.input, null);
  assert.equal(result[0].pricing.output, null);
  assert.equal(result[0].pricing.cache_read, null);
});
