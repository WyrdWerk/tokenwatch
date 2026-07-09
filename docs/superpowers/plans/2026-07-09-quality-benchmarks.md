# Quality Benchmark Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Artificial Analysis quality indices (intelligence/coding/agentic) and design_arena Elo from OpenRouter's `benchmarks` field in the text-model detail modal card, with footer attribution links to the benchmark sources.

**Architecture:** A new pure `shared/benchmarks.mjs` module (Worker-safe, no `node:` imports) provides conservative variant-to-base matching. The fetch pipeline extracts the `benchmarks` field from the already-fetched OpenRouter `/models` response (currently discarded inside `fetchOpenRouter()`), builds a `Map<canonicalBase, benchmarks>`, and attaches a flattened `benchmarks` block to each text model post-dedup. The API gains three sort keys and a `benchmarked` filter. The frontend modal renders a new Quality section (modal card only — no table column) and all three page footers gain benchmark-source links. No value-per-dollar in v1.

**Tech Stack:** Pure Node ESM, zero dependencies. `node:test` for tests. Existing patterns mirrored from `shared/modelsdev.mjs`, `scripts/fetch-modelsdev.mjs`, and the models.dev enrichment pipeline.

## Global Constraints

- **Zero `node:` imports in `shared/benchmarks.mjs`** — it must be Worker-bundleable (same purity contract as `shared/normalize.mjs` and `shared/modelsdev.mjs`). All HTTP/FS work belongs in `scripts/`.
- **Conservative matching only** — strip trailing quant suffixes (`-fp8|-fp16|-bf16|-int8|-int4|-nvfp4|-awq|-gptq|-mxfp4|-f16`) and SKU suffixes (`-turbo|-fast|-highspeed`). NEVER strip size tokens (`-70b`, `-480b-a35b`) or version bits (`-4-6`) — those create false matches (e.g. `Qwen3-30B-A3B → qwen3`).
- **AA scale tops out at ~55** (GPT-5.5=54.8, Claude Sonnet 5=53.4). Show raw numbers only. No color coding, no thresholds.
- **Value-per-dollar is out of scope** for v1. Raw `intelligence/price` makes cheap-weak models rank above flagships — deferred to v2.
- **Non-fatal enrichment** — if OR fetch fails or benchmarks blob is malformed, models ship without benchmarks. Never abort the pipeline for benchmark issues.
- **Modal-only surfacing** — no new table column, no new sort header on the table. The API gains sort/filter for programmatic users, but the frontend table is unchanged.
- **Coverage floors (parity guard):** ≥65% any-benchmark, ≥48% AA-indices on the real `pricing.json`. Current measured: 72.6% / 53.3%.
- **Commit convention:** `feat(benchmarks):` / `test(benchmarks):` / `docs(benchmarks):` / `chore(benchmarks):` prefixes.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `shared/benchmarks.mjs` | Pure matching helpers: `conservativeBase()`, `buildBenchmarkIndex()`, `applyBenchmarkEnrichment()`. No node: imports. | NEW |
| `scripts/lib.mjs` | Re-export benchmark helpers (mirrors normalize/modelsdev re-export block at line 80). | MODIFY |
| `scripts/fetch-pricing.mjs` | Thread OR `/models` `benchmarks` field out of `fetchOpenRouter()`, build index, call `applyBenchmarkEnrichment()` in sidecar section (~line 854). | MODIFY |
| `functions/api/v1/[[route]].js` | Add `intelligence`/`coding`/`agentic` sort keys + `benchmarked` filter to `/models`. | MODIFY |
| `public/app.js` | Add Quality section to `showDetailModal()` between Capabilities and About sections. | MODIFY |
| `public/index.html` | Append benchmark-source links to `.footer-links` (line 200). | MODIFY |
| `public/image.html` | Append benchmark-source links to `.footer-links` (line 123). | MODIFY |
| `public/video.html` | Append benchmark-source links to `.footer-links` (line 123). | MODIFY |
| `public/styles.css` | Add `.detail-quality-row` label/value styling (tabular-nums). Footer links need NO new CSS (inherit `.footer-links a`). | MODIFY |
| `test/benchmarks.test.mjs` | Unit tests for conservative matching, collision preference, edge cases. | NEW |
| `test/parity.test.mjs` | Add benchmark coverage-floor regression guards. | MODIFY |
| `test/api.test.mjs` | Add `?sort=intelligence` and `?benchmarked=true` cases. | MODIFY |
| `AGENTS.md` | Document benchmarks field, matching algorithm, modal placement. | MODIFY |

---

### Task 1: Pure matching module — `shared/benchmarks.mjs`

**Files:**
- Create: `shared/benchmarks.mjs`
- Test: `test/benchmarks.test.mjs`

**Interfaces:**
- Consumes: `canonicalId` from `./normalize.mjs`
- Produces:
  - `conservativeBase(modelId: string): string` — strips trailing quant/SKU suffixes from a canonical ID
  - `buildBenchmarkIndex(orModels: Array): Map<string, object>` — maps `conservativeBase(id)` → `{ intelligence_index, coding_index, agentic_index, design_arena_best }`
  - `applyBenchmarkEnrichment(models: Array, index: Map): { matchedCount, aaCount, arenaCount }` — mutates each model in-place, attaches `benchmarks` block when matched

- [ ] **Step 1: Write the failing tests**

Create `test/benchmarks.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conservativeBase, buildBenchmarkIndex, applyBenchmarkEnrichment } from '../shared/benchmarks.mjs';

// ── conservativeBase: quant suffix stripping ──

test('conservativeBase strips trailing fp8 suffix', () => {
  assert.equal(conservativeBase('z-ai/glm-5.2-fp8'), 'glm-5.2');
});

test('conservativeBase strips trailing nvfp4 suffix', () => {
  assert.equal(conservativeBase('z-ai/glm-5.2-nvfp4'), 'glm-5.2');
});

test('conservativeBase strips trailing int4 suffix', () => {
  assert.equal(conservativeBase('model-x-int4'), 'model-x');
});

test('conservativeBase does not strip mid-string quant tokens', () => {
  // fp8 must be the LAST token, not embedded
  assert.equal(conservativeBase('fp8-model'), 'fp8-model');
});

// ── conservativeBase: SKU suffix stripping ──

test('conservativeBase strips trailing turbo suffix', () => {
  assert.equal(conservativeBase('anthropic/claude-sonnet-5-turbo'), 'claude-sonnet-5');
});

test('conservativeBase strips trailing fast suffix', () => {
  assert.equal(conservativeBase('model-y-fast'), 'model-y');
});

test('conservativeBase strips trailing highspeed suffix', () => {
  assert.equal(conservativeBase('model-z-highspeed'), 'model-z');
});

// ── conservativeBase: NO over-stripping (the critical safety tests) ──

test('conservativeBase does NOT strip size tokens (Qwen3-30B stays distinct)', () => {
  // This is the false-match guard: aggressive stripping would turn this into 'qwen3'
  assert.equal(conservativeBase('qwen/qwen3-30b-a3b'), 'qwen3-30b-a3b');
});

test('conservativeBase does NOT strip version bits', () => {
  // claude-sonnet-4-6 must stay as-is, NOT collapse to claude-sonnet-4
  assert.equal(conservativeBase('anthropic/claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

test('conservativeBase strips only the LAST turbo when multiple suffixes present', () => {
  // -480b-a35b-instruct-turbo → only -turbo stripped, rest preserved
  assert.equal(
    conservativeBase('qwen/qwen3-coder-480b-a35b-instruct-turbo'),
    'qwen3-coder-480b-a35b-instruct'
  );
});

// ── buildBenchmarkIndex ──

test('buildBenchmarkIndex keys by conservativeBase', () => {
  const orModels = [
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
    { id: 'z-ai/glm-5.2-fp8', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  assert.ok(idx.has('glm-5.2'));
  assert.equal(idx.size, 1, 'both variants collapse to one base key');
});

test('buildBenchmarkIndex flattens AA indices to top-level fields', () => {
  const orModels = [
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  const entry = idx.get('glm-5.2');
  assert.equal(entry.intelligence_index, 51.1);
  assert.equal(entry.coding_index, 67.0);
  assert.equal(entry.agentic_index, 44.2);
  assert.equal(entry.design_arena_best, null);
});

test('buildBenchmarkIndex picks best design_arena entry (highest Elo)', () => {
  const orModels = [
    {
      id: 'model-x',
      benchmarks: {
        design_arena: [
          { category: '3d', elo: 1320, win_rate: 60, rank: 5 },
          { category: 'codecategories', elo: 1352, win_rate: 62, rank: 4 },
          { category: 'dataviz', elo: 1336, win_rate: 61, rank: 3 },
        ],
      },
    },
  ];
  const idx = buildBenchmarkIndex(orModels);
  const entry = idx.get('model-x');
  assert.equal(entry.design_arena_best.elo, 1352);
  assert.equal(entry.design_arena_best.category, 'codecategories');
  assert.equal(entry.intelligence_index, null);
});

test('buildBenchmarkIndex prefers AA entry on collision (richer signal)', () => {
  // When two OR models map to the same base, prefer the one with artificial_analysis
  const orModels = [
    { id: 'model-x', benchmarks: { design_arena: [{ category: '3d', elo: 1300, win_rate: 55, rank: 6 }] } },
    { id: 'model-x-turbo', benchmarks: { artificial_analysis: { intelligence_index: 50, coding_index: 60, agentic_index: 40 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  const entry = idx.get('model-x');
  assert.equal(entry.intelligence_index, 50, 'AA-wins collision preference');
});

test('buildBenchmarkIndex skips models with empty benchmarks blob', () => {
  const orModels = [
    { id: 'model-x', benchmarks: {} },
    { id: 'model-y', benchmarks: null },
    { id: 'model-z', /* no benchmarks field */ },
    { id: 'model-w', benchmarks: { artificial_analysis: { intelligence_index: 40, coding_index: 50, agentic_index: 30 } } },
  ];
  const idx = buildBenchmarkIndex(orModels);
  assert.equal(idx.size, 1, 'only model-w with real benchmarks indexed');
});

// ── applyBenchmarkEnrichment ──

test('applyBenchmarkEnrichment attaches benchmarks block on match', () => {
  const models = [{ id: 'z-ai/glm-5.2', provider: 'z-ai', pricing: { input: 1.4, output: 4.4 } }];
  const idx = buildBenchmarkIndex([
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ]);
  const result = applyBenchmarkEnrichment(models, idx);
  assert.ok(models[0].benchmarks, 'benchmarks block attached');
  assert.equal(models[0].benchmarks.intelligence_index, 51.1);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.aaCount, 1);
});

test('applyBenchmarkEnrichment matches quant variant to base model', () => {
  const models = [{ id: 'z-ai/glm-5.2-fp8', provider: 'z-ai', pricing: { input: 1.4, output: 4.4 } }];
  const idx = buildBenchmarkIndex([
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51.1, coding_index: 67.0, agentic_index: 44.2 } } },
  ]);
  applyBenchmarkEnrichment(models, idx);
  assert.ok(models[0].benchmarks, 'fp8 variant matched base model benchmark');
});

test('applyBenchmarkEnrichment leaves unmatched models untouched (no benchmarks field)', () => {
  const models = [
    { id: 'unknown/model', provider: 'unknown', pricing: { input: 1, output: 2 } },
  ];
  const idx = buildBenchmarkIndex([
    { id: 'z-ai/glm-5.2', benchmarks: { artificial_analysis: { intelligence_index: 51, coding_index: 67, agentic_index: 44 } } },
  ]);
  const result = applyBenchmarkEnrichment(models, idx);
  assert.equal(models[0].benchmarks, undefined, 'no benchmarks field added to unmatched');
  assert.equal(result.matchedCount, 0);
});

test('applyBenchmarkEnrichment counts design_arena-only matches in arenaCount', () => {
  const models = [{ id: 'model-x', provider: 'p', pricing: { input: 1, output: 2 } }];
  const idx = buildBenchmarkIndex([
    { id: 'model-x', benchmarks: { design_arena: [{ category: '3d', elo: 1300, win_rate: 55, rank: 6 }] } },
  ]);
  const result = applyBenchmarkEnrichment(models, idx);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.aaCount, 0);
  assert.equal(result.arenaCount, 1);
  assert.ok(models[0].benchmarks.design_arena_best);
  assert.equal(models[0].benchmarks.intelligence_index, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/benchmarks.test.mjs`
Expected: FAIL with errors like `Cannot find module '../shared/benchmarks.mjs'` — the module does not exist yet.

- [ ] **Step 3: Write `shared/benchmarks.mjs`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/benchmarks.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Verify purity (no node: imports)**

Run: `grep -n "node:" shared/benchmarks.mjs`
Expected: no output (the file has no node: imports).

- [ ] **Step 6: Commit**

```bash
git add shared/benchmarks.mjs test/benchmarks.test.mjs
git commit -m "feat(benchmarks): pure matching module with conservative variant stripping

shared/benchmarks.mjs provides conservativeBase(), buildBenchmarkIndex(),
and applyBenchmarkEnrichment(). Strips only trailing quant (-fp8, -nvfp4,
...) and SKU (-turbo, -fast, -highspeed) suffixes — never size tokens or
version bits, which would create false matches (Qwen3-30B-A3B stays
distinct from qwen3 base).

14 unit tests covering quant/SKU strip, no-over-strip safety, collision
preference (AA-wins), and empty-blob handling. Zero node: imports."
```

---

### Task 2: Re-export from `scripts/lib.mjs`

**Files:**
- Modify: `scripts/lib.mjs` (after line 80)

**Interfaces:**
- Consumes: `conservativeBase`, `buildBenchmarkIndex`, `applyBenchmarkEnrichment` from `shared/benchmarks.mjs`
- Produces: same three functions re-exported from `scripts/lib.mjs` for pipeline consumption

- [ ] **Step 1: Read the existing re-export block for context**

Run: `grep -n "shared/modelsdev.mjs" scripts/lib.mjs`
Expected output shows the modelsdev re-export around line 80. Read lines 77-80 to confirm the exact comment+export style.

- [ ] **Step 2: Add the benchmarks re-export**

After the modelsdev re-export line (line 80: `export { PROVIDER_MAP, normalizeForMatch, findEnrichment, applyEnrichment } from '../shared/modelsdev.mjs';`), insert:

```js

// Benchmark matching helpers live in shared/benchmarks.mjs (pure, no node:
// imports) — same purity contract as normalize.mjs and modelsdev.mjs so they
// could be bundled into the Worker. Re-exported here for fetch-pricing.mjs.
export { conservativeBase, buildBenchmarkIndex, applyBenchmarkEnrichment } from '../shared/benchmarks.mjs';
```

- [ ] **Step 3: Verify the import resolves**

Run: `node -e "import('./scripts/lib.mjs').then(m => console.log(Object.keys(m).filter(k => /Benchmark|conservativeBase|buildBenchmark/.test(k))))"`
Expected: `[ 'conservativeBase', 'buildBenchmarkIndex', 'applyBenchmarkEnrichment' ]`

- [ ] **Step 4: Commit**

```bash
git add scripts/lib.mjs
git commit -m "feat(benchmarks): re-export matching helpers from scripts/lib.mjs"
```

---

### Task 3: Pipeline integration — thread benchmarks out of `fetchOpenRouter()`

**Files:**
- Modify: `scripts/fetch-pricing.mjs`

**Interfaces:**
- Consumes: `applyBenchmarkEnrichment`, `buildBenchmarkIndex` from `./lib.mjs` (after Task 2)
- Produces: text models in `out.models` carry a `benchmarks` block when matched

This is the most intricate task because the OR `/models` `benchmarks` field is currently fetched-and-discarded inside `fetchOpenRouter()`. We thread it out as a fourth return value.

- [ ] **Step 1: Read `fetchOpenRouter()` to find the return statement and `data.data` scope**

Confirmed structure (verified against source):
- Line 403: `async function fetchOpenRouter() {`
- Line 404: `const data = await fetchJsonWithRetry(OPENROUTER_MODELS_URL);`
- Line 405: `const allModels = data.data || [];` — this is the array carrying the `benchmarks` field
- Line 454: `return { models: priced, modelCount: textModels.length, failed };`
- Line 732 (in `main()`): `const or = await fetchOpenRouter();` — simple object assignment, NOT destructuring
- Line 733-735: uses `or.models.length` and `or.models` via spread

The `benchmarks` field lives on each entry of `allModels`. We thread `allModels` out as a fourth return field.

- [ ] **Step 2: Add the benchmark imports**

In the import block at lines 34-44, add `applyBenchmarkEnrichment` and `buildBenchmarkIndex`. The modified import:

```js
import {
  num, perTokToPerM, centsToDollars, passthrough,
  NON_TEXT_ID, isTextModel,
  ORG_ALIASES, PROVIDER_NAME_MAP,
  orgFromId, orgFromName,
  canonicalId, orgLookupKey,
  normalizeProvider, dedupKey, dedupModels,
  fetchJson, fetchJsonWithRetry,
  checkCoverageDrop,
  applyEnrichment,
  applyBenchmarkEnrichment,
  buildBenchmarkIndex,
} from './lib.mjs';
```

- [ ] **Step 3: Thread `allModels` (the OR `/models` data.data array) out of `fetchOpenRouter()`**

At line 454, change:
```js
  return { models: priced, modelCount: textModels.length, failed };
```
to:
```js
  return { models: priced, modelCount: textModels.length, failed, orModels: allModels };
```

Then at the call site (line 732), preserve the existing `or` object and just access the new field later. The line stays:
```js
    const or = await fetchOpenRouter();
```
No change to line 732 itself. The `or.orModels` field will be available downstream.

**Note:** `allModels` contains the FULL OR catalog (including image/video models). `buildBenchmarkIndex` handles this correctly — it filters to entries with non-empty `benchmarks` blobs, and image models don't carry text benchmarks, so they're naturally excluded.

- [ ] **Step 4: Add the benchmark enrichment pass in the sidecar section**

The models.dev enrichment block ends around line 854. The benchmark pass must run AFTER dedup (which happens around line 765) and AFTER the models.dev enrichment, operating on `out.models`. Since `out.models` is mutated in place by the time we reach the sidecar section, and `or.orModels` was captured at line 732, insert the benchmark pass after the models.dev block closes (after line 854):

```js

    // ── Benchmark enrichment (sidecar) ──
    // Attaches Artificial Analysis indices (intelligence/coding/agentic) and
    // design_arena Elo from OpenRouter's /models benchmarks field. Conservative
    // variant matching — quant/SKU suffix strip only. Non-fatal.
    if (or.orModels && or.orModels.length > 0) {
      const benchIndex = buildBenchmarkIndex(or.orModels);
      if (benchIndex.size > 0) {
        const { matchedCount, aaCount, arenaCount } = applyBenchmarkEnrichment(out.models, benchIndex);
        const total = out.models.length;
        console.log(`  Benchmark enrichment: ${matchedCount}/${total} matched (${aaCount} AA indices, ${arenaCount} design_arena only, ${total - matchedCount} unscored)`);
      }
    }
```

**Important scope check:** confirm `or` is still in scope at line 854. It's declared with `const` at line 732 inside the same `main()` function. The models.dev block (lines 828-854) is also inside `main()`. So `or` is in scope — no closure issue. If during implementation `or` is found to be out of scope (e.g. if the sidecar section moved to a different function), hoist `or.orModels` to a variable at the top of `main()` near line 732.

- [ ] **Step 5: Run the fetcher in dry-run mode to verify**

Run: `npm run fetch` (this runs the full pipeline; takes ~15-20s and writes `public/pricing.json`)

Expected: the console output includes a line like:
```
  Benchmark enrichment: 667/919 matched (490 AA indices, 177 design_arena only, 252 unscored)
```

The exact numbers will match the measured 72.6% / 53.3% coverage.

- [ ] **Step 6: Verify the benchmarks field landed in pricing.json**

Run:
```bash
node -e "const d=require('./public/pricing.json'); const b=d.models.filter(m=>m.benchmarks); console.log('with benchmarks:', b.length, '/', d.models.length, '(' + (100*b.length/d.models.length).toFixed(1) + '%)'); const sample=b.find(m=>m.benchmarks.intelligence_index!==null); console.log('sample:', sample.id, JSON.stringify(sample.benchmarks));"
```

Expected: `with benchmarks: ~667 / 919 (~72.6%)` and a sample with non-null `intelligence_index`.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass (94 existing + 14 new benchmark tests = 108).

- [ ] **Step 8: Commit**

```bash
git add scripts/fetch-pricing.mjs public/pricing.json
git commit -m "feat(benchmarks): wire benchmark enrichment into fetch pipeline

Threads OpenRouter /models benchmarks field (previously discarded inside
fetchOpenRouter) out as orModels return value. Builds benchmark index,
applies conservative variant matching post-dedup. Coverage: 667/919 text
models (72.6%) — 490 with AA indices, 177 design_arena only, 252 unscored."
```

---

### Task 4: API sort keys + filter

**Files:**
- Modify: `functions/api/v1/[[route]].js`

**Interfaces:**
- Consumes: the `benchmarks` block now present on text models in pricing.json (from Task 3)
- Produces: `?sort=intelligence|coding|agentic` and `?benchmarked=true` on `/api/v1/models`

- [ ] **Step 1: Add the three sort keys to `validSorts`**

At line 258, change:
```js
  const validSorts = ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount'];
```
to:
```js
  const validSorts = ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'];
```

- [ ] **Step 2: Add the sort branches**

At line 267 (the `else` branch that indexes `a.pricing[sortKey]`), insert the benchmark branches BEFORE it. The modified block:

```js
      if (sortKey === 'id') { va = a.id.toLowerCase(); vb = b.id.toLowerCase(); }
      else if (sortKey === 'context') { va = a.context_length; vb = b.context_length; }
      else if (sortKey === 'max_output') { va = a.max_completion_tokens; vb = b.max_completion_tokens; }
      else if (sortKey === 'uptime') { va = a.uptime_30m; vb = b.uptime_30m; }
      else if (sortKey === 'intelligence') { va = a.benchmarks?.intelligence_index; vb = b.benchmarks?.intelligence_index; }
      else if (sortKey === 'coding') { va = a.benchmarks?.coding_index; vb = b.benchmarks?.coding_index; }
      else if (sortKey === 'agentic') { va = a.benchmarks?.agentic_index; vb = b.benchmarks?.agentic_index; }
      else { va = a.pricing[sortKey]; vb = b.pricing[sortKey]; }
```

The existing null-handling at lines 268-269 (`if (va === null || va === undefined) return 1;`) already pushes nulls to the bottom — this correctly pushes unscored models last when sorting by quality.

- [ ] **Step 3: Add the `benchmarked` filter**

After line 243 (the subscription filter), add:
```js
    const benchmarked = params.get('benchmarked');
    if (benchmarked === 'true') models = models.filter(m => !!m.benchmarks);
```

- [ ] **Step 4: Write API tests**

In `test/api.test.mjs`, add tests mirroring the existing sort/filter test style. Read the file first to find the test patterns, then add:

```js
test('GET /api/v1/models?sort=intelligence orders by benchmark (nulls last)', async () => {
  // ... mirror existing sort test structure, assert first result has non-null benchmarks.intelligence_index
});

test('GET /api/v1/models?benchmarked=true filters to scored models only', async () => {
  // ... mirror existing filter test, assert all results have .benchmarks
});
```

Read the existing `test/api.test.mjs` to copy the mock-ASSETS setup and request pattern exactly — do not invent a new test harness.

- [ ] **Step 5: Run API tests**

Run: `node --test test/api.test.mjs`
Expected: all tests pass including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add functions/api/v1/[[route]].js test/api.test.mjs
git commit -m "feat(api): add intelligence/coding/agentic sort keys + benchmarked filter

GET /api/v1/models now accepts ?sort=intelligence|coding|agentic (nulls
last) and ?benchmarked=true (only models with a benchmarks block). Enables
programmatic quality-aware queries; frontend modal-only surfacing is
unchanged."
```

---

### Task 5: Modal Quality section in `public/app.js`

**Files:**
- Modify: `public/app.js` (in `showDetailModal()`, between lines 562 and 564)
- Modify: `public/styles.css` (add `.detail-quality-row` styling)

**Interfaces:**
- Consumes: the `benchmarks` block on each model (from Task 3)
- Produces: a new Quality section in the detail modal, rendered only when benchmark data exists

- [ ] **Step 1: Read the exact insertion point in `showDetailModal()`**

Read `public/app.js` lines 496-590. Confirm:
- Line 496: `function showDetailModal(idx) {`
- The model is accessed via `const r = state.currentRows?.[idx]?.model;` (line 496-497)
- The Capabilities section closes at line 561-562 (`parts.push('</div>');` + `}`)
- The About section starts at line 564-565

- [ ] **Step 2: Add the Quality section between Capabilities and About**

Between line 562 (the `}` closing the Capabilities `if`) and line 564 (the `// Section: About` comment), insert the Quality section. The insertion reads `r.benchmarks`:

```js

    // Section: Quality (only if benchmark data exists)
    if (r.benchmarks) {
      const b = r.benchmarks;
      const hasAA = b.intelligence_index !== null && b.intelligence_index !== undefined;
      const hasArena = !!b.design_arena_best;
      if (hasAA || hasArena) {
        parts.push('<div class="detail-section"><div class="detail-section-title">Quality</div>');
        if (hasAA) {
          parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Intelligence Index</span><span class="detail-quality-value">' + esc(b.intelligence_index) + '</span></div>');
          parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Coding Index</span><span class="detail-quality-value">' + esc(b.coding_index) + '</span></div>');
          parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Agentic Index</span><span class="detail-quality-value">' + esc(b.agentic_index) + '</span></div>');
        }
        if (hasArena) {
          const a = b.design_arena_best;
          const arenaStr = a.elo + ' (' + esc(a.category) + ', rank ' + a.rank + ', ' + a.win_rate + '% win rate)';
          parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Design Arena Elo</span><span class="detail-quality-value">' + arenaStr + '</span></div>');
        }
        parts.push('<div class="detail-quality-source">Source: Artificial Analysis via OpenRouter</div>');
        parts.push('</div>');
      }
    }
```

- [ ] **Step 3: Add the CSS for quality rows**

In `public/styles.css`, after the `.detail-section-title` block (line 620), add:

```css

/* Quality section in detail modal — tabular label/value rows */
.detail-quality-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.85rem;
  padding: 0.2rem 0;
  font-variant-numeric: tabular-nums;
}
.detail-quality-label {
  color: var(--text-dim, #888);
}
.detail-quality-value {
  color: var(--text, #222);
  font-weight: 500;
}
.detail-quality-source {
  font-size: 0.72rem;
  color: var(--text-dim, #888);
  font-style: italic;
  margin-top: 0.5rem;
}
```

- [ ] **Step 4: Verify locally**

Run: `npm run serve` (serves `public/` on localhost:3000)

Open `http://localhost:3000/`, click a model row that has benchmarks (e.g. `glm-5.2`), verify the modal shows a Quality section with the three indices. Click a model WITHOUT benchmarks (e.g. a Llama 3.1 variant) and verify the Quality section is absent (not rendered empty).

- [ ] **Step 5: Verify on mobile width**

In browser DevTools, toggle to mobile viewport (e.g. 375px width). Open a model modal. Confirm the Quality section rows still display cleanly (flex space-between should adapt).

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "feat(ui): add Quality section to detail modal with AA indices + design_arena

Modal-only surfacing (no table column per design decision). Renders
Intelligence/Coding/Agentic indices as tabular label/value rows, plus
design_arena Elo with category/rank/win-rate. Section omitted entirely
when no benchmark data (clean modal, no empty placeholders). Source
attribution line links context to footer."
```

---

### Task 6: Footer benchmark-source links

**Files:**
- Modify: `public/index.html` (line 200, inside `.footer-links`)
- Modify: `public/image.html` (line 123, inside `.footer-links`)
- Modify: `public/video.html` (line 123, inside `.footer-links`)

**Interfaces:**
- Consumes: nothing (static links)
- Produces: benchmark-source attribution links visible on all three pages

- [ ] **Step 1: Read the exact footer markup in index.html**

Read `public/index.html` lines 193-202. Confirm the `.footer-links` paragraph and its existing two links (Original spreadsheet, Source).

- [ ] **Step 2: Append benchmark links to index.html footer**

At line 200, change:
```html
      <p class="footer-links">
        <a href="https://tiny.cc/payginference" target="_blank" rel="noopener">Original spreadsheet</a>
        · <a href="https://github.com/WyrdWerk/tokenwatch" target="_blank" rel="noopener">Source</a>
      </p>
```
to:
```html
      <p class="footer-links">
        <a href="https://tiny.cc/payginference" target="_blank" rel="noopener">Original spreadsheet</a>
        · <a href="https://github.com/WyrdWerk/tokenwatch" target="_blank" rel="noopener">Source</a>
        · Quality benchmarks via <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">Artificial Analysis</a> &amp; <a href="https://lmarena.ai/" target="_blank" rel="noopener">LMArena</a> (design arena)
      </p>
```

- [ ] **Step 3: Append benchmark links to image.html footer**

Read `public/image.html` lines 116-125. At line 123, change:
```html
      <p class="footer-links">
        <a href="https://github.com/WyrdWerk/tokenwatch" target="_blank" rel="noopener">Source</a>
      </p>
```
to:
```html
      <p class="footer-links">
        <a href="https://github.com/WyrdWerk/tokenwatch" target="_blank" rel="noopener">Source</a>
        · Quality benchmarks via <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener">Artificial Analysis</a> &amp; <a href="https://lmarena.ai/" target="_blank" rel="noopener">LMArena</a> (design arena)
      </p>
```

- [ ] **Step 4: Append benchmark links to video.html footer**

Read `public/video.html` lines 121-129. Apply the same change as Step 3 to line 123.

- [ ] **Step 5: Verify locally**

Run: `npm run serve` if not already running. Visit `http://localhost:3000/`, `http://localhost:3000/image.html`, `http://localhost:3000/video.html`. Scroll to footer. Confirm the benchmark-source links render with accent color and hover-underline (inherited from `.footer-links a`).

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/image.html public/video.html
git commit -m "feat(ui): add benchmark-source links to all three page footers

Attribution to Artificial Analysis and LMArena (design arena), proxied
through OpenRouter. Links inherit existing .footer-links a styling —
no new CSS needed."
```

---

### Task 7: Parity guard + documentation

**Files:**
- Modify: `test/parity.test.mjs` (add benchmark coverage-floor guards after line 91)
- Modify: `AGENTS.md` (document benchmarks field, matching, modal placement)

**Interfaces:**
- Consumes: `pricing.json` (post-Task-3 with `benchmarks` blocks)
- Produces: regression guards and docs

- [ ] **Step 1: Add parity guards to `test/parity.test.mjs`**

After the models.dev guards (ending around line 91), add a new section:

```js

// ── Benchmark enrichment regression guards ───────────────────────────────────

test('benchmark enrichment coverage floor (≥65% of catalog)', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  const scored = data.models.filter((m) => m.benchmarks).length;
  const pct = scored / data.models.length;
  assert.ok(pct >= 0.65,
    `benchmark coverage ${(pct * 100).toFixed(1)}% below 65% floor — a matcher may have regressed`);
});

test('benchmark AA indices coverage floor (≥48% of catalog)', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  const aaScored = data.models.filter((m) => m.benchmarks?.intelligence_index !== null && m.benchmarks?.intelligence_index !== undefined).length;
  const pct = aaScored / data.models.length;
  assert.ok(pct >= 0.48,
    `AA-index coverage ${(pct * 100).toFixed(1)}% below 48% floor — conservativeBase may have regressed`);
});

test('benchmarks field structure is correct when present', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  const withBench = data.models.filter((m) => m.benchmarks);
  assert.ok(withBench.length > 0, 'at least one model should have benchmarks');
  for (const m of withBench.slice(0, 50)) {
    const b = m.benchmarks;
    assert.ok(['intelligence_index', 'coding_index', 'agentic_index', 'design_arena_best'].every(k => k in b),
      `${m.id} benchmarks block missing expected keys`);
  }
});
```

- [ ] **Step 2: Run parity tests**

Run: `node --test test/parity.test.mjs`
Expected: all tests pass, including the three new benchmark guards.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass (108+ total).

- [ ] **Step 4: Update AGENTS.md**

Find the "Data pipeline" section describing the fetch tiers and the models.dev enrichment bullet. Add a new bullet after the models.dev enrichment description:

```markdown
- **Benchmark enrichment (sidecar)**: After models.dev enrichment, `applyBenchmarkEnrichment()` attaches Artificial Analysis quality indices (`intelligence_index`, `coding_index`, `agentic_index`, 0–100 scale) and `design_arena_best` Elo from OpenRouter's `/models` `benchmarks` field. Conservative variant matching (`shared/benchmarks.mjs`) — strips only trailing quant (`-fp8`, `-nvfp4`) and SKU (`-turbo`, `-fast`) suffixes; never size tokens or version bits (which would misattribute). Coverage: ~73% of text models have some benchmark; ~53% have AA indices specifically. Surfaced in the detail modal (not a table column) plus footer source links. No value-per-dollar in v1 — raw math misleads.
```

Also update the "Files to know" table to add `shared/benchmarks.mjs`:

```markdown
| `shared/benchmarks.mjs` | Pure benchmark matching helpers (`conservativeBase`, `buildBenchmarkIndex`, `applyBenchmarkEnrichment`) — imported by both the Node pipeline and testable in isolation. No `node:` imports so it bundles cleanly into the Worker. |
```

- [ ] **Step 5: Commit**

```bash
git add test/parity.test.mjs AGENTS.md
git commit -m "test(benchmarks): add coverage-floor parity guards + AGENTS.md docs

Three regression guards: ≥65% any-benchmark coverage, ≥48% AA-indices
coverage, and benchmarks-block structure validation. Documents the
enrichment pipeline, matching algorithm, and modal-only surfacing in
AGENTS.md."
```

---

### Task 8: Local verification + review prep

**Files:**
- None (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Run cache-busting to ensure fresh assets**

Run: `npm run bust:cache`
Expected: rewrites `?v=` tokens in `public/*.html` to fresh content hashes.

- [ ] **Step 3: Start local server for user review**

Run: `npm run serve`
Expected: serves `public/` on `http://localhost:3000`.

- [ ] **Step 4: Manual verification checklist**

Open `http://localhost:3000/` and verify:
- [ ] Click a model WITH benchmarks (e.g. `glm-5.2`) — modal shows Quality section with 3 indices
- [ ] Click a model WITHOUT benchmarks (e.g. a Llama 3.1 variant) — modal has NO Quality section
- [ ] Click a model with only design_arena (no AA) — modal shows Design Arena Elo line
- [ ] Footer shows benchmark-source links on all three pages
- [ ] Mobile viewport: modal Quality section renders cleanly
- [ ] Benchmark bar (from prior feature) still works
- [ ] Existing features (cost computation, comparison, filters) unaffected

- [ ] **Step 5: Report to user for review**

Tell the user: "Feature implemented locally. Server running on http://localhost:3000. Please review the modal Quality section and footer links. Once approved, I'll push to GitHub."

**Wait for user approval before proceeding to push.** Do NOT push to GitHub in this task.

---

## Self-Review Notes (completed)

**Spec coverage check:**
- ✅ Data capture (flattened benchmarks block) — Task 3
- ✅ Conservative matching algorithm — Task 1
- ✅ Pipeline integration — Task 3
- ✅ API sort/filter — Task 4
- ✅ Modal card Quality section — Task 5
- ✅ Footer benchmark links — Task 6
- ✅ Parity guards — Task 7
- ✅ No table column (correctly absent — modal-only per spec) — Task 5
- ✅ No value-per-dollar (correctly absent — deferred per spec)
- ✅ No color coding (raw numbers per spec) — Task 5
- ✅ Tests — Tasks 1, 4, 7
- ✅ Docs — Task 7

**Type consistency check:**
- `benchmarks` block field names consistent across Task 3 (pipeline attaches), Task 4 (API sorts `a.benchmarks?.intelligence_index`), Task 5 (modal reads `r.benchmarks.intelligence_index`), Task 7 (parity asserts `m.benchmarks?.intelligence_index`). ✅
- `design_arena_best` sub-fields (`category`, `elo`, `win_rate`, `rank`) consistent across Task 1 (buildBenchmarkIndex), Task 5 (modal rendering). ✅
- `conservativeBase`, `buildBenchmarkIndex`, `applyBenchmarkEnrichment` names consistent across Tasks 1, 2, 3. ✅

**Placeholder scan:** None found — every step has complete code.

**Coverage numbers cited:** 72.6% any-benchmark / 53.3% AA-indices are script-verified (measured during brainstorm). Parity floors set at 65% / 48% to leave headroom for catalog drift without flapping.
