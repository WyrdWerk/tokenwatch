/**
 * OpenRouter /endpoints capability normalization.
 * Pure helper; keeps provider-reported unknowns as null instead of guessing.
 */

function normalizeToolChoice(value) {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const flags = Object.values(value);
  if (flags.length === 0 || flags.some((flag) => typeof flag !== 'boolean')) return null;
  return flags.some(Boolean);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeOpenRouterEndpointCapabilities(endpoint) {
  const parameters = endpoint?.supported_parameters;
  const maxPromptTokens = endpoint?.max_prompt_tokens;
  return {
    supported_parameters: Array.isArray(parameters)
      ? parameters.filter((parameter) => typeof parameter === 'string')
      : null,
    supports_tool_choice: normalizeToolChoice(endpoint?.supports_tool_choice),
    supports_implicit_caching: typeof endpoint?.supports_implicit_caching === 'boolean'
      ? endpoint.supports_implicit_caching
      : null,
    max_prompt_tokens: Number.isInteger(maxPromptTokens) ? maxPromptTokens : null,
    uptime_1d: finiteNumber(endpoint?.uptime_last_1d),
  };
}
