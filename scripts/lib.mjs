/**
 * lib.mjs — shared utilities for TokenWatch pricing pipelines.
 * Used by fetch-pricing.mjs, fetch-images.mjs, fetch-videos.mjs.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Parse a pricing value that may be a string ("0.435e-6", "$0.0000014"), number, or null. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'string' ? v.replace(/[$,]/g, '').trim() : v;
  const n = typeof s === 'string' ? parseFloat(s) : s;
  return Number.isFinite(n) ? n : null;
}

/** $/token → $/M tokens */
export const perTokToPerM = (v) => { const n = num(v); return n === null ? null : n * 1e6; };
/** cents/M → $/M tokens */
export const centsToDollars = (v) => { const n = num(v); return n === null ? null : n / 100; };
export const passthrough = (v) => num(v);

// ── direct provider parsers ───────────────────────────────────────────────────

/** Sference https://api.sference.com/v1/models → model records (prices already $/M). */
export function parseSference(data) {
  return (data.data || [])
    .filter((m) => m.modality === 'text_generation')
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      provider: 'sference',
      quantization: null,
      discount: 0,
      context_length: m.context_tokens ?? null,
      pricing: {
        input: passthrough(m.pricing?.input_per_million_usd),
        output: passthrough(m.pricing?.output_per_million_usd),
        cache_read: passthrough(m.pricing?.cached_input_per_million_usd),
        cache_write: null,
      },
    }));
}
/** Neuralwatt https://api.neuralwatt.com/v1/models → model records (prices already $/M). */
export function parseNeuralwatt(data) {
  return (data.data || [])
    .filter((m) => !m.metadata?.deprecated)
    .map((m) => {
      const p = m.metadata?.pricing || {};
      return {
        id: m.id,
        name: m.metadata?.display_name || m.id,
        provider: 'neuralwatt',
        quantization: null,
        discount: 0,
        context_length: m.metadata?.limits?.max_context_length ?? null,
        pricing: {
          input: passthrough(p.input_per_million),
          output: passthrough(p.output_per_million),
          cache_read: passthrough(p.cached_input_per_million),
          cache_write: null,
        },
      };
    });
}

/** Merius https://api.merius.ai/v1/models → model records (prices $/token → $/M). */
export function parseMerius(data) {
  return (data.data || [])
    .filter((m) => {
      if (m.is_ready === false) return false;
      if (m.is_free === true) return false;
      const p = m.pricing?.[0] || {};
      const input = perTokToPerM(p.prompt);
      const output = perTokToPerM(p.completion);
      const cacheRead = perTokToPerM(p.input_cache_read);
      // Skip if both input and output are zero
      if (input === 0 && output === 0) return false;
      // Output modalities must be exactly ['text']
      if (!Array.isArray(m.output_modalities) || m.output_modalities.length !== 1 || m.output_modalities[0] !== 'text') return false;
      // Input modalities must include 'text' (allows text+image→text)
      if (!Array.isArray(m.input_modalities) || !m.input_modalities.includes('text')) return false;
      return true;
    })
    .map((m) => {
      const p = m.pricing?.[0] || {};
      return {
        id: m.id,
        name: m.name || m.id,
        provider: 'merius',
        quantization: null,
        discount: passthrough(m.discount_to_user) ?? 0,
        context_length: m.context_length ?? null,
        max_output_length: m.max_output_length ?? null,
        pricing: {
          input: perTokToPerM(p.prompt),
          output: perTokToPerM(p.completion),
          cache_read: perTokToPerM(p.input_cache_read),
          cache_write: null,
        },
      };
    });
}

const ASTER_ORG_BY_ID = new Map([
  ['gpt-oss-120b', 'openai'],
  ['gpt-oss-120b-fast', 'openai'],
  ['glm-5.2', 'z-ai'],
  ['kimi-k3', 'moonshot'],
]);

/** Aster Labs https://api.asterlab.ai/v1/models → text model records (prices already $/M). */
export function parseAster(data) {
  const models = Array.isArray(data?.data) ? data.data : [];
  return models.flatMap((m) => {
    if (!m || typeof m.id !== 'string' || !m.id || m.pricing?.per_search_usd != null) return [];
    const p = m.pricing || {};
    const input = passthrough(p.input_per_million_tokens_usd ?? p.input);
    const output = passthrough(p.output_per_million_tokens_usd ?? p.output);
    if (input === null && output === null) return [];
    return [{
      id: m.id,
      name: m.display_name || m.id,
      org: ASTER_ORG_BY_ID.get(m.id) || orgFromId(m.id) || null,
      provider: 'aster',
      quantization: null,
      discount: 0,
      context_length: m.context_length ?? null,
      pricing: {
        input,
        output,
        cache_read: passthrough(p.cached_input_per_million_tokens_usd),
        cache_write: null,
      },
    }];
  });
}

/** Infer model-creator org from a bare (unprefixed) catalog id. */
function orgFromBareModelId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.includes('/')) return orgFromId(id);
  const s = id.toLowerCase();
  if (s.startsWith('deepseek')) return 'deepseek';
  if (s.startsWith('gpt-') || s.startsWith('chatgpt') || s.startsWith('o1-') || s.startsWith('o3-') || s.startsWith('o4-')) return 'openai';
  if (s.startsWith('kimi')) return 'moonshot';
  if (s.startsWith('glm')) return 'z-ai';
  if (s.startsWith('qwen')) return 'qwen';
  if (s.startsWith('nemotron')) return 'nvidia';
  if (s.startsWith('ornith')) return 'ornith';
  if (s.startsWith('llama')) return 'meta';
  if (s.startsWith('claude')) return 'anthropic';
  if (s.startsWith('gemini')) return 'google';
  return null;
}

function singularityChatCapability(m) {
  const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
  return caps.find((c) => c?.endpoint === '/v1/chat/completions')
    || caps.find((c) => c?.endpoint === '/v1/responses')
    || null;
}

/** SingularityAPI https://api.singularityapi.dev/v1/models → text records (prices already $/M). */
export function parseSingularity(data) {
  const models = Array.isArray(data?.data) ? data.data : [];
  return models.flatMap((m) => {
    if (!m || typeof m.id !== 'string' || !m.id) return [];
    const cap = singularityChatCapability(m);
    if (!cap) return [];
    const p = cap.pricing || {};
    const input = passthrough(p.input_per_million_usd);
    const output = passthrough(p.output_per_million_usd);
    if (input === null && output === null) return [];
    return [{
      id: m.id,
      name: m.display_name || m.id,
      org: orgFromBareModelId(m.id),
      provider: 'singularity',
      quantization: null,
      discount: 0,
      context_length: cap.context_window_tokens ?? null,
      max_completion_tokens: cap.maximum_output_tokens ?? null,
      pricing: {
        input,
        output,
        cache_read: passthrough(p.cached_input_per_million_usd),
        cache_write: null,
      },
    }];
  });
}

/** RunInfra https://api.runinfra.ai/v1/models → text records (prices already $/M). */
export function parseRuninfra(data) {
  const models = Array.isArray(data?.data) ? data.data : [];
  return models.flatMap((m) => {
    if (!m || typeof m.id !== 'string' || !m.id) return [];
    if (m.availability === 'paused') return [];
    if (m.modality && m.modality !== 'llm') return [];
    const p = m.pricing || {};
    const input = passthrough(p.input);
    const output = passthrough(p.output);
    if (input === null && output === null) return [];
    return [{
      id: m.id,
      name: m.display_name || m.id,
      org: orgFromBareModelId(m.id),
      provider: 'runinfra',
      quantization: null,
      discount: 0,
      context_length: m.context_length ?? m.context_window ?? null,
      max_completion_tokens: m.max_output_tokens ?? null,
      pricing: {
        input,
        output,
        cache_read: passthrough(m.cached_input_price ?? m.cached_input_price_usd_per_mtok),
        cache_write: null,
      },
    }];
  });
}

// ── OpenCode Go (docs-page scraping) ──────────────────────────────────────────
// OpenCode Zen exposes the model catalog at /zen/go/v1/models but WITHOUT
// pricing. The $/M prices live only in the docs page's pricing table
// (https://opencode.ai/docs/go/#models: "Model | Input | Output | Cached Read |
// Cached Write | Usage"). parseOpenCodeGoDocs scrapes that table. Context
// lengths stay manual (OPENCODE_GO_CONTEXT in fetch-pricing.mjs) — the docs
// page doesn't publish them.

/**
 * Parse "$X" / "-" price cell text to a $/M number or null.
 * @param {string} raw cell text like "$2.00", "-", "—"
 * @returns {number|null}
 */
function parseOpenCodePriceCell(raw) {
  const s = (raw || '').trim();
  if (!s || s === '-' || s === '—' || s === '–') return null;
  const m = s.match(/\$\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Display name → catalog id. Lowercase + hyphenate; tiered variants:
 * "Qwen3.7 Plus (≤ 256K tokens)" → "qwen3.7-plus" (base, lower tier)
 * "Qwen3.7 Plus (> 256K tokens)" → "qwen3.7-plus-long" (higher tier, matches
 * the legacy hardcoded ids and the canonicalId quant-suffix convention).
 * @param {string} name e.g. "GPT 5.6 Luna (≤ 272K tokens)"
 * @returns {string|null} catalog id, or null when the name carries no variant
 *   info we can map (caller decides how to treat it)
 */
/** Providers already covered by TokenWatch direct fetch or OpenRouter de-aggregation.
 *  LLM Gateway rows for these slugs are skipped — we only want differential hosts. */
export const LLMGATEWAY_SKIP_PROVIDERS = new Set([
  'alibaba', 'amazon', 'anthropic', 'atlascloud', 'aws-bedrock', 'azure',
  'azure-ai-foundry', 'azure-anthropic', 'baidu', 'cerebras', 'deepinfra',
  'deepseek', 'ember', 'embercloud', 'fireworks', 'google', 'google-ai-studio',
  'google-vertex', 'groq', 'llmgateway', 'meta', 'minimax', 'mistral', 'moonshot',
  'nebius', 'novita', 'openai', 'perplexity', 'sakana', 'together', 'together-ai',
  'vertex-anthropic', 'vertex-openai', 'xai', 'xiaomi', 'z-ai', 'zai',
]);

/** Map LLM Gateway providerId → TokenWatch provider slug. */
export const LLMGATEWAY_PROVIDER_MAP = {
  'inference.net': 'inference-net',
};

function llmgatewayTextOutput(m) {
  const out = m?.architecture?.output_modalities;
  return Array.isArray(out) && out.length === 1 && out[0] === 'text';
}

/** LLM Gateway https://api.llmgateway.io/v1/models → differential text rows.
 *  Prices are $/token (scientific notation). Only providers not already in
 *  TokenWatch are emitted. Image/audio/video output SKUs are dropped. */
export function parseLlmgateway(data) {
  const models = Array.isArray(data?.data) ? data.data : [];
  const rows = [];
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    if (!llmgatewayTextOutput(m)) continue;
    const providers = Array.isArray(m.providers) ? m.providers : [];
    for (const p of providers) {
      const rawId = p?.providerId;
      if (!rawId) continue;
      const mapped = LLMGATEWAY_PROVIDER_MAP[rawId] || rawId;
      if (LLMGATEWAY_SKIP_PROVIDERS.has(rawId) || LLMGATEWAY_SKIP_PROVIDERS.has(mapped)) continue;
      const pricing = p.pricing || {};
      const input = perTokToPerM(pricing.prompt);
      const output = perTokToPerM(pricing.completion);
      if (input == null && output == null) continue;
      if ((input ?? 0) <= 0 && (output ?? 0) <= 0) continue;
      const cacheRead = perTokToPerM(pricing.input_cache_read);
      const cacheWrite = perTokToPerM(pricing.input_cache_write);
      rows.push({
        id: m.id,
        name: m.display_name || m.name || m.id,
        org: orgFromBareModelId(m.id),
        provider: mapped,
        quantization: null,
        discount: 0,
        context_length: m.context_length || null,
        max_completion_tokens: p.max_output ?? m.max_output ?? null,
        pricing: {
          input,
          output,
          cache_read: (cacheRead == null || cacheRead === 0) ? null : cacheRead,
          cache_write: (cacheWrite == null || cacheWrite === 0) ? null : cacheWrite,
        },
      });
    }
  }
  return rows;
}


export function openCodeGoIdFromName(name) {
  const raw = (name || '').trim();
  if (!raw) return null;
  const gt = raw.match(/\(>\s*[\d.]+K?\s*tokens?\)/i);
  const base = raw.replace(/\((≤|>)\s*[\d.]+K?\s*tokens?\)\s*$/i, '').trim();
  if (!base) return null;
  const id = base.toLowerCase().replace(/\s+/g, '-');
  return gt ? `${id}-long` : id;
}

/**
 * Scrape the OpenCode Go docs pricing table into price rows.
 * Pure function over the HTML string.
 * @param {string} html docs page HTML
 * @returns {Array<{id: string, name: string, input: number, output: number,
 *   cache_read: number|null, cache_write: number|null}>}
 */
export function parseOpenCodeGoDocs(html) {
  const rows = [];
  // Identify the pricing table by its header row (contains "Cached Read") —
  // the docs page has several other tables (request estimates etc.).
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const tableHtml = tables.find((tb) => /<th[\s\S]*?<\/th>/i.test(tb) && /Cached\s+Read/i.test(tb));
  if (!tableHtml) return rows;

  const tbody = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!tbody) return rows;

  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let m;
  while ((m = trRe.exec(tbody[0]))) {
    const cells = [...m[0].matchAll(/<td[\s\S]*?<\/td>/gi)].map(
      (tm) => tm[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    );
    if (cells.length < 4) continue;
    // Column layout: Model | Input | Output | Cached Read | Cached Write | Usage
    const name = cells[0];
    if (!name) continue;
    const id = openCodeGoIdFromName(name);
    if (!id) continue;
    const input = parseOpenCodePriceCell(cells[1]);
    const output = parseOpenCodePriceCell(cells[2]);
    // Zero/negative or missing prices → skip (data-filter convention)
    if (!input || !output) continue;
    rows.push({
      id,
      name: name.replace(/\((≤|>)\s*[\d.]+K?\s*tokens?\)\s*$/i, '').trim(),
      input,
      output,
      cache_read: parseOpenCodePriceCell(cells[3]),
      cache_write: parseOpenCodePriceCell(cells[4]),
    });
  }
  return rows;
}

/** Filter out non-text models by ID pattern. */
export const NON_TEXT_ID = /(?:^|[-/])(embed|embedding|embeddinggemma|clip|bge|tts|bark|parler|kokoro|openvoice)(?:[-/]|$)/i;
export function isTextModel(id) {
  return !NON_TEXT_ID.test(id);
}

// ── org extraction ────────────────────────────────────────────────────────────

/** Canonicalize an org prefix — normalize variants to a single key. */
export const ORG_ALIASES = {
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
  // Additional orgs for image/video providers
  'black-forest-labs': 'black-forest-labs',
  'kwaivgi': 'kling',
  'sourceful': 'sourceful',
  'recraft': 'recraft',
  'x-ai': 'xai',
  'alibaba': 'alibaba',
  'merius': 'merius',
};

/** Extract org from a model ID with a slash prefix. */
export function orgFromId(id) {
  if (!id.includes('/')) return null;
  let org = id.split('/')[0].replace(/^[~]/, '').toLowerCase();
  return ORG_ALIASES[org] || org;
}

/** Extract org from model name when ID has no slash.
 *  Names like "DeepSeek: DeepSeek V4 Pro" → "deepseek" */
export function orgFromName(name) {
  if (!name) return null;
  const match = name.match(/^(?:~)?([^:]+):/);
  if (!match) return null;
  let org = match[1].trim().toLowerCase();
  return ORG_ALIASES[org] || org;
}

// canonicalId and orgLookupKey live in shared/normalize.mjs so the Cloudflare
// Pages Function can import the same source of truth without pulling in
// node:fs (which this file imports below for checkCoverageDrop).
export { canonicalId, orgLookupKey, quantFromId } from '../shared/normalize.mjs';
import { canonicalId, orgLookupKey, quantFromId } from '../shared/normalize.mjs';

// models.dev reconciliation helpers live in shared/modelsdev.mjs (pure, no
// node: imports) so they could in principle be bundled into the Worker too.
// Re-exported here for fetch-modelsdev.mjs to consume.
export { PROVIDER_MAP, REVERSE_PROVIDER_MAP, normalizeForMatch, findEnrichment, applyEnrichment } from '../shared/modelsdev.mjs';

// Benchmark matching helpers live in shared/benchmarks.mjs (pure, no node:
// imports) — same purity contract as normalize.mjs and modelsdev.mjs so they
// could be bundled into the Worker. Re-exported here for fetch-pricing.mjs.
export { conservativeBase, buildBenchmarkIndex, applyBenchmarkEnrichment, applyAAEnrichment } from '../shared/benchmarks.mjs';

// ── provider-name normalization ───────────────────────────────────────────────

export const PROVIDER_NAME_MAP = {
  'deepinfra': 'deepinfra',
  'embercloud': 'ember',
  'wafer': 'wafer',
  'crof': 'crof',
  'synthetic': 'synthetic',
  'lilac': 'lilac',
  'xiaomimimo': 'xiaomi',
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
  'neuralwatt': 'neuralwatt',
  'aster': 'aster',
  'aster labs': 'aster',
  'singularity': 'singularity',
  'singularityapi': 'singularity',
  'singularity api': 'singularity',
  'runinfra': 'runinfra',
  'run infra': 'runinfra',
  'nanogpt': 'nanogpt',
  'runware': 'runware',
  'scx-ai': 'scx-ai',
  'scx-ai-gp': 'scx-ai-gp',
  'iceberg': 'iceberg',
  'glacier': 'glacier',
  'quartz': 'quartz',
  'canopywave': 'canopywave',
  'inference.net': 'inference-net',
  'inference-net': 'inference-net',
  'consensusprotocol': 'consensusprotocol',
  'gonka24': 'gonka24',
  'ranoai': 'ranoai',
  'granite': 'granite',
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
  // Image/video providers
  'black-forest-labs': 'black-forest-labs',
  'bytedance-seed': 'bytedance',
  'bytedance': 'bytedance',
  'kwaivgi': 'kling',
  'recraft': 'recraft',
  'sourceful': 'sourceful',
  'x-ai': 'xai',
  'microsoft': 'microsoft',
  'umans': 'umans',
  'umans ai': 'umans',
};

/** Normalize a provider display name to a lowercase key. */
export function normalizeProvider(displayName) {
  const key = displayName.toLowerCase().trim();
  return PROVIDER_NAME_MAP[key] || key.replace(/[\s.]/g, '-');
}

// ── dedup ─────────────────────────────────────────────────────────────────────

/** Build a dedup key: (canonical_model, normalized_provider). */
export function dedupKey(m) {
  return `${canonicalId(m.id)}|${normalizeProvider(m.provider)}`;
}

/** Apply precedence: first occurrence of a key wins (insertion order = authority). */
export function dedupModels(tieredModels) {
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

// ── write-if-changed ───────────────────────────────────────────────────────────

/**
 * Write a JSON artifact only when its content changed (excluding `generated_at`),
 * so a refresh that produced identical data leaves the file untouched. CI's
 * commit step (refresh-pricing.yml) then sees a quiet `git diff` → no commit →
 * no bust-cache/deploy on no-change cycles. Mirrors the skip-if-unchanged
 * pattern in fetch-performance.mjs. Returns true when written, false when skipped.
 */
export async function maybeWriteJson(outputPath, out) {
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const prev = JSON.parse(await readFile(outputPath, 'utf8'));
    const { generated_at: _prevGeneratedAt, ...prevRest } = prev;
    const { generated_at: _nextGeneratedAt, ...nextRest } = out;
    const prevStr = JSON.stringify(prevRest);
    if (JSON.stringify(nextRest) === prevStr) {
      console.log(`\n→ No changes to ${outputPath} — skipping write`);
      console.log('  (CI commit step will detect no diff and skip deploy)');
      return false;
    }
  } catch {
    // No existing file or invalid JSON — treat as new data
  }
  await writeFile(outputPath, JSON.stringify(out, null, 2));
  return true;
}

// ── fal.ai helpers ──
// fal's endpoint IDs are deeply nested (e.g. 'fal-ai/kling-video/v3/pro/image-to-video')
// and carry model identity in every path segment. The shared canonicalId (built for
// text models) keeps only the last segment, which would collapse all kling variants
// to 'image-to-video'. falCanonicalId preserves the model+version+tier and drops
// only pure modality suffixes (image-to-video, text-to-video, edit, upscale, etc.).

const FAL_MODALITY_SUFFIXES = ['image-to-video', 'text-to-video', 'reference-to-video', 'video-to-video', 'audio-to-video', 'edit', 'upscale', 'image', 'video'];

/**
 * Compute a canonical ID for a fal.ai endpoint, preserving model identity.
 *
 * Strips the 'fal-ai/' namespace prefix (but keeps other org prefixes like
 * 'bytedance/', 'openai/', 'xai/'). Drops trailing pure-modality segments.
 * Joins remaining segments with '-'.
 *
 * Examples:
 *   'fal-ai/kling-video/v3/pro/image-to-video' → 'kling-video-v3-pro'
 *   'fal-ai/flux-pro/v1.1-ultra'               → 'flux-pro-v1.1-ultra'
 *   'bytedance/seedance-2.0/image-to-video'    → 'bytedance-seedance-2.0'
 *   'fal-ai/nano-banana-pro/edit'              → 'nano-banana-pro'
 *   'fal-ai/wan/v2.2-a14b/image-to-video/turbo'→ 'wan-v2.2-a14b-turbo' (turbo kept)
 */
export function falCanonicalId(endpointId) {
  let id = endpointId;
  // Strip 'fal-ai/' namespace prefix only (keep bytedance/, openai/, xai/, etc.)
  if (id.startsWith('fal-ai/')) id = id.slice('fal-ai/'.length);
  // Drop pure-modality segments ANYWHERE in the path — they're routing artifacts
  // (image-to-video, text-to-video, edit, upscale, etc.), not model identity.
  // This handles both trailing ('.../image-to-video') and mid-path
  // ('.../image-to-video/turbo') cases uniformly.
  const segments = id.split('/').filter(s => !FAL_MODALITY_SUFFIXES.includes(s));
  return segments.join('-').toLowerCase();
}

/**
 * Map from fal model family (first segment after fal-ai/) to the real model org.
 * Built from the top ~20 families by endpoint count. Long-tail families fall back
 * to 'fal' as org (set in fetch-fal.mjs).
 */
export const FAL_ORG_MAP = {
  'flux': 'black-forest-labs',
  'flux-pro': 'black-forest-labs',
  'flux-2': 'black-forest-labs',
  'kling-video': 'kuaishou',
  'kling': 'kuaishou',
  'nano-banana': 'google',
  'nano-banana-2': 'google',
  'nano-banana-pro': 'google',
  'ideogram': 'ideogram',
  'pixverse': 'pixsocial',
  'minimax': 'minimax',
  'wan': 'alibaba',
  'wan-i2v': 'alibaba',
  'wan-t2v': 'alibaba',
  'ltx-video': 'lightricks',
  'ltxv': 'lightricks',
  'ltx': 'lightricks',
  'seedance': 'bytedance',
  'veo': 'google',
  'veo3': 'google',
  'veo3.1': 'google',
  'gemini': 'google',
  'recraft': 'recraft',
  'vidu': 'shengshu',
  'pika': 'pika',
  'hunyuan-video': 'tencent',
  'qwen': 'alibaba',
  'bytedance': 'bytedance',
  'luma': 'luma-labs',
  'longcat': 'anthropic',
  'z': 'z-ai',
  'hidream': 'samsung',
  'chrono': 'chrono',
  'heygen': 'heygen',
  'topaz': 'topaz-labs',
  'krea': 'krea',
  'bria': 'bria-ai',
  'fashn': 'fashn',
  'meshy': 'meshy',
  'hyper3d': 'deepmotion',
  'hunyuan3d': 'tencent',
};

// ── HTTP ──────────────────────────────────────────────────────────────────────

/** Fetch JSON with no retry (for simple endpoints). */
export async function fetchJson(url, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Fetch JSON with retry on 429/5xx. */
export async function fetchJsonWithRetry(url, retries = 1, delayMs = 2000, opts = {}) {
  const baseHeaders = { Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.apiKey) baseHeaders.Authorization = `Bearer ${opts.apiKey}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: baseHeaders,
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (attempt < retries && err.name !== 'AbortError') {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

// ── resilience ────────────────────────────────────────────────────────────────

/**
 * Thrown by checkCoverageDrop when model count drops beyond the threshold.
 * Image/video pipelines catch this to exit 0 (preserving last-good data)
 * without sending GitHub Actions failure emails. Text pricing (fetch-pricing.mjs)
 * keeps it fatal — a text-model coverage drop signals a serious upstream issue.
 */
export class CoverageDropError extends Error {
  constructor(message, { currentCount, prevCount, threshold }) {
    super(message);
    this.name = 'CoverageDropError';
    this.currentCount = currentCount;
    this.prevCount = prevCount;
    this.threshold = threshold;
  }
}

/**
 * Check coverage drop vs previous JSON file. Throws CoverageDropError if drop
 * exceeds threshold. Returns previous model count (null if no previous file).
 */
export async function checkCoverageDrop(outputPath, currentCount, threshold = 0.15) {
  let prevCount = null;
  try {
    const prev = JSON.parse(await readFile(outputPath, 'utf-8'));
    prevCount = prev.models?.length || 0;
    const drop = prevCount > 0 ? (prevCount - currentCount) / prevCount : 0;
    if (prevCount > 0 && drop > threshold) {
      throw new CoverageDropError(
        `Coverage drop: ${currentCount} models vs previous ${prevCount} ` +
        `(${(drop * 100).toFixed(1)}% drop) exceeds ${(threshold * 100).toFixed(0)}% threshold — aborting to preserve last-good data`,
        { currentCount, prevCount, threshold }
      );
    }
    console.log(`  Previous: ${prevCount} models | Current: ${currentCount} models`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No previous file — first run, proceed
    } else {
      throw err; // re-throw CoverageDropError or read errors
    }
  }
  return prevCount;
}

/**
 * Parse --dry-run flag from process.argv.
 * Also supports --help / -h for usage info.
 */
export function parseArgs(usage) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage);
    return { dryRun: false, help: true };
  }
  return { dryRun: process.argv.includes('--dry-run'), help: false };
}
