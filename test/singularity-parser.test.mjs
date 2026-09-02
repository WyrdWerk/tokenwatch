import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSingularity } from '../scripts/lib.mjs';

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/singularity-models.json', import.meta.url), 'utf8')
);

test('parseSingularity maps the live catalog fixture', () => {
  const rows = parseSingularity(FIXTURE);
  assert.equal(rows.length, 9);
  assert.ok(rows.every((m) => m.provider === 'singularity'));
  const flash = rows.find((m) => m.id === 'deepseek-v4-flash');
  assert.equal(flash.org, 'deepseek');
  assert.equal(flash.pricing.input, 0.081);
  assert.equal(flash.pricing.output, 0.162);
  assert.equal(flash.pricing.cache_read, 0.007);
  assert.equal(flash.pricing.cache_write, null);
  assert.equal(flash.context_length, 1000000);
  assert.equal(flash.max_completion_tokens, 384000);
});

test('parseSingularity prefers /v1/chat/completions when multiple capabilities exist', () => {
  const rows = parseSingularity(FIXTURE);
  const luna = rows.find((m) => m.id === 'gpt-5.6-luna');
  assert.equal(luna.org, 'openai');
  assert.equal(luna.pricing.input, 0.18);
  assert.equal(luna.pricing.output, 1.1);
  assert.equal(luna.pricing.cache_read, 0.02);
});

test('parseSingularity maps null cached_input to null cache_read', () => {
  const v32 = parseSingularity(FIXTURE).find((m) => m.id === 'deepseek-v3.2');
  assert.equal(v32.pricing.cache_read, null);
  assert.equal(v32.org, 'deepseek');
});

test('parseSingularity assigns kimi rows to moonshot', () => {
  const kimi = parseSingularity(FIXTURE).find((m) => m.id === 'kimi-k2.7-code');
  assert.equal(kimi.org, 'moonshot');
  assert.equal(kimi.pricing.input, 0.639);
});

test('parseSingularity skips unpriced and empty payloads', () => {
  assert.deepEqual(parseSingularity({}), []);
  assert.deepEqual(parseSingularity({ data: [{ id: 'x', capabilities: [] }] }), []);
  assert.deepEqual(parseSingularity({
    data: [{ id: 'x', capabilities: [{ endpoint: '/v1/chat/completions', pricing: {} }] }],
  }), []);
});

test('parseSingularity skips image-only capabilities instead of treating them as text', () => {
  assert.deepEqual(parseSingularity({
    data: [{
      id: 'flux-1-schnell',
      capabilities: [{
        endpoint: '/v1/images/generations',
        pricing: { input_per_million_usd: '0', output_per_million_usd: '0.003' },
      }],
    }],
  }), []);
});

test('fetch-pricing wires Singularity behind SINGULARITY_API_KEY', async () => {
  const src = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  assert.match(src, /apiKeyEnv: 'SINGULARITY_API_KEY'/);
  assert.match(src, /key: 'singularity'/);
  assert.match(src, /singularity:/);
  assert.match(src, /retains_prompts: false/);
});

test('refresh workflows inject SINGULARITY_API_KEY from GitHub secrets', async () => {
  const pricing = await readFile(new URL('../.github/workflows/refresh-pricing.yml', import.meta.url), 'utf8');
  const aa = await readFile(new URL('../.github/workflows/refresh-aa.yml', import.meta.url), 'utf8');
  assert.match(pricing, /SINGULARITY_API_KEY: \$\{\{ secrets\.SINGULARITY_API_KEY \}\}/);
  assert.match(aa, /SINGULARITY_API_KEY: \$\{\{ secrets\.SINGULARITY_API_KEY \}\}/);
});
