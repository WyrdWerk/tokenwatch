/**
 * shared/benchmarks.mjs — pure matching helpers for OpenRouter benchmark
 * enrichment (Artificial Analysis indices + design_arena Elo).
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

import { canonicalId } from './normalize.mjs';

// Trailing quantization suffixes (MUST be last token to strip).
// Sourced from AGENTS.md canonical-model-ID convention.
const QUANT_SUFFIXES = ['fp8', 'fp16', 'bf16', 'int8', 'int4', 'nvfp4', 'awq', 'gptq', 'mxfp4', 'f16'];

// Trailing SKU performance suffixes (MUST be last token to strip).
const SKU_SUFFIXES = ['turbo', 'fast', 'highspeed'];

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
 * Keys: conservativeBase(id). Value: flattened benchmark block:
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

    const key = conservativeBase(m.id);
    const existing = idx.get(key);
    // Collision: prefer the entry with AA indices (richer). If both have AA or neither, keep first-seen.
    if (!existing || (!existing.intelligence_index && flattened.intelligence_index !== null)) {
      idx.set(key, flattened);
    }
  }
  return idx;
}

/**
 * Apply benchmark enrichment to our text models (in-place mutation).
 *
 * For each model, look up the benchmark index by conservativeBase(model.id).
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
    const key = conservativeBase(m.id);
    const bench = index.get(key);
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
