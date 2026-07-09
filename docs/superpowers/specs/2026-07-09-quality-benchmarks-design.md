# Quality benchmark enrichment — design spec

**Date:** 2026-07-09
**Status:** Draft (awaiting user review)
**Author:** brainstormed with user

## Problem

TokenWatch surfaces pricing and reliability but no quality signal. Users cannot answer "which is the best coding model under $1/M?" or "is this cheap model actually good?" — they must leave the site to check Artificial Analysis or LMArena manually.

## Opportunity (verified by script)

OpenRouter's `/api/v1/models` endpoint exposes a `benchmarks` field on **158 of 343 models (46%)**. It contains:

1. **`artificial_analysis` indices** — `{ intelligence_index, coding_index, agentic_index }` (0–100 scale, higher = better). On 92 models.
2. **`design_arena`** — array of `{ arena, category, elo, win_rate, rank }` entries. On 148 models.

This is the exact Artificial Analysis data we wanted, proxied through OpenRouter's unauthenticated public API — no key needed. (The `ARTIFICIAL_ANALYSIS_API_KEY` in GitHub secrets is reserved for a future direct-AA integration if their private API becomes usable; we could not find a public endpoint.)

## Coverage (script-verified)

Measured against our 919 text-model rows with **conservative matching** (strip only trailing quant suffixes `-fp8|-nvfp4|-int4|...` and SKU suffixes `-turbo|-fast|-highspeed`; no size-token or version-bit stripping — those create misattribution risk):

| Benchmark type | Coverage | % of 919 |
|---|---|---|
| Any benchmark (AA indices OR design_arena) | **667** | **72.6%** |
| Artificial Analysis indices specifically | 490 | 53.3% |
| Design arena Elo specifically | 541 | ~58.9% |

Meets the user's 70% coverage bar. The ~27% unscored are legitimately unranked older/community/specialty models (Llama 3.1 era, DeepSeek V3, Seed, Nemotron, community fine-tunes like Lunaris/Euryale/MythoMax). They render with empty cells.

## What we will NOT do

- **Speed/performance data (latency, throughput)** — measured at 0% coverage across 112 endpoints sampled from 40 models. OpenRouter exposes the fields but populates them on no endpoints today. Parked until a direct AA API is available.
- **Aggressive base-model inference** — strips size tokens and version bits, reaches 75% but creates false matches (e.g. `Qwen3-30B-A3B → qwen3` misattributes). Not worth the correctness risk for 2 extra percentage points.
- **Direct Artificial Analysis API integration** — their public API endpoint could not be found (404 on all probed paths; no docs link on homepage). The OR proxy covers the need.
- **Reasoning config display** — queued as a separate future enhancement (205 models have reasoning metadata; pure display, no math). Not in this spec.

## Design

### Data capture

New fields in `pricing.json`, added during the fetch pipeline:

```js
// Per text model row:
{
  id: "z-ai/glm-5.2",
  // ...existing fields...
  benchmarks: {
    intelligence_index: 68.2,   // 0–100, or null if unscored
    coding_index: 74.1,
    agentic_index: 51.3,
    design_arena_best: {         // highest-Elo design_arena entry, or null
      category: "codecategories",
      elo: 1329,
      win_rate: 58,
      rank: 5
    }
  }   // or omitted entirely if no benchmark data matched
}
```

**Flattened structure** (not nested OR blobs) for three reasons: (a) smaller JSON, (b) trivially queryable by the API layer with `?sort=intelligence`, (c) frontend renders without reshaping. We pick the single best design_arena entry (highest Elo) to avoid array proliferation.

### Matching algorithm (conservative)

Implemented in a new `shared/benchmarks.mjs` pure module (mirrors the `shared/normalize.mjs` + `shared/modelsdev.mjs` pattern):

1. Build index `Map<canonicalBase, benchmarks>` from OR `/models` where `benchmarks` is non-empty.
2. For each of our text models: compute `conservativeBase(id)` = `canonicalId(id)` then strip trailing `-(fp8|fp16|bf16|int8|int4|nvfp4|awq|gptq|mxfp4|f16)` and trailing `-(turbo|fast|highspeed)`.
3. Look up the index. If hit, attach `benchmarks` block.
4. On collision (two OR models map to same base), prefer the entry with `artificial_analysis` indices (richer signal).
5. Log matches at fetch time: `Benchmark enrichment: X models matched (Y with AA indices, Z with design_arena only)`.

**Collision edge case:** `glm-5.2` and `glm-5.2-fp8` both canonicalize to `glm-5.2` after quant-strip. Both get the same benchmark. This is correct — same base model, same quality.

### Pipeline integration

In `scripts/fetch-pricing.mjs`, after the models.dev enrichment pass (existing pattern at ~line 834):

```js
import { applyBenchmarkEnrichment } from './lib.mjs';  // re-export from shared/benchmarks.mjs

// ...in main(), after applyEnrichment():
const benchIndex = await fetchBenchmarkIndex();  // already-fetched OR /models data, reuse
applyBenchmarkEnrichment(out.models, benchIndex);
```

The OR `/models` response is already fetched by the pipeline (for text-model filtering). We extract `benchmarks` from it without an extra HTTP call.

### API

New sort keys on `/api/v1/models`:
- `?sort=intelligence` — by `benchmarks.intelligence_index` desc, nulls last
- `?sort=coding` — by `benchmarks.coding_index` desc, nulls last
- `?sort=agentic` — by `benchmarks.agentic_index` desc, nulls last

New filter:
- `?benchmarked=true` — only rows with a non-empty `benchmarks` block

Model objects in the API response include the `benchmarks` block when present.

### Frontend

**New column: Quality** in the text-tab results table, positioned after Provider and before Input. Renders:
- **If AA indices present:** three mini-badges in one cell — `I: 68` · `C: 74` · `A: 51` (color-coded: green ≥70, yellow 50–69, gray <50). Tooltip shows full scale label.
- **Else if design_arena present:** single badge `🎨 1329` (Elo) with tooltip `Design Arena · codecategories · rank 5 · 58% win rate`.
- **Else:** empty cell (no dash — the table already uses space-efficient rendering).

**New sort:** clicking the Quality column header cycles through `intelligence:desc → coding:desc → agentic:desc → off`. A small sub-menu could clarify, but cycling is simpler and matches no existing multi-axis column in the UI.

**Mobile:** the Quality cell becomes a card row labeled "Quality" via `data-label` (existing mobile pattern).

**No benchmark filter toggle** in v1 — the empty-cell rendering is sufficient. (Users who want only-scored models can use the API `?benchmarked=true` filter or sort by Quality which pushes empty cells to the bottom.)

### Value-per-dollar derived stat (stretch goal for v1, likely v2)

The compelling derived metric is **intelligence per dollar** = `intelligence_index / (input_$/M + output_$/M)`. This enables "best bang for buck" queries. *Math flag:* division of two floats — trivial but must be validated with real numbers before shipping. Defer to v2 unless the benchmark-column ship goes smoothly and we want to extend in the same session.

## Components

| Component | File | Purpose |
|---|---|---|
| Pure matcher | `shared/benchmarks.mjs` (NEW) | `conservativeBase()`, `buildBenchmarkIndex()`, `applyBenchmarkEnrichment()`. No `node:` imports (Worker-safe). |
| Pipeline hook | `scripts/fetch-pricing.mjs` (MODIFIED) | Call `applyBenchmarkEnrichment()` after models.dev pass. Log coverage. |
| Lib re-export | `scripts/lib.mjs` (MODIFIED) | Re-export benchmark helpers (mirrors normalize/modelsdev pattern). |
| API | `functions/api/v1/[[route]].js` (MODIFIED) | New sort keys (`intelligence`, `coding`, `agentic`), new filter (`benchmarked`), include `benchmarks` in response. |
| Frontend | `public/index.html`, `public/app.js`, `public/styles.css` (MODIFIED) | New Quality column, sort cycling, badges, mobile card row. |
| Tests | `test/benchmarks.test.mjs` (NEW) | Conservative matching regressions: quant-strip, turbo-strip, no-over-strip (Qwen3-30B stays distinct), collision preference (AA-wins). |
| Parity guard | `test/parity.test.mjs` (MODIFIED) | Add regression: benchmark coverage floor (e.g. ≥65% any-benchmark, ≥48% AA — leaves headroom for catalog drift). |
| Docs | `AGENTS.md` (MODIFIED) | Document benchmarks field, matching algorithm, conservative-strip rationale. |

## Error handling

- **OR `/models` fetch fails:** benchmark enrichment is non-fatal (existing resilience pattern). Models ship without benchmarks; log a warning.
- **Malformed `benchmarks` blob:** per-model try/catch in `applyBenchmarkEnrichment()`. Skip the model, continue.
- **Coverage drop:** log but don't abort (unlike pricing data, benchmarks are optional enrichment). Parity test catches gross regressions.

## Testing strategy

1. **Unit tests** (`test/benchmarks.test.mjs`):
   - `conservativeBase('z-ai/glm-5.2-fp8')` → `'glm-5.2'` (quant strip)
   - `conservativeBase('anthropic/claude-sonnet-5-turbo')` → `'claude-sonnet-5'` (SKU strip)
   - `conservativeBase('qwen/qwen3-30b-a3b')` → `'qwen3-30b-a3b'` (NO size strip — stays distinct)
   - `conservativeBase('qwen/qwen3-coder-480b-a35b-instruct-turbo')` → `'qwen3-coder-480b-a35b-instruct'` (only trailing turbo stripped)
   - Collision preference: when base `glm-5.2` has entries with and without AA, the AA one wins
   - Empty benchmarks blob → no match, no crash
2. **Integration:** run the fetcher, assert ≥65% coverage on the resulting `pricing.json`.
3. **Parity guard:** `test/parity.test.mjs` asserts coverage floor against real `pricing.json`.
4. **API tests:** extend `test/api.test.mjs` with `?sort=intelligence` and `?benchmarked=true` cases.
5. **Manual:** local serve, verify Quality column renders, sorting works, mobile card layout intact.

## Open questions for user review

1. **Quality column position** — I propose after Provider, before Input. Alternative: as the last column (after Uptime). Preference?
2. **Design_arena rendering** — I propose a single best-Elo badge with `🎨` prefix. Is the emoji too informal? Alternative: plain `DA 1329`.
3. **Sort cycling UX** — clicking Quality cycles I→C→A→off. Is this discoverable enough, or should we add a tiny sub-dropdown? (Cycling is simpler and I'd ship it first.)
4. **Value-per-dollar** — defer to v2 (my recommendation) or include in v1?

## Build sequence (high-level — detailed plan comes from writing-plans skill)

1. `shared/benchmarks.mjs` + tests (pure module, fully testable in isolation)
2. Pipeline integration + coverage logging
3. API sort/filter
4. Frontend column + badges + sort cycling
5. Parity guard
6. Docs
7. Local verify, push, deploy
