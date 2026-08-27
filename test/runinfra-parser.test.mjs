import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRuninfra } from '../scripts/lib.mjs';

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/runinfra-models.json', import.meta.url), 'utf8')
);

test('parseRuninfra maps the live catalog fixture', () => {
  const rows = parseRuninfra(FIXTURE);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((m) => m.provider === 'runinfra'));
  const flash = rows.find((m) => m.id === 'deepseek-v4-flash');
  assert.equal(flash.org, 'deepseek');
  assert.equal(flash.pricing.input, 0.13);
  assert.equal(flash.pricing.output, 0.27);
  assert.equal(flash.pricing.cache_read, 0.01);
  assert.equal(flash.pricing.cache_write, null);
  assert.equal(flash.context_length, 1048576);
  assert.equal(flash.max_completion_tokens, 1048576);
});

test('parseRuninfra assigns creator orgs from bare ids', () => {
  const rows = parseRuninfra(FIXTURE);
  assert.equal(rows.find((m) => m.id === 'glm-5-3-flash').org, 'z-ai');
  assert.equal(rows.find((m) => m.id === 'nemotron-3-5-lightning-30b').org, 'nvidia');
  assert.equal(rows.find((m) => m.id === 'qwen3-8-27b').org, 'qwen');
  assert.equal(rows.find((m) => m.id === 'ornith-1-5-35b').org, 'ornith');
});

test('parseRuninfra skips paused models and non-llm modalities', () => {
  const paused = {
    id: 'deepseek-v4-flash',
    availability: 'paused',
    modality: 'llm',
    pricing: { input: 0.13, output: 0.27 },
  };
  const image = {
    id: 'some-image',
    availability: 'available',
    modality: 'image',
    pricing: { input: 1, output: 1 },
  };
  assert.deepEqual(parseRuninfra({ data: [paused, image] }), []);
});

test('parseRuninfra skips workspace deployments with no hosted pricing', () => {
  assert.deepEqual(parseRuninfra({
    data: [{ id: 'workspace/custom', availability: 'available', modality: 'llm' }],
  }), []);
});

test('parseRuninfra handles empty/malformed payloads', () => {
  assert.deepEqual(parseRuninfra({}), []);
  assert.deepEqual(parseRuninfra({ data: null }), []);
  assert.deepEqual(parseRuninfra({ data: [{ id: null, pricing: { input: 1, output: 1 } }] }), []);
});

test('fetch-pricing wires RunInfra behind RUNINFRA_API_KEY', async () => {
  const src = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  assert.match(src, /apiKeyEnv: 'RUNINFRA_API_KEY'/);
  assert.match(src, /key: 'runinfra'/);
  assert.match(src, /runinfra:/);
  assert.match(src, /status_page_url: 'https:\/\/status\.runinfra\.ai\/'/);
});

test('refresh workflows inject RUNINFRA_API_KEY from GitHub secrets', async () => {
  const pricing = await readFile(new URL('../.github/workflows/refresh-pricing.yml', import.meta.url), 'utf8');
  const aa = await readFile(new URL('../.github/workflows/refresh-aa.yml', import.meta.url), 'utf8');
  assert.match(pricing, /RUNINFRA_API_KEY: \$\{\{ secrets\.RUNINFRA_API_KEY \}\}/);
  assert.match(aa, /RUNINFRA_API_KEY: \$\{\{ secrets\.RUNINFRA_API_KEY \}\}/);
});
