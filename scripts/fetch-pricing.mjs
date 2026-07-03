#!/usr/bin/env node
/**
 * fetch-pricing.mjs
 *
 * Fetches /v1/models from each public provider, normalizes pricing to a
 * canonical schema (all prices in USD per million tokens), and writes
 * public/pricing.json for the static frontend to consume.
 *
 * Canonical model record:
 * {
 *   id:          "provider/model"        (normalized cross-provider key where possible)
 *   name:        string
 *   org:         "anthropic" | "openai" | "deepseek" | ...  (underlying model creator)
 *   provider:    "openrouter" | "wafer" | "crof" | "deepinfra" | "ember"
 *   context_length: number | null
 *   pricing: {
 *     input:       number | null   ($/M tokens)
 *     output:      number | null   ($/M tokens)
 *     cache_read:  number | null   ($/M tokens)
 *     cache_write: number | null   ($/M tokens)
 *   }
 * }
 *
 * Unit conversions (all → $/M tokens):
 *   openrouter / ember  → $/token      → ×1e6
 *   crof                         → $/M          → as-is
 *   wafer                        → cents/M      → ÷100
 *   deepinfra                    → $/M          → as-is
 */

import { writeFile, mkdir } from 'node:fs/promises';

// ── providers config ──────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    key: 'openrouter',
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/models',
    parse: parseOpenRouter,
  },
  {
    key: 'deepinfra',
    name: 'DeepInfra',
    url: 'https://api.deepinfra.com/v1/models',
    parse: parseDeepInfra,
  },
  {
    key: 'crof',
    name: 'Crof',
    url: 'https://crof.ai/v1/models',
    parse: parseCrof,
  },
  {
    key: 'ember',
    name: 'EmberCloud',
    url: 'https://api.embercloud.ai/v1/models',
    parse: parseEmber,
  },
  {
    key: 'wafer',
    name: 'Wafer (Pass)',
    url: 'https://pass.wafer.ai/v1/models',
    parse: parseWafer,
  },
  // opencode.ai: no pricing in /v1/models — skip for V1
];

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse a pricing value that may be a string ("0.435e-6"), number, or null. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** $/token → $/M tokens */
const perTokToPerM = (v) => { const n = num(v); return n === null ? null : n * 1e6; };
/** cents/M → $/M tokens */
const centsToDollars = (v) => { const n = num(v); return n === null ? null : n / 100; };
const passthrough = (v) => num(v);

// ── org extraction ────────────────────────────────────────────────────────────

/** Canonicalize an org prefix — normalize variants to a single key. */
const ORG_ALIASES = {
  'deepseek-ai': 'deepseek',
  'zai-org': 'z-ai',
  'minimaxai': 'minimax',
  'xiaomimimo': 'xiaomi',
  'meta-llama': 'meta',
  'mistralai': 'mistral',
  'nousresearch': 'nous',
  'moonshotai': 'moonshot',
  'ibm-granite': 'ibm',
  'bytedance-seed': 'bytedance',
  'stepfun-ai': 'stepfun',
};

/** Extract org from a model ID with a slash prefix. */
function orgFromId(id) {
  if (!id.includes('/')) return null;
  let org = id.split('/')[0].replace(/^[~]/, '').toLowerCase();
  return ORG_ALIASES[org] || org;
}

/** Extract org from model name when ID has no slash.
 *  Names like "DeepSeek: DeepSeek V4 Pro" → "deepseek" */
function orgFromName(name) {
  if (!name) return null;
  const match = name.match(/^(?:~)?([^:]+):/);
  if (!match) return null;
  let org = match[1].trim().toLowerCase();
  return ORG_ALIASES[org] || org;
}

/** Build canonical model ID for cross-referencing. */
function canonicalId(id) {
  let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
  k = k.replace(/:free$/, '').toLowerCase().trim();
  return k;
}

// ── provider parsers ──────────────────────────────────────────────────────────

function parseOpenRouter(data) {
  return (data.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: 'openrouter',
    context_length: m.context_length ?? null,
    pricing: {
      input: perTokToPerM(m.pricing?.prompt),
      output: perTokToPerM(m.pricing?.completion),
      cache_read: perTokToPerM(m.pricing?.input_cache_read),
      cache_write: perTokToPerM(m.pricing?.input_cache_write),
    },
  }));
}

function parseDeepInfra(data) {
  return (data.data || [])
    .filter((m) => m.metadata?.pricing && Object.keys(m.metadata.pricing).length > 0)
    .map((m) => ({
      id: m.id,
      name: m.id,
      provider: 'deepinfra',
      context_length: m.metadata?.context_length ?? null,
      pricing: {
        input: passthrough(m.metadata.pricing?.input_tokens),
        output: passthrough(m.metadata.pricing?.output_tokens),
        cache_read: passthrough(m.metadata.pricing?.cache_read_tokens),
        cache_write: passthrough(m.metadata.pricing?.cache_write_tokens),
      },
    }));
}

function parseCrof(data) {
  return (data.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: 'crof',
    context_length: m.context_length ?? null,
    pricing: {
      input: passthrough(m.pricing?.prompt),
      output: passthrough(m.pricing?.completion),
      cache_read: passthrough(m.pricing?.cache_prompt),
      cache_write: passthrough(m.pricing?.cache_write),
    },
  }));
}

function parseEmber(data) {
  return (data.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: 'ember',
    context_length: m.context_length ?? null,
    pricing: {
      input: perTokToPerM(m.pricing?.prompt),
      output: perTokToPerM(m.pricing?.completion),
      cache_read: perTokToPerM(m.pricing?.cache_read),
      cache_write: perTokToPerM(m.pricing?.cache_write),
    },
  }));
}

function parseWafer(data) {
  return (data.data || [])
    .filter((m) => m.wafer?.pricing)
    .map((m) => {
      const p = m.wafer.pricing;
      return {
        id: m.id,
        name: m.wafer?.display_name || m.id,
        provider: 'wafer',
        context_length: m.wafer?.context_length ?? m.max_model_len ?? null,
        pricing: {
          input: centsToDollars(p.input_cents_per_million),
          output: centsToDollars(p.output_cents_per_million),
          cache_read: centsToDollars(p.cache_read_cents_per_million),
          cache_write: centsToDollars(p.cache_write_cents_per_million),
        },
      };
    });
}

// ── main ───────────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  const out = { generated_at: new Date().toISOString(), providers: [], models: [] };

  for (const prov of PROVIDERS) {
    try {
      const data = await fetchJson(prov.url);
      const models = prov.parse(data).filter((m) =>
        !m.id.endsWith(':free') &&
        (m.pricing.input !== null || m.pricing.output !== null) &&
        (m.pricing.input ?? 0) >= 0 &&
        (m.pricing.output ?? 0) >= 0
      );
      out.providers.push({ key: prov.key, name: prov.name, model_count: models.length, status: 'ok' });
      out.models.push(...models);
      console.log(`✓ ${prov.name}: ${models.length} models`);
    } catch (err) {
      out.providers.push({ key: prov.key, name: prov.name, model_count: 0, status: `error: ${err.message}` });
      console.error(`✗ ${prov.name}: ${err.message}`);
    }
  }

  // Enrich models with org field (underlying model creator, not the API provider)
  // 1. Build canonical → org map from models with slash in ID
  const canonToOrg = {};
  for (const m of out.models) {
    const org = orgFromId(m.id);
    if (org) canonToOrg[canonicalId(m.id)] = org;
  }
  // 2. Assign org to each model: direct from ID, cross-ref, or from name
  let unresolved = 0;
  for (const m of out.models) {
    m.org = orgFromId(m.id) || canonToOrg[canonicalId(m.id)] || orgFromName(m.name);
    if (!m.org) { m.org = m.provider; unresolved++; }
  }
  if (unresolved) console.warn(`⚠ ${unresolved} models could not resolve org — using provider name as fallback`);
  await mkdir('public', { recursive: true });
  await writeFile('public/pricing.json', JSON.stringify(out, null, 2));
  console.log(`\n→ Wrote public/pricing.json (${out.models.length} models from ${out.providers.length} providers)`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
