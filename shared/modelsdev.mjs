/**
 * shared/modelsdev.mjs — pure reconciliation helpers for the models.dev
 * enrichment source.
 *
 * This module MUST NOT import any node: builtins (same constraint as
 * shared/normalize.mjs). It is pure string-transform logic.
 *
 * Imported by:
 *   - scripts/lib.mjs (re-exports the public surface)
 *   - scripts/fetch-modelsdev.mjs (builds the enrichment index)
 */

import { canonicalId } from './normalize.mjs';

/**
 * TW provider slug → models.dev provider_id.
 * Entries where the slug differs are explicit; identity mappings are
 * included for providers that exist on both sides with the same key
 * (for lookup clarity and so the reverse map derives correctly).
 */
export const PROVIDER_MAP = {
  // slug-format differences (bespoke)
  deepinfra: 'deep-infra',
  fireworks: 'fireworks-ai',
  together: 'togetherai',
  novita: 'novita-ai',
  moonshot: 'moonshotai',
  sambanova: 'nova',
  'z-ai': 'zai',
  xiaomimimo: 'xiaomi',
  wafer: 'wafer.ai',
  amazon: 'amazon-bedrock',
  cloudflare: 'cloudflare-workers-ai',
  // identity mappings (same slug on both sides)
  alibaba: 'alibaba',
  anthropic: 'anthropic',
  azure: 'azure',
  baseten: 'baseten',
  cerebras: 'cerebras',
  chutes: 'chutes',
  clarifai: 'clarifai',
  cohere: 'cohere',
  crof: 'crof',
  deepseek: 'deepseek',
  digitalocean: 'digitalocean',
  friendli: 'friendli',
  gmicloud: 'gmicloud',
  google: 'google',
  groq: 'groq',
  inception: 'inception',
  'io-net': 'io-net',
  lilac: 'lilac',
  minimax: 'minimax',
  mistral: 'mistral',
  morph: 'morph',
  nebius: 'nebius',
  openai: 'openai',
  opencode: 'opencode-go',
  perplexity: 'perplexity',
  poolside: 'poolside',
  sakana: 'sakana',
  stepfun: 'stepfun',
  synthetic: 'synthetic',
  upstage: 'upstage',
  venice: 'venice',
  wandb: 'wandb',
  xai: 'xai',
};

/**
 * models.dev provider_id → TW provider slug. Derived from PROVIDER_MAP.
 * Note: non-injective maps (multiple TW keys → same md id) are not expected
 * here; every value in PROVIDER_MAP is currently unique, so this reverse
 * lookup is unambiguous.
 */
export const REVERSE_PROVIDER_MAP = Object.fromEntries(
  Object.entries(PROVIDER_MAP).map(([tw, md]) => [md, tw]),
);

/**
 * Normalize a model ID for join-key purposes, applying any provider-specific
 * transform. Default: canonicalId only. Providers with bespoke ID formats
 * (cloudflare, amazon, fireworks, minimax) are handled in PROVIDER_NORMALIZERS.
 */
export function normalizeForMatch(providerKey, modelId) {
  const fn = PROVIDER_NORMALIZERS[providerKey];
  return fn ? fn(modelId) : canonicalId(modelId);
}

// Filled in by later tasks. Default fallback uses canonicalId.
const PROVIDER_NORMALIZERS = {};
