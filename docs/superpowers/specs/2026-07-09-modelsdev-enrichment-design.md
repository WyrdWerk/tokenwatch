# models.dev Enrichment Layer — Design Spec

**Date**: 2026-07-09
**Status**: Approved (brainstorm phase complete; pending implementation plan)
**Author**: Brainstorm session, reviewed with project owner

## Problem

TokenWatch's text-model catalog (920 models across 75 providers) is sourced from OpenRouter's de-aggregated `/endpoints` API plus 3 direct providers and 4 manual/CSV providers. Each row carries pricing and basic metadata, but lacks three things users configuring an SDK need:

1. **The provider's base URL** (e.g. `https://api.fireworks.ai/inference/v1`)
2. **The native model ID** for that provider's API (not OpenRouter's `org/model` slug)
3. **Capability metadata** (reasoning, tool call, modalities, knowledge cutoff)

[models.dev](https://models.dev) is a community-maintained database of AI model specs that carries exactly these fields for 152 providers / 5,379 models, exposed via a single unauthenticated JSON endpoint (`https://models.dev/api.json`).

## Decision

Integrate models.dev as a **sidecar enrichment source** — not a replacement for OpenRouter. It runs after the existing 3-tier fetch, decorates TW model rows with connection + metadata fields, and fills `null` cache/context values. OpenRouter remains the catalog backbone.

Three foundational decisions locked during brainstorm:

1. **Enrichment layer** (not "replace OpenRouter", not "hybrid primary"). models.dev covers only 48 of TW's 75 providers at the provider-slug level and has genuinely empty entries for some (e.g. DeepInfra has 0 models on MD). Full replacement would lose 63% of the catalog.
2. **Invest in full provider reconciliation**. The bottleneck turned out not to be the provider map but model-ID format differences — resolvable with per-provider normalizers.
3. **Build per-provider ID normalizers**. models.dev uses each provider's native ID convention (e.g. Fireworks `accounts/fireworks/routers/kimi-k2p6-turbo`, Bedrock `global.anthropic.claude-haiku-4-5:0`), which differs from OpenRouter's `org/model` convention.

## Data findings (verified against real data)

- **Coverage**: 97.3% of TW models exist on models.dev under *some* provider. Only **25 models** are truly absent, and most of those are explainable artifacts (DeepInfra `-Turbo` variants, `syn:large:text` routing aliases, quant-suffixed CSV entries like `glm-5.2-nvfp4`).
- **Same-provider join** (strict): 340/920 (37%) — limited by model-ID format mismatch, not provider absence.
- **Cache field delta** (strict same-provider, never-overwrite fill):
  - `cache_read`: 574 → 585 (+11 filled, 38 disagreements logged where TW value kept)
  - `cache_write`: 65 → 104 (+39)
- **Pricing uniqueness confirmed**: models.dev stores exactly one `cost` object per `(provider_id, model_id)`. No ranges. Multiple prices for "the same model from the same company" exist only as distinct provider entries (PAYG vs subscription plan, different region) — correctly modeled as different rows, not same-row ambiguity.
- **Size impact**: ~700 enriched models × ~350 bytes = ~250KB added to pricing.json (currently ~1.5MB).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  EXISTING (unchanged)                                       │
│  Tier 1 (direct)  ─┐                                       │
│  Tier 2 (OR deagg) ┼──► dedupModels ──► tieredModels       │
│  Tier 3 (CSV/hard) ─┘                 (920 rows)           │
└──────────────────────────────────────────────────────┬──────┘
                                                       │
┌──────────────────────────────────────────────────────▼──────┐
│  NEW: models.dev enrichment pass                            │
│                                                            │
│  1. Fetch https://models.dev/api.json (3MB, 1 call)        │
│  2. Index by (normalizedProvider, normalizedModelId)        │
│  3. For each TW row, Tier A exact then Tier B fuzzy match   │
│  4. Merge enrichment fields (never overwrite existing)      │
│  5. Emit pricing.json with optional `modelsdev` block       │
└──────────────────────────────────────────────────────┬──────┘
                                                       │
                                                       ▼
                                              public/pricing.json
```

**Design principles:**

1. **Non-destructive**: existing pricing/limits fields are never overwritten. models.dev only fills `null` values. If both sources have a value, TW's wins; the disagreement is logged.
2. **Sidecar, not a 4th tier**: models.dev is a metadata source, not an inference provider. Treating it as enrichment keeps the tier model clean (tiers = "where you send API calls").
3. **Pure shared module**: `shared/modelsdev.mjs` holds the provider map + normalizers + matcher. No `node:` imports (same constraint as `shared/normalize.mjs`) so it could later be imported by the Cloudflare Worker.
4. **Non-fatal on failure**: if models.dev is unreachable or malformed, the pipeline continues with zero enrichment. Same pattern as the existing ZDR-endpoint handling.

### Pipeline integration

Two additions to `main()` in `scripts/fetch-pricing.mjs`, after `dedupModels` and before `writeFile`:

```js
const mdEnrichment = await fetchModelsDevEnrichment(tieredModels);
applyEnrichment(tieredModels, mdEnrichment);
```

`fetchModelsDevEnrichment` (in new `scripts/fetch-modelsdev.mjs`) does the single API call, builds the index, and returns an enrichment map keyed by `(provider, normalizedId)`. `applyEnrichment` is a deterministic merge respecting the never-overwrite rule. Both are skipped in `--dry-run` (which prints projected counts instead).

## Per-provider ID normalizers

Five distinct ID-format patterns observed across providers. The normalizer registry handles them with minimal code:

| Pattern | Providers | Example transform |
|---|---|---|
| Org-prefix only (canonicalId handles) | ~28 of 48 matched | `moonshotai/kimi-k2.7-code` ↔ `kimi-k2.7-code` → `kimi-k2.7-code` |
| Vendor path prefix | cloudflare | `@cf/moonshotai/kimi-k2.7-code` → strip `^@cf/` → canonicalId |
| Dot-separated namespacing | amazon-bedrock | `global.anthropic.claude-haiku-4-5-20251001-v1:0` → strip region + `:N` → `claude-haiku-4-5` |
| Brand prefix duplicated | minimax | `MiniMax-M2.5-highspeed` → strip leading `minimax-` brand → `m2.5-highspeed` |
| Deep namespacing + version encoding | fireworks | `accounts/fireworks/routers/kimi-k2p6-turbo` → strip prefix + `p`→`.` → `kimi-k2.6-turbo` |

**SKU preservation rule**: brand/quant/variant suffixes (`-turbo`, `-fast`, `-nvfp4`, `-highspeed`) are preserved as distinct entries. They represent genuine pricing/throughput differences. The normalizer only transforms structural prefixes and version punctuation, never SKU suffixes. (This was a design correction caught during review — the original draft stripped these, incorrectly.)

### Matcher design (two-tier)

```js
// shared/modelsdev.mjs
export function findEnrichment(twProvider, twModelId, providerIndex) {
  const providerMap = providerIndex.get(twProvider);
  if (!providerMap) return null;

  // Tier A: exact normalized match
  const exactNorm = normalizeForMatch(twProvider, twModelId);
  if (providerMap.has(exactNorm)) {
    return { ...providerMap.get(exactNorm), confidence: 'high' };
  }

  // Tier B: bounded fuzzy fallback
  const fuzzy = boundedFuzzyMatch(exactNorm, [...providerMap.keys()]);
  if (fuzzy) {
    return { ...providerMap.get(fuzzy), confidence: 'medium' };
  }
  return null;
}
```

### Tier B fuzzy rules (locked decisions)

- **Same-provider only**: a Fireworks TW row only fuzzy-matches against `fireworks-ai` models on MD. Never borrows a match from a different provider. This is the hard rule that prevents the wrong-URL problem (the source of the 126 false "conflicts" observed in early data exploration).
- **Subset-only**: the shorter tokenized set must be a strict subset of the longer. Captures suffix-additions (`kimi-k2.7-code` → `kimi-k2.7-code-fast`) but not spelling/casing drift.
- **2-token floor**: refuse to fuzzy-match if either side has fewer than 2 tokens. Prevents `o3` from matching `o3-mini`.
- **Single-candidate requirement**: if the fuzzy match produces more than one candidate on the same provider, refuse. Ambiguity means no match.
- **Tokenization**: split on `[-_./]`.

### Yield projection

| Bucket | Count | Notes |
|---|---|---|
| Tier A (exact normalized) | ~658 (71.5%) | 340 current + ~318 recovered via normalizers |
| Tier B (fuzzy subset) | ~42 (4.6%) | Bounded by single-candidate rule |
| Unmatched | ~220 (23.9%) | DeepInfra (0 MD models), 27 provider-absent, SKU variants |

Combined: **~76% of the catalog enriched**. The rest stay unenriched — no harm, just no bonus metadata. The pipeline log surfaces unmatched-by-provider counts to guide future normalizer investments.

## Enrichment schema (locked decisions)

A new optional `modelsdev` block on each model object in `pricing.json`. Present only when enrichment succeeds (Tier A or Tier B). Never present on unmatched models.

```json
{
  "id": "moonshotai/kimi-k2.7-code",
  "provider": "fireworks",
  "org": "moonshot",
  "name": "Kimi K2.7 Code",
  "pricing": { "input": 0.95, "output": 4.00, "cache_read": 0.19, "cache_write": null },
  "context_length": 262144,
  "max_completion_tokens": 262144,
  "zdr": true,
  "subscription": false,
  "modelsdev": {
    "base_url": "https://api.fireworks.ai/inference/v1",
    "model_id": "accounts/fireworks/routers/kimi-k2p7-code-fast",
    "doc_url": "https://docs.fireworks.ai/quickstarts",
    "confidence": "high",
    "source": "models.dev",
    "release_date": "2026-06-12",
    "knowledge_cutoff": "2025-01",
    "description": "Coding-focused Kimi model, stronger on long-horizon repo work",
    "capabilities": {
      "reasoning": true,
      "tool_call": true,
      "structured_output": true,
      "attachment": true,
      "temperature": true
    },
    "modalities": { "input": ["text", "image"], "output": ["text"] },
    "open_weights": true
  }
}
```

### Fields in the `modelsdev` block

**Tier 1 (always populated when block exists):**
- `base_url` — from MD provider `api` field. The primary user value: what to paste into SDK config.
- `model_id` — the native ID for that provider's API (not the OpenRouter slug).
- `doc_url` — MD provider `doc` field.
- `confidence` — `"high"` (Tier A) or `"medium"` (Tier B). Drives the ⚠ pill.
- `source` — constant `"models.dev"`. Auditability.

**Tier 2 (populated when MD has them):**
- `release_date`, `knowledge_cutoff`, `description`, `capabilities`, `modalities`, `open_weights`.

**Excluded deliberately:**
- `cost.input`/`cost.output` — TW already has authoritative pricing from a higher-precedence tier.
- `cost.cache_read`/`cache_write` — merged into existing `pricing` object via null-fill rule, not in this block.
- `limit.context`/`limit.output` — merged into existing `context_length`/`max_completion_tokens` via null-fill.
- `reasoning_options`, `family`, `name`, `last_updated` — low value or redundant.
- `logo_url` — **dropped** per locked decision (no logos).

### Cache/limits merge rule

For each of `pricing.cache_read`, `pricing.cache_write`, `context_length`, `max_completion_tokens`:
```
IF TW value is non-null → KEEP TW value (never overwrite)
ELSE IF models.dev value is non-null → FILL from models.dev
ELSE → leave null
```
Disagreements (both non-null, differ) are logged by the pipeline but not surfaced in the output. The frontend reads `pricing` and `context_length` unchanged — no consumer code needs to know whether a value came from OR or MD.

### Layout

```
Model object in pricing.json:
├── id, provider, org, name                  ← unchanged (TW identity)
├── pricing { input, output,                 ← values unchanged; cache_read/cache_write
│   cache_read, cache_write }                  may now be MD-sourced when OR had nulls
├── context_length, max_completion_tokens    ← may now be MD-sourced when null
├── quantization, zdr, subscription,
│   discount, uptime_30m                     ← unchanged
└── modelsdev { ... }                        ← NEW optional block
```

Additive and isolated. Existing API consumers, frontend, widget — none break.

## Frontend card UX (locked decisions)

**Click any model row → detail card opens.** The card surfaces `modelsdev` enrichment alongside existing model info. This is a new interaction pattern — rows aren't clickable today — implemented via the established event-delegation approach.

### Locked decisions

- **Whole row clickable**: click anywhere on a row opens the card. Compare checkbox isolated via `e.target.closest('.compare-check')` guard (same idiom as the existing `.group-header` guard). Visual affordance: `cursor: pointer` + subtle `›` indicator on the Model cell.
- **Text tab only at launch**: image/video cards deferred (different pricing shape, no MD enrichment for those catalogs).
- **⚠ pill for Tier B**: new `.approx-badge` CSS class, subtle pill on medium-confidence matches with `title="Matched by fuzzy logic against models.dev — verify before configuring."`.

### Card layout

```
┌──────────────────────────────────────────────────────────────┐
│  Kimi K2.7 Code                                       [✕]    │
│  Moonshot AI · via Fireworks                     ⚠ approx   │
│                                                              │
│  ── Connect ────────────────────────────────────────────     │
│  Base URL   https://api.fireworks.ai/inference/v1 [📋]      │
│  Model ID   accounts/fireworks/routers/kimi-k2p7-code [📋]  │
│  Docs       https://docs.fireworks.ai/quickstarts  ↗        │
│                                                              │
│  ── Pricing ($/M tokens) ───────────────────────────────    │
│  Input 0.95  Output 4.00  Cache read 0.19  Cache write —    │
│                                                              │
│  ── Capabilities ───────────────────────────────────────    │
│  ✓ reasoning  ✓ tool call  ✓ structured output              │
│  ✓ attachment  ✓ temperature                                 │
│  Input: text, image  →  Output: text                         │
│                                                              │
│  ── About ──────────────────────────────────────────────    │
│  Coding-focused Kimi model, stronger on long-horizon…       │
│  Released 2026-06-12 · Knowledge cutoff 2025-01             │
│  Open weights ✓                                              │
│                                                              │
│  [Add to compare]    [Open in OpenRouter ↗]                 │
└──────────────────────────────────────────────────────────────┘
```

### Implementation notes (verified against current code)

- **Markup**: new `.detail-modal` sibling to `.compare-modal` in `index.html`, mirroring structure exactly. `.detail-modal-content` narrower (`max-width: 560px`, `90vw` on mobile) since it's single-model.
- **Row click handler**: extends existing `els.resultsBody` click delegation (`app.js:359-368`). Reads `data-idx` (already present at `app.js:878`) to find model in `state.currentRows`.
- **Card rendering**: new `showDetailModal(idx)` function, same string-concatenation + `innerHTML` pattern as `showCompareModal` (`app.js:454-536`).
- **Sections rendered conditionally**: Section A (header) always; Section B (connect) only if `m.modelsdev`; Section C (pricing) always; Section D (capabilities) only if `m.modelsdev`.
- **Copy-to-clipboard**: new feature (`navigator.clipboard.writeText()`), consistent with codebase's modern-vanilla-JS style. Three copy buttons max (base_url, model_id, docs). `try/catch` with ✓/✗ feedback, no crash on unsupported browsers.
- **Close interactions**: backdrop click + ✕ button (mirrors compare modal) + Escape key (bonus fix — compare modal currently lacks this).
- **Accessibility**: `role="dialog" aria-modal="true" aria-labelledby="detailTitle"` on the modal (also added to compare modal as a pre-existing gap fix). Focus ✕ on open, restore focus to originating row on close.
- **Mobile**: works identically — same `<tr>` element exists in both table and card layouts. Card modal becomes `90vw` via media query.

### New CSS

- `.detail-modal*` — mirror of `.compare-modal*` with narrower content.
- `.approx-badge` — follows existing badge recipe (`styles.css:392` shape), `--yellow` color.
- `.copy-btn` — minimal borderless button, `📋` default, `✓`/`✗` on copy feedback.
- `.detail-section` — header-divider style for the four card sections.
- `tr[data-idx]` — `cursor: pointer` to signal clickability.

### No state persistence

The detail card does not persist to URL hash. Transient inspection view, like the compare modal (which also doesn't persist).

## Testing strategy

Zero-dep, extends the existing `node:test` suite (currently 4 files / 61 tests). Adds **2 new files + extends 1 existing file**, ~45 new tests.

### New: `test/modelsdev-normalizers.test.mjs` (~30 tests)

Pure unit tests for `shared/modelsdev.mjs`:
- Provider map: every entry resolves to real MD provider_id, round-trips, unknown gracefully falls back.
- Per-provider normalizers: each pattern tested with real IDs, including **SKU preservation regression guards** (e.g. `accounts/fireworks/routers/kimi-k2p6-turbo` → `kimi-k2.6-turbo`, NOT `kimi-k2.6`).
- Fuzzy matcher: Tier A exact, Tier B subset match, length-floor refusal, ambiguity refusal, non-subset refusal, cross-provider isolation.

### New: `test/modelsdev-enrichment.test.mjs` (~15 tests)

Integration tests for `applyEnrichment()` using small fixtures:
- Null-fill rule for `cache_read`, `cache_write`, `context_length`, `max_completion_tokens`.
- Never-overwrite: TW value kept when both present, disagreement logged.
- `modelsdev` block attached on Tier A and Tier B matches, absent on no-match.
- MD fetch failure (network error) → pipeline continues, zero enrichment, no crash.

### Extended: `test/parity.test.mjs` (+3 tests)

Regression assertions against real `pricing.json`:
- Enrichment coverage floor: `≥ 60%` of models have `modelsdev` block (catches a broken normalizer).
- `confidence` ∈ `{'high', 'medium'}` only.
- Every `modelsdev.base_url` starts with `https://`.

### Fixtures

- `test/fixtures/modelsdev-api.json` — miniature MD API response (~10 providers / ~30 models) crafted to exercise both tiers and all 5 normalizer patterns.

### Not tested (known limitation)

- **Frontend card rendering** — `app.js` is a non-module global script, can't be imported by `node:test`. Same gap as existing `video-audio.test.mjs`. Manual verification only; documented in test file header.

## Edge cases (exhaustive)

### Pipeline

| Case | Handling |
|---|---|
| MD API 4xx/5xx | Caught, logged, pipeline continues with zero enrichment |
| MD API malformed JSON | Caught by `fetchJson`, abort with clear error |
| MD provider listed but `models: {}` empty | Skipped silently (DeepInfra today) |
| MD model record has `cost: null` | `modelsdev` block still attached (no cache fills) |
| MD `cost.cache_write: 0` | `0` is a real value (e.g. Z.AI "free cache write"), distinct from `null`; filled into TW |
| TW model matches multiple MD plan/region variants | Map is explicit; subscription-plan variants are different `provider_id`s, won't match unless TW has that provider key |
| Tier A and Tier B both match | Tier A wins (returned first) |
| Tier B produces 2 candidates same provider | Refuse — no match (single-candidate rule) |

### Frontend

| Case | Handling |
|---|---|
| Row clicked while card open | Replaces card content (doesn't stack) |
| Card open + Escape | Closes card (+ compare modal as bonus fix) |
| `navigator.clipboard` unavailable | Copy button shows ✗ briefly, reverts; no crash |
| `modelsdev.doc_url` is null | Docs row omitted |
| `modelsdev.description` > 200 chars | Truncated with `…`, full text in `title` hover |
| Mobile card open | Works identically (same `<tr>` element) |
| Model has no `modelsdev` block | Card still opens, shows pricing + "Direct configuration not available" note + OpenRouter link |

### Data-quality

| Case | Handling |
|---|---|
| TW model ID casing/spacing unexpected | No match, logged in unmatched summary for future tuning |
| MD has two entries that normalize to same key | First wins, warning logged |
| MD renames a provider_id | One-line map update; same maintenance as existing `PROVIDER_NAME_MAP` |
| TW renames a provider slug | One-line map update |

## Monitoring / observability

Pipeline log gains a structured block per run:

```
[fetch-modelsdev] Fetched 5379 models across 152 providers (2.8MB, 847ms)
[fetch-modelsdev] Tier A (exact normalized):    658 / 920 (71.5%)
[fetch-modelsdev] Tier B (fuzzy subset):         42 / 920 (4.6%)
[fetch-modelsdev] Unmatched:                    220 / 920 (23.9%)
[fetch-modelsdev] Cache fills: cache_read +11, cache_write +39, context_length +8
[fetch-modelsdev] Price disagreements (TW kept): 38 cache_read, 4 cache_write
[fetch-modelsdev] Unmatched by provider (top 5): deepinfra=100, siliconflow=35, parasail=34, ...
```

Gives continuous visibility into match-rate health. If an MD schema change drops Tier A from 71% → 40%, CI logs surface it immediately. "Unmatched by provider" breakdown guides the next normalizer investment — making incremental work data-driven.

## Resilience safeguards

- **Non-fatal failure**: MD fetch failure never aborts the pipeline. Coverage-drop check unaffected (model count unchanged; enrichment is decoration only).
- **Dry-run support**: `--dry-run` prints projected Tier A/B counts without writing pricing.json.
- **Zero new runtime deps**: entire feature (normalizers, enrichment, card UI) is vanilla JS. Honors the project's hard constraint.

## Implementation phasing

The design supports incremental delivery:

**Phase 1 — Pipeline foundation (no UI):**
- `shared/modelsdev.mjs` (provider map + 5 normalizers + 2-tier matcher)
- `scripts/fetch-modelsdev.mjs` (single fetch + index + enrich)
- Pipeline integration in `fetch-pricing.mjs`
- `test/modelsdev-normalizers.test.mjs` + `test/modelsdev-enrichment.test.mjs` + `test/fixtures/modelsdev-api.json`
- Parity test extension
- Yield verification: confirm ~658 Tier A matches against real pricing.json

**Phase 2 — Frontend card:**
- `.detail-modal` markup in `index.html`
- `.detail-modal*` + `.approx-badge` + `.copy-btn` CSS in `styles.css`
- `showDetailModal()` + row-click delegation + Escape handler in `app.js`
- Copy-to-clipboard + accessibility attributes
- Bonus fixes: Escape on compare modal, `role=dialog` on both modals

**Phase 3 — Incremental tuning (ongoing):**
- Add normalizers for providers as miss patterns emerge from logs
- Tune Tier B thresholds if real-world false-positive rate is too high
- Consider porting card to image/video tabs if a future enrichment source covers those catalogs

## Out of scope

- Replacing OpenRouter as primary catalog source (decided against; would lose 63% of catalog)
- Logos (decided against)
- Image/video tab enrichment (models.dev has no image/video pricing)
- Surfacing cache-price disagreements in the UI (logged only)
- Historical tracking of models.dev changes
- MD data contributions / PRs back to models.dev (could be a separate community effort)

## Open questions for implementation

None blocking. The locked decisions cover all design questions raised during brainstorm. Implementation plan (next step) will sequence the work and surface any concrete code-level decisions.
