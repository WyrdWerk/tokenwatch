import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLlmgateway } from '../scripts/lib.mjs';

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/llmgateway-models.json', import.meta.url), 'utf8')
);

test('parseLlmgateway keeps only differential providers as priced text rows', () => {
  const rows = parseLlmgateway(FIXTURE);
  const providers = new Set(rows.map((r) => r.provider));

  // Known TokenWatch backends must not appear.
  for (const p of ['novita', 'openai', 'z-ai', 'zai', 'google', 'google-ai-studio', 'google-vertex', 'llmgateway']) {
    assert.equal(providers.has(p), false, `must not emit known provider ${p}`);
  }

  assert.ok(rows.some((r) => r.provider === 'runware' && r.id === 'glm-5.3-flash'));
  assert.ok(rows.some((r) => r.provider === 'bytedance' && r.id === 'gpt-oss-120b'));
  assert.ok(rows.some((r) => r.provider === 'nanogpt' && r.id === 'gpt-oss-120b'));

  const runware = rows.find((r) => r.provider === 'runware' && r.id === 'glm-5.3-flash');
  assert.equal(runware.org, 'z-ai');
  assert.equal(runware.pricing.input, 0.15);
  assert.equal(runware.pricing.output, 0.5);
  assert.equal(runware.pricing.cache_read, 0.03);
  assert.equal(runware.quantization, null);
});

test('parseLlmgateway keeps a non-zero input_cache_write and treats 0 as null', () => {
  const rows = parseLlmgateway({
    data: [{
      id: 'qwen3.8-max',
      architecture: { output_modalities: ['text'] },
      providers: [
        {
          providerId: 'runware',
          pricing: {
            prompt: '2e-6',
            completion: '6e-6',
            input_cache_read: '0.25e-6',
            input_cache_write: '2.5e-6',
          },
        },
        {
          providerId: 'nanogpt',
          pricing: {
            prompt: '2e-6',
            completion: '6e-6',
            input_cache_read: '0.25e-6',
            input_cache_write: '0',
          },
        },
      ],
    }],
  });
  const runware = rows.find((r) => r.provider === 'runware');
  const nanogpt = rows.find((r) => r.provider === 'nanogpt');
  assert.equal(runware.pricing.cache_write, 2.5);
  assert.equal(nanogpt.pricing.cache_write, null);
});

test('parseLlmgateway drops image-output and unpriced rows', () => {
  const rows = parseLlmgateway(FIXTURE);
  assert.ok(!rows.some((r) => r.id === 'gemini-3-pro-image'));
  assert.ok(!rows.some((r) => r.id === 'custom'));
  assert.ok(!rows.some((r) => r.provider === 'glacier'));
  assert.ok(!rows.some((r) => r.provider === 'iceberg' && r.id === 'gemini-3-pro-image'));
  assert.ok(!rows.some((r) => r.provider === 'quartz' && r.id === 'gemini-3-pro-image'));
});

test('parseLlmgateway handles empty payloads', () => {
  assert.deepEqual(parseLlmgateway({}), []);
  assert.deepEqual(parseLlmgateway({ data: [] }), []);
  assert.deepEqual(parseLlmgateway(null), []);
});

test('fetch-pricing wires LLM Gateway behind LLMGATEWAY_API_KEY', async () => {
  const src = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  assert.match(src, /apiKeyEnv: 'LLMGATEWAY_API_KEY'/);
  assert.match(src, /key: 'llmgateway'/);
  assert.match(src, /parseLlmgateway/);
});

test('refresh workflows inject LLMGATEWAY_API_KEY from GitHub secrets', async () => {
  const pricing = await readFile(new URL('../.github/workflows/refresh-pricing.yml', import.meta.url), 'utf8');
  const aa = await readFile(new URL('../.github/workflows/refresh-aa.yml', import.meta.url), 'utf8');
  assert.match(pricing, /LLMGATEWAY_API_KEY: \$\{\{ secrets\.LLMGATEWAY_API_KEY \}\}/);
  assert.match(aa, /LLMGATEWAY_API_KEY: \$\{\{ secrets\.LLMGATEWAY_API_KEY \}\}/);
});

test('parseLlmgateway skips Inference.net (an OpenRouter backend) and names differential hosts', async () => {
  const rows = parseLlmgateway({
    data: [{
      id: 'glm-5.3',
      architecture: { output_modalities: ['text'] },
      providers: [
        { providerId: 'inference.net', pricing: { prompt: '0.9e-6', completion: '3e-6' } },
        { providerId: 'inference-net', pricing: { prompt: '0.9e-6', completion: '3e-6' } },
        { providerId: 'runware', pricing: { prompt: '1.2e-6', completion: '4e-6' } },
        { providerId: 'scx-ai-gp', pricing: { prompt: '1.4e-6', completion: '4.4e-6' } },
        { providerId: 'brand-new-host', pricing: { prompt: '1e-6', completion: '2e-6' } },
      ],
    }],
  });
  assert.deepEqual(rows.map((r) => r.provider), ['runware', 'scx-ai-gp', 'brand-new-host']);
  assert.deepEqual(rows.map((r) => r.provider_display), ['Runware', 'SCX.ai GP', 'Brand New Host']);
});

test('dropCoveredLlmgatewayRows removes LLM Gateway hosts another tier fetched under a different spelling', async () => {
  const { dropCoveredLlmgatewayRows, dedupModels } = await import('../scripts/lib.mjs');
  const gateway = [
    { id: 'glm-5.3', provider: 'inference-net', pricing: { input: 0.9, output: 3 } },
    { id: 'glm-5.3', provider: 'runware', pricing: { input: 1.2, output: 4 } },
  ];
  const openrouter = [
    { id: 'z-ai/glm-5.3', provider: 'inferencenet', provider_display: 'InferenceNet', pricing: { input: 0.08, output: 5 } },
  ];
  const rows = dropCoveredLlmgatewayRows([...gateway, ...openrouter], new Set(gateway));
  assert.deepEqual(rows.map((r) => r.provider), ['runware', 'inferencenet']);
  // Without the guard the two spellings survive dedup as separate providers.
  assert.equal(dedupModels([...gateway, ...openrouter]).filter((r) => /inference/.test(r.provider)).length, 2);
});
