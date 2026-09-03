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
