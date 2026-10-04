/**
 * shared/benchmarks.mjs — pure matching helpers for benchmark enrichment
 * (Artificial Analysis, Design Arena, and Arena preference scores).
 *
 * This module MUST NOT import any node: builtins (same constraint as
 * shared/normalize.mjs and shared/modelsdev.mjs). It is pure string-transform
 * and array logic.
 *
 * Imported by:
 *   - scripts/lib.mjs (re-exports the public surface)
 *   - scripts/fetch-pricing.mjs (applies enrichment post-dedup)
 *   - test/benchmarks.test.mjs (unit tests)
 */

import { canonicalId, modelSpellingKey } from './normalize.mjs';

// Trailing quantization suffixes (MUST be last token to strip).
// Sourced from AGENTS.md canonical-model-ID convention.
const QUANT_SUFFIXES = ['fp8', 'fp16', 'bf16', 'int8', 'int4', 'nvfp4', 'awq', 'gptq', 'mxfp4', 'f16'];

// Trailing SKU performance suffixes (MUST be last token to strip).
const SKU_SUFFIXES = ['turbo', 'fast', 'highspeed'];

// Trailing SKU variant suffixes — same base model, different default behavior.
// -instruct / -thinking / -chat / -base / -reasoning variants share the base
// model's underlying capability, so they inherit the base model's benchmark.
// Stripped as a second-tier fallback (only when conservativeBase misses AND
// the stripped key exists in the index — zero misattribution risk).
const VARIANT_SUFFIXES = ['instruct', 'thinking', 'base', 'chat', 'reasoning'];

/**
 * Compute the conservative base-model key for matching.
 *
 * Strips ONLY trailing quant suffixes (-fp8, -nvfp4, ...) and SKU suffixes
 * (-turbo, -fast, -highspeed). Does NOT strip size tokens (-70b, -480b-a35b)
 * or version bits (-4-6) — those create false matches (e.g. Qwen3-30B-A3B
 * must NOT collapse to qwen3).
 *
 * Example: 'z-ai/glm-5.2-fp8' → 'glm-5.2'
 *          'anthropic/claude-sonnet-5-turbo' → 'claude-sonnet-5'
 *          'qwen/qwen3-30b-a3b' → 'qwen3-30b-a3b' (unchanged — no trailing quant/SKU)
 */
export function conservativeBase(modelId) {
  let c = canonicalId(modelId);
  // Strip one trailing quant suffix if present (only the LAST token)
  for (const suffix of QUANT_SUFFIXES) {
    const re = new RegExp('-' + suffix + '$');
    if (re.test(c)) {
      c = c.replace(re, '');
      break; // only strip one
    }
  }
  // Strip one trailing SKU suffix if present
  for (const suffix of SKU_SUFFIXES) {
    const re = new RegExp('-' + suffix + '$');
    if (re.test(c)) {
      c = c.replace(re, '');
      break;
    }
  }
  return c;
}

/**
 * The full base-key normalization: conservativeBase + variant-suffix strip.
 * Applied identically on BOTH sides (OR index build + our model lookup) so
 * -instruct/-thinking/-chat/-base/-reasoning variants of the same base model
 * collapse to the same key. This is the "same underlying model" principle.
 *
 * Example: 'qwen3-next-80b-a3b-instruct' and 'qwen3-next-80b-a3b-thinking'
 * both normalize to 'qwen3-next-80b-a3b'.
 */
function baseKey(modelId) {
  let c = conservativeBase(modelId);
  for (const suffix of VARIANT_SUFFIXES) {
    const re = new RegExp('-' + suffix + '$');
    if (re.test(c)) {
      c = c.replace(re, '');
      break; // only strip one
    }
  }
  return c;
}

/**
 * Pick the best (highest-Elo) entry from a design_arena array.
 * Returns { category, elo, win_rate, rank } or null if empty.
 */
function bestArenaEntry(arena) {
  if (!Array.isArray(arena) || arena.length === 0) return null;
  let best = arena[0];
  for (const entry of arena) {
    if (entry.elo > best.elo) best = entry;
  }
  return { category: best.category ?? null, elo: best.elo, win_rate: best.win_rate ?? null, rank: best.rank ?? null };
}

/**
 * Build a benchmark index from OpenRouter /models response data.
 *
 * Keys: baseKey(id) — conservativeBase + variant-suffix strip, so the
 * -instruct/-thinking/-chat variants of the same model collapse to one key.
 * Value: flattened benchmark block:
 *   { intelligence_index, coding_index, agentic_index, design_arena_best }
 *
 * On collision (two OR models map to same base), prefer the entry with
 * artificial_analysis indices (richer signal than design_arena alone).
 *
 * @param {Array} orModels - data.data array from OpenRouter /models
 * @returns {Map<string, object>}
 */
export function buildBenchmarkIndex(orModels) {
  const idx = new Map();
  for (const m of orModels) {
    if (!m || !m.benchmarks || typeof m.benchmarks !== 'object') continue;
    const bench = m.benchmarks;
    const hasAA = bench.artificial_analysis && typeof bench.artificial_analysis === 'object';
    const hasArena = Array.isArray(bench.design_arena) && bench.design_arena.length > 0;
    if (!hasAA && !hasArena) continue;

    const aa = hasAA ? bench.artificial_analysis : {};
    const flattened = {
      intelligence_index: hasAA ? (aa.intelligence_index ?? null) : null,
      coding_index: hasAA ? (aa.coding_index ?? null) : null,
      agentic_index: hasAA ? (aa.agentic_index ?? null) : null,
      design_arena_best: hasArena ? bestArenaEntry(bench.design_arena) : null,
    };

    const key = baseKey(m.id);
    const existing = idx.get(key);
    // Collision: prefer the entry with AA indices (richer). If both have AA or neither, keep first-seen.
    if (!existing || (!existing.intelligence_index && flattened.intelligence_index !== null)) {
      idx.set(key, flattened);
    }
  }
  return idx;
}

/**
 * Try to resolve a benchmark match, with safe fallbacks for known ID-asymmetry
 * patterns between our catalog and OpenRouter's.
 *
 * The index is keyed by baseKey() (conservativeBase + variant-suffix strip),
 * so -instruct/-thinking/-chat variants collapse automatically.
 *
 * Tier 1: baseKey(model.id) — matches any variant of the same base model.
 * Tier 2: org-prefix strip — for org-name doubling where canonicalId keeps a
 *   leading 'nvidia-'/'meta-llama-' that OR strips. Only fires when the
 *   stripped key exists in the index (zero misattribution risk).
 *
 * @param {string} modelId - our model id
 * @param {Map<string, object>} index - from buildBenchmarkIndex()
 * @returns {object|null} the flattened benchmark block, or null if no match
 */
function resolveBenchmark(modelId, index) {
  const primary = baseKey(modelId);
  const direct = index.get(primary);
  if (direct) return direct;

  // Tier 2: strip one leading token (org-name doubling).
  // 'nvidia-nemotron-...' → 'nemotron-...', 'meta-llama-...' → 'llama-...'
  const dashIdx = primary.indexOf('-');
  if (dashIdx > 0) {
    const stripped = primary.slice(dashIdx + 1);
    const fallback = index.get(stripped);
    if (fallback) return fallback;
  }
  return null;
}

// Known ID-asymmetry aliases: model IDs where the org-token is missing from
// the canonical form but present in the AA/OR source. Mapped to the AA
// index key (conservativeBase of the slug).
const BENCHMARK_ALIAS_MAP = {
  'glm5.2': 'glm-5.2',
};

/**
 * Apply Artificial Analysis free-tier enrichment to our text models.
 *
 * AA indices fill null/undefined intelligence/coding/agentic values that
 * OpenRouter didn't provide. OR values are authoritative — never overwritten.
 *
 * Index is keyed by conservativeBase — same structure as buildBenchmarkIndex output.
 * Collision resolution (prefer non-preview/non-turbo) is done at index build time
 * in fetch-aa.mjs/buildIndexFromModels().
 *
 * AA free-tier doesn't have design_arena — never touches that field.
 *
 * @param {Array} models - our pricing.json text models (mutated in-place)
 * @param {Map<string, {intelligence_index, coding_index, agentic_index}>} aaIndex - from fetchAABenchmarks()
 * @returns {{ filledCount: number, totalAttempts: number }}
 */
export function applyAAEnrichment(models, aaIndex) {
  if (!aaIndex) return { filledCount: 0, totalAttempts: 0 };
  let filledCount = 0;
  let totalAttempts = 0;

  for (const m of models) {
    const canonical = canonicalId(m.id);
    const base = conservativeBase(canonical);

    // Apply BENCHMARK_ALIAS_MAP if needed for the base lookup
    const alias = BENCHMARK_ALIAS_MAP[base];
    const lookupBase = alias || base;

    const match = aaIndex.get(lookupBase);
    if (!match) continue;

    totalAttempts++;

    // Initialize benchmarks block if missing
    if (!m.benchmarks) {
      m.benchmarks = {
        intelligence_index: null,
        coding_index: null,
        agentic_index: null,
        design_arena_best: null,
      };
    }

    // Fill null/undefined indices only — never overwrite non-null values
    if (m.benchmarks.intelligence_index == null && match.intelligence_index != null) {
      m.benchmarks.intelligence_index = match.intelligence_index;
      filledCount++;
    }
    if (m.benchmarks.coding_index == null && match.coding_index != null) {
      m.benchmarks.coding_index = match.coding_index;
      filledCount++;
    }
    if (m.benchmarks.agentic_index == null && match.agentic_index != null) {
      m.benchmarks.agentic_index = match.agentic_index;
      filledCount++;
    }
  }

  return { filledCount, totalAttempts };
}

/**
 * Apply benchmark enrichment to our text models (in-place mutation).
 *
 * For each model, look up the benchmark index by conservativeBase(model.id),
 * with a safe org-prefix-stripping fallback for doubled org names.
 * If matched, attach a `benchmarks` block with the flattened fields.
 * Unmatched models are left untouched (no `benchmarks` field added).
 *
 * @param {Array} models - our pricing.json text models (mutated in-place)
 * @param {Map<string, object>} index - from buildBenchmarkIndex()
 * @returns {{ matchedCount: number, aaCount: number, arenaCount: number }}
 */
export function applyBenchmarkEnrichment(models, index) {
  let matchedCount = 0;
  let aaCount = 0;
  let arenaCount = 0;
  for (const m of models) {
    const bench = resolveBenchmark(m.id, index);
    if (!bench) continue;
    m.benchmarks = {
      intelligence_index: bench.intelligence_index,
      coding_index: bench.coding_index,
      agentic_index: bench.agentic_index,
      design_arena_best: bench.design_arena_best,
    };
    matchedCount++;
    if (bench.intelligence_index !== null) aaCount++;
    else if (bench.design_arena_best) arenaCount++;
  }
  return { matchedCount, aaCount, arenaCount };
}

const ARENA_FIELDS = Object.freeze({
  overall: 'arena_text',
  creative_writing: 'arena_creative_writing',
});

const ARENA_MODE_SUFFIXES = /-(?:max|xhigh|high|medium|low)$/;

function arenaModelKeys(modelName) {
  const key = modelSpellingKey(String(modelName || '').trim());
  if (!key) return [];
  const keys = [key];
  const withoutMode = key.replace(ARENA_MODE_SUFFIXES, '');
  if (withoutMode && withoutMode !== key) keys.push(withoutMode);
  return keys;
}

function setArenaScore(target, row, field) {
  if (!target[field] || (target[field].rating ?? -Infinity) < row.rating) {
    target[field] = row;
  }
}

/**
 * Build an index of official Arena latest-leaderboard rows. Names are first
 * normalized with modelSpellingKey(), then use conservativeBase() for the same
 * trailing quant/SKU fallback as the existing benchmark matcher. Size and
 * version tokens remain part of every key.
 *
 * Display-only effort labels (Max/High/etc.) are fallback aliases only; an
 * exact source model name always wins, and ambiguous aliases are not emitted.
 */
export function buildArenaIndex(rows) {
  const exact = new Map();
  const aliasesByKey = new Map();

  for (const row of rows || []) {
    const field = ARENA_FIELDS[row?.category];
    if (!field || typeof row.model_name !== 'string' || !Number.isFinite(row.rating)) continue;
    const entry = {
      rating: row.rating,
      rank: Number.isFinite(row.rank) ? row.rank : null,
      rating_lower: Number.isFinite(row.rating_lower) ? row.rating_lower : null,
      rating_upper: Number.isFinite(row.rating_upper) ? row.rating_upper : null,
      vote_count: Number.isFinite(row.vote_count) ? row.vote_count : null,
      model_name: row.model_name,
      leaderboard_publish_date: row.leaderboard_publish_date ?? null,
    };
    const keys = arenaModelKeys(row.model_name);
    const exactKey = keys[0];
    const scores = exact.get(exactKey) || {};
    setArenaScore(scores, entry, field);
    exact.set(exactKey, scores);

    if (keys.length > 1) {
      const aliases = aliasesByKey.get(keys[1]) || [];
      aliases.push({ exactKey, field, entry });
      aliasesByKey.set(keys[1], aliases);
    }
  }

  const aliases = new Map();
  for (const [key, entries] of aliasesByKey) {
    const distinct = new Map(entries.map((item) => [`${item.exactKey}|${item.field}`, item]));
    const byField = {};
    for (const field of Object.values(ARENA_FIELDS)) {
      const matches = [...distinct.values()].filter((item) => item.field === field);
      if (matches.length === 1 && exact.get(key)?.[field] == null) {
        byField[field] = matches[0].entry;
      }
    }
    if (Object.keys(byField).length) aliases.set(key, byField);
  }

  const familyCandidates = new Map();
  for (const [key, scores] of exact) {
    const family = conservativeBase(key);
    const candidates = familyCandidates.get(family) || [];
    candidates.push({ key, scores });
    familyCandidates.set(family, candidates);
  }
  for (const [key, scores] of aliases) {
    const family = conservativeBase(key);
    const candidates = familyCandidates.get(family) || [];
    candidates.push({ key, scores });
    familyCandidates.set(family, candidates);
  }

  const families = new Map();
  for (const [key, candidates] of familyCandidates) {
    const exactBase = candidates.find((candidate) => candidate.key === key);
    const distinct = new Map(candidates.map((candidate) => [candidate.key, candidate.scores]));
    if (exactBase) families.set(key, exactBase.scores);
    else if (distinct.size === 1) families.set(key, candidates[0].scores);
  }

  return { exact, aliases, families };
}

function resolveArenaEntry(modelId, index) {
  const keys = arenaModelKeys(modelId);
  for (const key of keys) {
    const exact = index.exact.get(key);
    if (exact) return exact;
  }
  for (const key of keys) {
    const alias = index.aliases.get(key);
    if (alias) return alias;
  }
  for (const key of keys) {
    const family = index.families.get(conservativeBase(key));
    if (family) return family;
  }

  // Match the existing benchmark resolver's one-token organization fallback,
  // but only if that exact reduced key exists in the source index.
  for (const key of keys) {
    const stripped = key.slice(key.indexOf('-') + 1);
    if (stripped !== key) {
      const exact = index.exact.get(stripped) || index.aliases.get(stripped);
      if (exact) return exact;
      const family = index.families.get(conservativeBase(stripped));
      if (family) return family;
    }
  }
  return null;
}

/** Apply Arena text ratings to model benchmark blocks without changing other scores. */
export function applyArenaEnrichment(models, index) {
  let matchedCount = 0;
  let textCount = 0;
  let creativeWritingCount = 0;
  for (const model of models || []) {
    if (!model?.id) continue;
    const match = resolveArenaEntry(model.id, index);
    if (!match) continue;
    const text = match.arena_text;
    const creative = match.arena_creative_writing;
    if (text === undefined && creative === undefined) continue;

    model.benchmarks ||= {};
    if (text) {
      model.benchmarks.arena_text = text.rating;
      model.benchmarks.arena_text_rank = text.rank;
      model.benchmarks.arena_text_rating_lower = text.rating_lower;
      model.benchmarks.arena_text_rating_upper = text.rating_upper;
      model.benchmarks.arena_text_vote_count = text.vote_count;
      model.benchmarks.arena_text_date = text.leaderboard_publish_date;
      textCount++;
    }
    if (creative) {
      model.benchmarks.arena_creative_writing = creative.rating;
      model.benchmarks.arena_creative_writing_rank = creative.rank;
      model.benchmarks.arena_creative_writing_rating_lower = creative.rating_lower;
      model.benchmarks.arena_creative_writing_rating_upper = creative.rating_upper;
      model.benchmarks.arena_creative_writing_vote_count = creative.vote_count;
      model.benchmarks.arena_creative_writing_date = creative.leaderboard_publish_date;
      creativeWritingCount++;
    }
    matchedCount++;
  }
  return { matchedCount, textCount, creativeWritingCount };
}
