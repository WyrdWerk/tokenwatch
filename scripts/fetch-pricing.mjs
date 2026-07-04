#!/usr/bin/env node
/**
 * fetch-pricing.mjs
 *
 * Fetches pricing from direct providers + OpenRouter (de-aggregated per backend
 * inference provider), normalizes to $/M tokens, and writes public/pricing.json.
 *
 * Tier 1 — Direct providers: DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac
 *          (authoritative source for their own offerings)
 * Tier 2 — OpenRouter /endpoints: de-aggregated per-backend pricing
 *          (each backend like Fireworks, Together, Novita becomes its own row)
 * Tier 3 — CSV-sourced: Hyper, Makora, Xiaomimimo (manual-pricing.csv)
 *          OpenCode Go (hardcoded)
 *
 * Precedence: (canonical_model, normalized_provider) — direct wins over
 * OpenRouter, which wins over CSV/hardcoded. Quantization is NOT part of
 * the dedup key — same model+provider at different quants collapses to
 * one row (first-seen / highest-tier wins).
 *
 * Model record:
 * {
 *   id:          "provider/model"        (display ID)
 *   name:        string
 *   org:         "anthropic" | "openai" | "deepseek" | ...  (model creator)
 *   provider:    "deepinfra" | "fireworks" | "together" | ...  (inference provider)
 *   quantization: "fp8" | "fp4" | "unknown" | null
 *   discount:    number  (0 = structural, >0 = promo fraction, e.g. 0.7 = 70% off)
 *   context_length: number | null
 *   pricing: { input, output, cache_read, cache_write }  ($/M tokens)
 * }
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';

// ── direct providers config ───────────────────────────────────────────────────

const DIRECT_PROVIDERS = [
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
    name: 'Wafer',
    url: 'https://pass.wafer.ai/v1/models',
    parse: parseWafer,
  },
  {
    key: 'synthetic',
    name: 'Synthetic',
    url: 'https://api.synthetic.new/v1/models',
    parse: parseSynthetic,
  },
  {
    key: 'lilac',
    name: 'Lilac',
    url: 'https://api.getlilac.com/v1/models',
    parse: parseLilac,
  },
];

// ── OpenRouter config ──────────────────────────────────────────────────────────

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_ENDPOINT_BASE = 'https://openrouter.ai/api/v1/models';
const OR_CONCURRENCY = 20;
const OR_MAX_RETRIES = 1;
const OR_RETRY_DELAY_MS = 2000;

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse a pricing value that may be a string ("0.435e-6", "$0.0000014"), number, or null. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'string' ? v.replace(/[$,]/g, '').trim() : v;
  const n = typeof s === 'string' ? parseFloat(s) : s;
  return Number.isFinite(n) ? n : null;
}

/** $/token → $/M tokens */
const perTokToPerM = (v) => { const n = num(v); return n === null ? null : n * 1e6; };
/** cents/M → $/M tokens */
const centsToDollars = (v) => { const n = num(v); return n === null ? null : n / 100; };
const passthrough = (v) => num(v);
/** Filter out non-text models by ID pattern.
 *  Applied ONLY to direct providers (which lack modality metadata).
 *  OpenRouter rows are filtered via architecture.output_modalities instead. */
const NON_TEXT_ID = /(?:^|[-/])(embed|embedding|embeddinggemma|clip|bge|tts|bark|parler|kokoro|openvoice)(?:[-/]|$)/i;
function isTextModel(id) {
  return !NON_TEXT_ID.test(id);
}

// ── org extraction ────────────────────────────────────────────────────────────

/** Canonicalize an org prefix — normalize variants to a single key. */
const ORG_ALIASES = {
  'deepseek-ai': 'deepseek',
  'zai-org': 'z-ai',
  'meta-llama': 'meta',
  'mistralai': 'mistral',
  'nousresearch': 'nous',
  'moonshotai': 'moonshot',
  'ibm-granite': 'ibm',
  'bytedance-seed': 'bytedance',
  'stepfun-ai': 'stepfun',
  'minimaxai': 'minimax',
  'xiaomimimo': 'xiaomi',
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

/** Build canonical model ID for cross-referencing and dedup.
 *  Strips provider prefix, suffixes (:free, dates, -preview, :thinking), lowercases.
 *  Turbo variants kept separate (different SKUs).
 *  Quantization suffixes baked into the ID (e.g. glm-5.2-fp8) are left as-is —
 *  they are distinct model entries, not collapsed. */
function canonicalId(id) {
  let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
  k = k.replace(/:free$/, '')
       .replace(/:thinking$/, '')
       .replace(/-(\d{4})-\d{2}-\d{2}$/, '')
       .replace(/-preview-\d{2}-\d{2}$/, '')
       .replace(/-preview$/, '')
       .toLowerCase().trim();
  return k;
}

/** Build a key for org cross-referencing.
 *  Like canonicalId but also strips quantization and tier suffixes.
 *  Used ONLY for org resolution — not for dedup or model display. */
function orgLookupKey(id) {
  return canonicalId(id)
    .replace(/-(fp8|nvfp4|int4-mixed-ar|int4|bf16|fp16|fp6|mxfp4)$/, '')
    .replace(/-long$/, '');
}

// ── provider-name normalization ───────────────────────────────────────────────

/** Normalize provider names across sources to a single key.
 *  Direct providers use lowercase keys (ember, deepinfra, wafer).
 *  OpenRouter uses display names (EmberCloud, DeepInfra, Wafer).
 *  This map reconciles them for dedup precedence. */
const PROVIDER_NAME_MAP = {
  // OpenRouter display name → normalized key (matching direct provider keys)
  'deepinfra': 'deepinfra',
  'embercloud': 'ember',
  'wafer': 'wafer',
  'crof': 'crof',
  'synthetic': 'synthetic',
  'lilac': 'lilac',
  // Infra providers without direct fetch — keep OpenRouter display name lowercased
  'fireworks': 'fireworks',
  'together': 'together',
  'novita': 'novita',
  'siliconflow': 'siliconflow',
  'gmicloud': 'gmicloud',
  'digitalocean': 'digitalocean',
  'parasail': 'parasail',
  'akashml': 'akashml',
  'venice': 'venice',
  'morph': 'morph',
  'dekallm': 'dekallm',
  'cohere': 'cohere',
  'groq': 'groq',
  'nebius': 'nebius',
  'sambanova': 'sambanova',
  'streamlake': 'streamlake',
  'atlascloud': 'atlascloud',
  'baidu': 'baidu',
  'alibaba': 'alibaba',
  'minimax': 'minimax',
  'mistral': 'mistral',
  'anthropic': 'anthropic',
  'openai': 'openai',
  'azure': 'azure',
  'google': 'google',
  'google ai studio': 'google',
  'amazon bedrock': 'amazon',
  'z.ai': 'z-ai',
  'xai': 'xai',
  'deepseek': 'deepseek',
  'moonshot ai': 'moonshot',
  'sakana ai': 'sakana',
  'arcee ai': 'arcee',
  'inception': 'inception',
  'infermatic': 'infermatic',
  'mara': 'mara',
  'nextbit': 'nextbit',
  'nex agi': 'nex-agi',
  'poolside': 'poolside',
  'phala': 'phala',
  'friendli': 'friendli',
  'chutes': 'chutes',
  'wandb': 'wandb',
};

/** Normalize a provider display name to a lowercase key. */
function normalizeProvider(displayName) {
  const key = displayName.toLowerCase().trim();
  return PROVIDER_NAME_MAP[key] || key.replace(/[\s.]/g, '-');
}

// ── direct provider parsers ───────────────────────────────────────────────────

function parseDeepInfra(data) {
  return (data.data || [])
    .filter((m) => {
      if (!m.metadata?.pricing || Object.keys(m.metadata.pricing).length === 0) return false;
      // Exclude non-text models via structured tags (more maintainable than regex)
      const tags = m.metadata?.tags || [];
      const NON_TEXT_TAGS = ['image-gen', 'tts', 'stt', 'automatic-speech-recognition', 'embed', 'embeddings', 'video-gen', 'audio'];
      if (tags.some(t => NON_TEXT_TAGS.includes(t))) return false;
      return true;
    })
    .map((m) => ({
      id: m.id,
      name: m.id,
      provider: 'deepinfra',
      quantization: null,
      discount: 0,
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
    quantization: null,
    discount: 0,
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
    quantization: null,
    discount: 0,
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
        quantization: null,
        discount: 0,
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

function parseSynthetic(data) {
  return (data.data || []).map((m) => {
    const inputPerM = perTokToPerM(m.pricing?.prompt);
    const cacheRead = inputPerM !== null ? inputPerM * 0.20 : null;
    const org = m.hugging_face_id ? orgFromId(m.hugging_face_id) : null;
    return {
      id: m.id,
      name: m.name || m.id,
      provider: 'synthetic',
      quantization: null,
      discount: 0,
      context_length: m.context_length ?? null,
      org,
      pricing: {
        input: inputPerM,
        output: perTokToPerM(m.pricing?.completion),
        cache_read: cacheRead,
        cache_write: null,
      },
    };
  });
}

function parseLilac(data) {
  return (data.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: 'lilac',
    quantization: null,
    discount: 0,
    context_length: m.context_length ?? null,
    pricing: {
      input: perTokToPerM(m.pricing?.prompt),
      output: perTokToPerM(m.pricing?.completion),
      cache_read: perTokToPerM(m.pricing?.input_cache_read),
      cache_write: null,
    },
  }));
}

// ── OpenRouter de-aggregation ─────────────────────────────────────────────────

/** Fetch JSON with retry on 429/5xx. */
async function fetchJsonWithRetry(url, retries = OR_MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, OR_RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (attempt < retries && err.name !== 'AbortError') {
        await new Promise((r) => setTimeout(r, OR_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}

/** Fetch /endpoints for a single model, return per-backend rows. */
async function fetchModelEndpoints(model) {
  const slug = model.canonical_slug;
  if (!slug) return [];
  // CRITICAL: do NOT encode the slug — the / is a literal path separator
  const url = `${OPENROUTER_ENDPOINT_BASE}/${slug}/endpoints`;
  const data = await fetchJsonWithRetry(url);
  const endpoints = data.data?.endpoints || [];
  const modelId = data.data?.model_id || model.id;
  const modelName = data.data?.model_name || model.name || model.id;

  return endpoints.map((ep) => ({
    id: modelId,
    name: modelName,
    provider: normalizeProvider(ep.provider_name),
    provider_display: ep.provider_name,
    quantization: ep.quantization || null,
    discount: ep.pricing?.discount || 0,
    context_length: ep.context_length ?? model.context_length ?? null,
    pricing: {
      input: perTokToPerM(ep.pricing?.prompt),
      output: perTokToPerM(ep.pricing?.completion),
      cache_read: perTokToPerM(ep.pricing?.input_cache_read),
      cache_write: null,
    },
  }));
}

/** De-aggregate OpenRouter: fetch /v1/models, then /endpoints per model. */
async function fetchOpenRouter() {
  const data = await fetchJsonWithRetry(OPENROUTER_MODELS_URL);
  const allModels = data.data || [];

  // Filter: non-:free, priced, text-output only
  const textModels = allModels.filter((m) => {
    if (m.id.endsWith(':free')) return false;
    if (!m.pricing?.prompt || parseFloat(m.pricing.prompt) <= 0) return false;
    // Text-output only: output_modalities must be exactly ["text"]
    // (allows multimodal input like text+image->text, excludes image/audio/video output)
    const outputMods = m.architecture?.output_modalities;
    if (!outputMods || !Array.isArray(outputMods)) return true; // assume text if missing
    return outputMods.length === 1 && outputMods[0] === 'text';
  });

  console.log(`  OpenRouter: ${allModels.length} total → ${textModels.length} text-output priced models`);

  // Fetch /endpoints concurrently with bounded pool
  const results = [];
  let failed = 0;
  for (let i = 0; i < textModels.length; i += OR_CONCURRENCY) {
    const batch = textModels.slice(i, i + OR_CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map((m) => fetchModelEndpoints(m)));
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === 'fulfilled') {
        results.push(...r.value);
      } else {
        failed++;
        if (failed <= 5) console.error(`    ✗ ${batch[j].id}: ${r.reason?.message || r.reason}`);
      }
    }
    if (i % (OR_CONCURRENCY * 5) === 0 && i > 0) {
      console.log(`    ... ${i + batch.length}/${textModels.length} models fetched`);
    }
  }

  const failureRate = textModels.length > 0 ? failed / textModels.length : 0;
  if (failureRate > 0.20) {
    throw new Error(`OpenRouter endpoints failure rate ${(failureRate * 100).toFixed(1)}% (${failed}/${textModels.length}) exceeds 20% threshold — aborting`);
  }

  // Filter: drop zero-price rows (both input and output null/0)
  const priced = results.filter((m) =>
    (m.pricing.input !== null || m.pricing.output !== null) &&
    (m.pricing.input ?? 0) >= 0 &&
    (m.pricing.output ?? 0) >= 0 &&
    ((m.pricing.input ?? 0) > 0 || (m.pricing.output ?? 0) > 0)
  );

  console.log(`  OpenRouter: ${priced.length} backend rows from ${textModels.length - failed}/${textModels.length} models (${failed} failed)`);
  return { models: priced, modelCount: textModels.length, failed };
}

// ── CSV-sourced providers (Hyper, Makora, Xiaomimimo) ───────────────────────────

const CSV_PROVIDER_SECTIONS = {
  'https://hyper.charm.land/v1': 'hyper',
  'https://inference.makora.com/v1': 'makora',
  'https://api.xiaomimimo.com/v1': 'xiaomimimo',
};

const CSV_PROVIDER_NAMES = {
  hyper: 'Hyper',
  makora: 'Makora',
  xiaomimimo: 'Xiaomimimo',
};

function parseCsvProviders(csvText) {
  const lines = csvText.split('\n');
  const providers = [];
  let currentProvider = null;

  for (const line of lines) {
    const col0 = (line.split(',')[0] || '').trim();

    if (col0.startsWith('https://')) {
      const normalized = col0.replace(/\/+$/, '').replace('/chat/completions', '');
      currentProvider = CSV_PROVIDER_SECTIONS[normalized] || null;
      if (currentProvider) {
        providers.push({ key: currentProvider, name: CSV_PROVIDER_NAMES[currentProvider], models: [] });
      } else {
        currentProvider = null;
      }
      continue;
    }

    if (currentProvider && providers.length > 0) {
      const parts = line.split(',');
      const name = (parts[0] || '').trim();
      if (name && !name.startsWith('http')) {
        try {
          const input = parts[1] ? parseFloat(parts[1]) : null;
          const output = parts[2] ? parseFloat(parts[2]) : null;
          const cacheRead = parts[3] ? parseFloat(parts[3]) : null;
          if (input !== null || output !== null) {
            providers[providers.length - 1].models.push({
              id: name.toLowerCase().replace(/\s+/g, '-'),
              name,
              provider: currentProvider,
              quantization: null,
              discount: 0,
              context_length: null,
              pricing: { input, output, cache_read: cacheRead, cache_write: null },
            });
          }
        } catch { /* skip malformed lines */ }
      }
    }
  }

  return providers;
}

// ── OpenCode Go (hardcoded pricing) ───────────────────────────────────────────

const OPENCODE_GO_MODELS = [
  { id: 'glm-5.2', name: 'GLM-5.2', input: 1.40, output: 4.40, cache_read: 0.26 },
  { id: 'glm-5.1', name: 'GLM-5.1', input: 1.40, output: 4.40, cache_read: 0.26 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', input: 0.95, output: 4.00, cache_read: 0.19 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', input: 0.95, output: 4.00, cache_read: 0.16 },
  { id: 'mimo-v2.5', name: 'MiMo V2.5', input: 0.14, output: 0.28, cache_read: 0.0028 },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', input: 1.74, output: 3.48, cache_read: 0.0145 },
  { id: 'minimax-m3', name: 'MiniMax M3', input: 0.30, output: 1.20, cache_read: 0.06 },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', input: 0.30, output: 1.20, cache_read: 0.06 },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', input: 0.30, output: 1.20, cache_read: 0.06 },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', input: 2.50, output: 7.50, cache_read: 0.50 },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus (≤256K)', input: 0.40, output: 1.60, cache_read: 0.04 },
  { id: 'qwen3.7-plus-long', name: 'Qwen3.7 Plus (>256K)', input: 1.20, output: 4.80, cache_read: 0.12 },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus (≤256K)', input: 0.50, output: 3.00, cache_read: 0.05 },
  { id: 'qwen3.6-plus-long', name: 'Qwen3.6 Plus (>256K)', input: 2.00, output: 6.00, cache_read: 0.20 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', input: 1.74, output: 3.48, cache_read: 0.0145 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', input: 0.14, output: 0.28, cache_read: 0.0028 },
];

function parseOpenCodeGo() {
  return OPENCODE_GO_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    provider: 'opencode',
    quantization: null,
    discount: 0,
    context_length: null,
    pricing: { input: m.input, output: m.output, cache_read: m.cache_read, cache_write: null },
  }));
}

// ── dedup / precedence ────────────────────────────────────────────────────────

/** Build a dedup key: (canonical_model, normalized_provider).
 *  Quantization is NOT part of the key — the same model from the same
 *  inference provider at different quantizations collapses to one row
 *  (the first-seen / highest-tier row wins). */
function dedupKey(m) {
  return `${canonicalId(m.id)}|${normalizeProvider(m.provider)}`;
}

/** Apply 3-tier precedence: direct > OpenRouter > CSV/hardcoded.
 *  Models are inserted in tier order, so the first occurrence of a key
 *  is from the highest-authority tier. Later duplicates are dropped. */
function dedupModels(tieredModels) {
  const seen = new Set();
  const result = [];
  for (const m of tieredModels) {
    const key = dedupKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(m);
  }
  return result;
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
  const tieredModels = []; // collected in tier order for dedup

  // ── Tier 1: Direct providers ──
  for (const prov of DIRECT_PROVIDERS) {
    try {
      const data = await fetchJson(prov.url);
      const models = prov.parse(data).filter((m) =>
        !m.id.endsWith(':free') &&
        isTextModel(m.id) &&
        (m.pricing.input !== null || m.pricing.output !== null) &&
        (m.pricing.input ?? 0) >= 0 &&
        (m.pricing.output ?? 0) >= 0 &&
        ((m.pricing.input ?? 0) > 0 || (m.pricing.output ?? 0) > 0)
      );
      out.providers.push({ key: prov.key, name: prov.name, model_count: models.length, status: 'ok' });
      tieredModels.push(...models);
      console.log(`✓ ${prov.name}: ${models.length} models`);
    } catch (err) {
      out.providers.push({ key: prov.key, name: prov.name, model_count: 0, status: `error: ${err.message}` });
      console.error(`✗ ${prov.name}: ${err.message}`);
    }
  }

  // ── Tier 2: OpenRouter de-aggregated ──
  try {
    const or = await fetchOpenRouter();
    out.providers.push({ key: 'openrouter', name: 'OpenRouter (de-aggregated)', model_count: or.models.length, status: 'ok' });
    tieredModels.push(...or.models);
    console.log(`✓ OpenRouter: ${or.models.length} backend rows`);
  } catch (err) {
    out.providers.push({ key: 'openrouter', name: 'OpenRouter (de-aggregated)', model_count: 0, status: `error: ${err.message}` });
    console.error(`✗ OpenRouter: ${err.message}`);
  }

  // ── Tier 3: CSV + OpenCode Go ──
  try {
    const csvText = await readFile('data/manual-pricing.csv', 'utf-8');
    const csvProviders = parseCsvProviders(csvText);
    for (const prov of csvProviders) {
      out.providers.push({ key: prov.key, name: prov.name, model_count: prov.models.length, status: 'ok' });
      tieredModels.push(...prov.models);
      console.log(`✓ ${prov.name} (CSV): ${prov.models.length} models`);
    }
  } catch (err) {
    console.error(`✗ CSV providers: ${err.message}`);
  }

  try {
    const ocModels = parseOpenCodeGo();
    out.providers.push({ key: 'opencode', name: 'OpenCode Go', model_count: ocModels.length, status: 'ok' });
    tieredModels.push(...ocModels);
    console.log(`✓ OpenCode Go: ${ocModels.length} models`);
  } catch (err) {
    out.providers.push({ key: 'opencode', name: 'OpenCode Go', model_count: 0, status: `error: ${err.message}` });
    console.error(`✗ OpenCode Go: ${err.message}`);
  }

  // ── Dedup with 3-tier precedence ──
  out.models = dedupModels(tieredModels);
  const deduped = tieredModels.length - out.models.length;
  if (deduped > 0) console.log(`  Deduped ${deduped} overlapping rows (direct > OpenRouter > CSV)`);

  // ── Coverage-drop check: compare against last pricing.json ──
  try {
    const prev = JSON.parse(await readFile('public/pricing.json', 'utf-8'));
    const prevCount = prev.models?.length || 0;
    const drop = prevCount > 0 ? (prevCount - out.models.length) / prevCount : 0;
    if (prevCount > 0 && drop > 0.15) {
      throw new Error(`Coverage drop: ${out.models.length} models vs previous ${prevCount} (${(drop * 100).toFixed(1)}% drop) exceeds 15% threshold — aborting to preserve last-good data`);
    }
    console.log(`  Previous: ${prevCount} models | Current: ${out.models.length} models`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No previous file — first run, proceed
    } else {
      throw err; // re-throw coverage-drop or read errors
    }
  }

  // ── Org enrichment ──
  const canonToOrg = {};
  for (const m of out.models) {
    const org = m.org || orgFromId(m.id);
    if (org) {
      canonToOrg[canonicalId(m.id)] = org;
      canonToOrg[orgLookupKey(m.id)] = org;
    }
  }
  let unresolved = 0;
  for (const m of out.models) {
    m.org = m.org || orgFromId(m.id) || canonToOrg[orgLookupKey(m.id)] || canonToOrg[canonicalId(m.id)] || orgFromName(m.name);
    if (!m.org) { m.org = m.provider; unresolved++; }
  }
  if (unresolved) console.warn(`⚠ ${unresolved} models could not resolve org — using provider name as fallback`);

  await mkdir('public', { recursive: true });
  await writeFile('public/pricing.json', JSON.stringify(out, null, 2));
  console.log(`\n→ Wrote public/pricing.json (${out.models.length} models from ${out.providers.length} providers)`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
