import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBenchmarkOffering } from '../scripts/fetch-benchmarks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('benchmark offering includes resolved model capabilities and performance p50 values', () => {
  const offering = buildBenchmarkOffering({
    id: 'Qwen/Qwen3.6-27B',
    provider: 'novita',
    provider_display: 'Novita',
    quantization: 'fp8',
    zdr: true,
    context_length: 262144,
    uptime_30m: 99.9,
    open_weights: true,
    license: 'apache-2.0',
    modelsdev: { capabilities: { tool_call: true } },
    pricing: { input: 0.2, cache_write: null, input_billing: null, output: 0.8, cache_read: null },
  }, {
    'qwen3.6-27b|novita': {
      throughput: { p50: 68 },
      latency: { p50: 920 },
    },
  });

  assert.deepEqual(offering, {
    provider: 'Novita',
    input: 0.2,
    cache_write: null,
    input_billing: null,
    output: 0.8,
    cache_read: null,
    quantization: 'fp8',
    zdr: true,
    context_length: 262144,
    uptime_30m: 99.9,
    open_weights: true,
    tool_call: true,
    throughput_p50: 68,
    latency_p50: 920,
  });
});

test('benchmark tool-call and performance fields remain null when unavailable', () => {
  const offering = buildBenchmarkOffering({
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    pricing: { input: 3, output: 15 },
  }, {});

  assert.equal(offering.tool_call, null);
  assert.equal(offering.throughput_p50, null);
  assert.equal(offering.latency_p50, null);
  assert.equal(offering.open_weights, null);
});

test('generated benchmark catalog exposes model- and offering-level recommender fields', async (t) => {
  const data = JSON.parse(await readFile(join(__dirname, '..', 'public', 'benchmarks.json'), 'utf8'));
  if (!data.models.some((model) => Object.hasOwn(model, 'open_weights'))) {
    t.skip('committed benchmark snapshot predates the recommender data contract');
    return;
  }

  assert.ok(data.models.length > 0, 'benchmark catalog should contain models');
  for (const model of data.models) {
    assert.ok(model.open_weights === null || typeof model.open_weights === 'boolean', `${model.id} has invalid open_weights`);
    assert.ok(model.license === null || typeof model.license === 'string', `${model.id} has invalid license`);
    for (const offering of model.offerings) {
      for (const field of [
        'quantization', 'zdr', 'context_length', 'uptime_30m', 'open_weights',
        'tool_call', 'throughput_p50', 'latency_p50',
      ]) {
        assert.ok(Object.hasOwn(offering, field), `${model.id}/${offering.provider} missing ${field}`);
      }
    }
  }
});
