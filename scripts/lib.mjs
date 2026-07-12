/**
 * lib.mjs — shared utilities for TokenWatch pricing pipelines.
 * Used by fetch-pricing.mjs, fetch-images.mjs, fetch-videos.mjs.
 */

import { readFile } from 'node:fs/promises';

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
export { canonicalId, orgLookupKey } from '../shared/normalize.mjs';
import { canonicalId, orgLookupKey } from '../shared/normalize.mjs';

// models.dev reconciliation helpers live in shared/modelsdev.mjs (pure, no
// node: imports) so they could in principle be bundled into the Worker too.
// Re-exported here for fetch-modelsdev.mjs to consume.
export { PROVIDER_MAP, normalizeForMatch, findEnrichment, applyEnrichment } from '../shared/modelsdev.mjs';

// Benchmark matching helpers live in shared/benchmarks.mjs (pure, no node:
// imports) — same purity contract as normalize.mjs and modelsdev.mjs so they
// could be bundled into the Worker. Re-exported here for fetch-pricing.mjs.
export { conservativeBase, buildBenchmarkIndex, applyBenchmarkEnrichment } from '../shared/benchmarks.mjs';

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
  const headers = { Accept: 'application/json' };
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
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = { Accept: 'application/json' };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
      const res = await fetch(url, {
        headers,
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
