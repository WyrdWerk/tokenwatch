import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenRouterEndpointCapabilities } from '../shared/openrouter-endpoint.mjs';

test('OpenRouter endpoint capabilities normalize to the public data contract', () => {
  assert.deepEqual(normalizeOpenRouterEndpointCapabilities({
    supported_parameters: ['temperature', 'tool_choice'],
    supports_tool_choice: { auto: true, function: false, none: false, required: true },
    supports_implicit_caching: false,
    max_prompt_tokens: 128000,
    uptime_last_1d: 99.75,
  }), {
    supported_parameters: ['temperature', 'tool_choice'],
    supports_tool_choice: true,
    supports_implicit_caching: false,
    max_prompt_tokens: 128000,
    uptime_1d: 99.75,
  });
});

test('missing or malformed OpenRouter capability values stay null', () => {
  assert.deepEqual(normalizeOpenRouterEndpointCapabilities({
    supported_parameters: 'temperature',
    supports_tool_choice: { auto: false, function: 'unknown' },
    supports_implicit_caching: 0,
    max_prompt_tokens: 12.5,
    uptime_last_1d: '99.5',
  }), {
    supported_parameters: null,
    supports_tool_choice: null,
    supports_implicit_caching: null,
    max_prompt_tokens: null,
    uptime_1d: null,
  });
});

test('all-false tool-choice details normalize to false', () => {
  assert.equal(normalizeOpenRouterEndpointCapabilities({
    supports_tool_choice: { auto: false, function: false, none: false, required: false },
  }).supports_tool_choice, false);
});

test('batch variants fetch /endpoints by their own id, not the shared base canonical_slug', async () => {
  const { openRouterEndpointSlug } = await import('../scripts/lib.mjs');
  // OpenRouter gives :batch the base model's dated slug; fetching that slug
  // returns real-time prices (2026-10-16: Haiku 5.5 batch $0.05 shown as $0.10).
  assert.equal(
    openRouterEndpointSlug({ id: 'anthropic/claude-haiku-5.5:batch', canonical_slug: 'anthropic/claude-haiku-5.5-20261007' }),
    'anthropic/claude-haiku-5.5:batch',
  );
  assert.equal(
    openRouterEndpointSlug({ id: 'anthropic/claude-haiku-5.5', canonical_slug: 'anthropic/claude-haiku-5.5-20261007' }),
    'anthropic/claude-haiku-5.5-20261007',
  );
  assert.equal(openRouterEndpointSlug({ id: 'x/y' }), null);
});

test('OpenRouter endpoints: standard price for the main row, each service tier as its own :tier row', async () => {
  const { selectOpenRouterEndpoints } = await import('../scripts/lib.mjs');
  // Shape of GPT-6.1 Sol /endpoints on 2026-10-16 (cheapest-first, flex listed first).
  const ep = (provider_name, tag, prompt, completion) => ({ provider_name, tag, pricing: { prompt, completion } });
  const rows = selectOpenRouterEndpoints([
    ep('OpenAI', 'openai/flex', '0.000001', '0.000005'),
    ep('Azure', 'azure', '0.000002', '0.00001'),
    ep('OpenAI', 'openai', '0.000002', '0.00001'),
    ep('Azure', 'azure/eu', '0.0000022', '0.000011'),
    ep('OpenAI', 'openai/fast', '0.000004', '0.00002'),
    ep('OpenAI', 'openai/ultrafast', '0.000012', '0.00006'),
  ], 'openai/gpt-6.1-sol');
  const byId = Object.fromEntries(rows.map((r) => [`${r.id}|${r.endpoint.provider_name}`, r.endpoint.pricing.prompt]));
  assert.deepEqual(byId, {
    'openai/gpt-6.1-sol|OpenAI': '0.000002',          // standard, not the $1 flex price
    'openai/gpt-6.1-sol|Azure': '0.000002',           // cheapest standard region
    'openai/gpt-6.1-sol:flex|OpenAI': '0.000001',
    'openai/gpt-6.1-sol:fast|OpenAI': '0.000004',
    'openai/gpt-6.1-sol:ultrafast|OpenAI': '0.000012',
  });
});

test('OpenRouter endpoints: regions/precisions are not tiers, and :batch ids are never split', async () => {
  const { selectOpenRouterEndpoints, openRouterServiceTier } = await import('../scripts/lib.mjs');
  assert.equal(openRouterServiceTier('google-vertex/global/flex'), 'flex');
  assert.equal(openRouterServiceTier('deepinfra/fp8'), null);
  assert.equal(openRouterServiceTier('azure/us'), null);
  const rows = selectOpenRouterEndpoints([
    { provider_name: 'Anthropic', tag: 'anthropic/priority', pricing: { prompt: '0.0000001', completion: '0.0000005' } },
    { provider_name: 'Anthropic', tag: 'anthropic', pricing: { prompt: '0.00000005', completion: '0.00000025' } },
  ], 'anthropic/claude-haiku-5.5:batch');
  assert.deepEqual(rows.map((r) => [r.id, r.endpoint.pricing.prompt]), [['anthropic/claude-haiku-5.5:batch', '0.00000005']]);
});

test('OpenRouter endpoints: a provider whose only listing is a fast/turbo tier keeps it as its main row', async () => {
  const { selectOpenRouterEndpoints } = await import('../scripts/lib.mjs');
  const ep = (provider_name, tag, prompt) => ({ provider_name, tag, pricing: { prompt, completion: prompt } });
  const rows = selectOpenRouterEndpoints([
    ep('DeepInfra', 'deepinfra/turbo', '0.0000001'),
    ep('Google', 'google-vertex/flex', '0.00000005'),
  ], 'meta-llama/llama-3.3-70b-instruct');
  assert.deepEqual(rows.map((r) => [r.endpoint.provider_name, r.id, r.tier]), [
    ['DeepInfra', 'meta-llama/llama-3.3-70b-instruct', 'turbo'], // DeepInfra's normal product
    ['Google', 'meta-llama/llama-3.3-70b-instruct:flex', 'flex'], // flex-only stays a hidden tier row
  ]);
});
