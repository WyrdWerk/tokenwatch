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
