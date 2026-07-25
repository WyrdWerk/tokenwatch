# Canonicalization Edge Cases

> Read this before touching `shared/normalize.mjs`, `public/app.js`'s
> `canonicalModelId`, or `functions/api/v1/[[route]].js`.

## Source of truth

**Canonical:** `shared/normalize.mjs` — `canonicalId()` and `orgLookupKey()`.
Pure ESM, zero `node:` imports, Worker-bundleable. This single module is imported by:

- the Node pipeline (via `scripts/lib.mjs` re-export),
- the Cloudflare Pages Function (`functions/api/v1/[[route]].js`).

**Lock:** `test/canonicalization.test.mjs` — 18 tests pinning the behavior of both
functions (`canonicalId` + `orgLookupKey`) against a fixed input corpus. Any change
to canonicalization MUST keep these tests green; if behavior is intended to change,
the test is the spec and must be updated in the same commit.

**Known duplication (parity-guarded, not unguarded):** `public/app.js` ships a
client-side `canonicalModelId()` (defined near `public/app.js:300`) that
re-implements `canonicalId()` for the datalist typeahead. It is NOT imported from
`shared/normalize.mjs` (the static frontend has no bundler — see ADR 0001). The
duplication is intentional and **guarded by `test/parity.test.mjs:56-89`**, which
vendors a verbatim copy of the frontend function and asserts it matches
`canonicalId()` over a fixed 12-input case list. The guard has limits — see Edge
Case 10 and ADR 0010 before changing canonicalization. `shared/normalize.mjs` is
the single source of truth; the frontend copy and the test's embedded copy are
both mirrors.

---

## 1. `-preview-customtools` preserved (the bug that made canonicalId the SSoT)

**Where:** `shared/normalize.mjs` — `canonicalId()`; regression test
`test/canonicalization.test.mjs`.
**The trap:** A naive `-preview-.*$` catch-all would strip `-preview-customtools`
from `google/gemini-3.1-pro-preview-customtools` and collapse it onto
`gemini-3.1-pro` — two distinct models (`gemini-3.1-pro-preview-customtools` vs
`gemini-3.1-pro`) becoming one in `/models/:id/providers`.
**Handling:** `canonicalId` preserves the `-customtools` suffix; only dated
preview patterns (`-preview-MM-YYYY`, `-preview-YYYY-MM-DD`, `-preview-MM-YY`)
and bare `-preview` are stripped.
**Regression test:** `test/canonicalization.test.mjs` — the `-preview-customtools`
preserved case. Also guarded in `test/parity.test.mjs:79`
(`'google/gemini-3.1-pro-preview-customtools'` in the fixed case list).
**Why it matters:** This is the precedent. A prior API-local `normalizeId` in
`functions/api/v1/[[route]].js` got this wrong, which is why it was retired and
`shared/normalize.mjs` became the single source of truth (ADR 0003). Any second
copy of canonicalization is exposed to the same class of bug — which is exactly
why the frontend duplication is parity-guarded (Edge Case 10).

## 2. Quantization in the dedup key; `orgLookupKey` is org-resolution-only

**Where:** `shared/normalize.mjs` — `canonicalId()` (lines 30-32) and
`orgLookupKey()` (lines 49-53); dedup caller `scripts/lib.mjs:161-175`.
**The trap:** The two functions diverge **intentionally**, and dedup uses
`canonicalId` — NOT `orgLookupKey`. `canonicalId` keeps quant suffixes
(`-fp8`, `-nvfp4`, `-int4`, `-bf16`, etc.), so `dedupKey()` in `scripts/lib.mjs:162`
(`${canonicalId(m.id)}|${normalizeProvider(m.provider)}`) produces **distinct
keys for different quants** — they stay distinct rows. `orgLookupKey` strips
quant + tier (`-long`) so quants of the same model group under one org/model for
**org resolution** — it is NOT used for dedup (`normalize.mjs:52`: "Used ONLY
for org resolution — not for dedup or model display"). An agent must not "unify"
the two functions, and must not route dedup through `orgLookupKey`.
**Handling:** Two separate functions; dedup calls `canonicalId` (quant preserved);
org cross-referencing calls `orgLookupKey` (quant stripped).
**Regression test:** `test/canonicalization.test.mjs:88-97` —
"canonicalId preserves quantization suffixes baked into the ID" (asserts
`glm-5.2-fp8` ≠ `glm-5.2-nvfp4`; comment: "distinct model entries — NOT
collapsed by dedup"). `test/canonicalization.test.mjs:106-113` —
"orgLookupKey strips quantization suffixes that canonicalId keeps".
**Why it matters:** Routing dedup through `orgLookupKey` would collapse distinct
quant rows into one (breaking the catalog). Routing org resolution through
`canonicalId` would split one model's quants across orgs (breaking org counts).
The divergence is the contract.

## 3. `:free` / `:thinking` suffix strip

**Where:** `shared/normalize.mjs` — `canonicalId()`.
**The trap:** These provider suffixes are pricing/feature flags (`:free`,
`:thinking`), not model identity. If kept, the same model would appear as two
distinct canonical IDs.
**Handling:** Stripped in canonicalization.
**Regression test:** `test/canonicalization.test.mjs`; also in
`test/parity.test.mjs:74-75` (`'openai/gpt-4:free'`, `'qwen/qwen3:thinking'`).
**Why it matters:** Keeping the suffix would split a model into free/paid or
thinking/non-thinking rows in the catalog.

## 4. Date-format normalization

**Where:** `shared/normalize.mjs` — `canonicalId()`.
**The trap:** Multiple date suffix patterns denote dated preview/release
variants. Without normalization, each yields a distinct ID. The supported
patterns (per `normalize.mjs:21-22`, the implementation — no others):
- `-YYYY-MM-DD` (e.g. `-2024-08-06`, `-2025-01-30`)
- `-YYYYMMDD` 8-digit (e.g. `-20260420`, `-20250130`)
- `-YYMMDD` 6-digit (e.g. `-250712`, `-241130`)
- Preview-dated: `-preview-MM-YYYY` (`-preview-09-2025`),
  `-preview-YYYY-MM-DD` (`-preview-2024-08-06`), `-preview-MM-YY`
  (`-preview-05-06`)
Note: bare 4-digit years (`-2024`, `-0125`) are NOT supported patterns —
do not add them; they would mis-strip model version numbers.
**Handling:** Each supported pattern matched and stripped to one canonical form.
**Regression test:** `test/canonicalization.test.mjs:34-47` (the three date
patterns) and `56-66` (the three preview-dated patterns); mirrored in
`test/parity.test.mjs:76-83`.
**Why it matters:** Inconsistent date handling fragments the same model across
rows; over-aggressive stripping collapses genuinely distinct dated releases —
which is why the pattern list is closed, not open to ad-hoc additions.

## 5. Per-provider bespoke normalizers

**Where:** `shared/modelsdev.mjs` — `PROVIDER_MAP` (48 entries) + 4 hand-written
normalizers.
**The trap:** Cloudflare, Amazon Bedrock, Fireworks, and Minimax expose native
model IDs that don't follow the common pattern. A generic normalizer mis-keys
them in models.dev enrichment.
**Handling:** Each of the four has a bespoke normalizer because their IDs are
structurally different from the rest.
**Regression test:** `test/modelsdev-normalizers.test.mjs`.
**Why it matters:** A "simplification" that removes the bespoke normalizers
silently breaks enrichment for those four providers' models.

## 6. Bounded-fuzzy subset matching (models.dev Tier B)

**Where:** `shared/modelsdev.mjs` — two-tier matcher.
**The trap:** When exact (Tier A) match fails, models.dev falls back to a
**bounded** fuzzy subset match — not open-ended fuzzy. Open-ended fuzzy would
false-match across model families.
**Handling:** Bounded subset rule; exact-first with fallback only within the bound.
**Regression test:** `test/modelsdev-enrichment.test.mjs`;
`test/parity.test.mjs:118` (coverage floor ≥35%).
**Why it matters:** Loosening the bound increases coverage at the cost of
incorrect enrichments; tightening it drops coverage. The bound is the
calibrated tradeoff (ADR 0004).

## 7. Conservative benchmark base-key stripping

**Where:** `shared/benchmarks.mjs` — `conservativeBase()` vs `baseKey()`.
**The trap:** `conservativeBase()` strips only trailing quant + SKU suffixes;
`baseKey()` additionally strips variant suffixes. The conservatism is deliberate
— aggressive stripping over-matches benchmarks across distinct model variants.
**Handling:** Two functions with different stripping aggressiveness, used at
different stages.
**Regression test:** `test/benchmarks.test.mjs`;
`test/parity.test.mjs:160-174` (coverage floors ≥65% any, ≥48% AA).
**Why it matters:** "Simplifying" to one aggressive stripper silently attaches the
wrong benchmark to variant models.

## 8. AA collision preference

**Where:** `shared/benchmarks.mjs` — `buildBenchmarkIndex()` /
`applyAAEnrichment()`.
**The trap:** When two Artificial Analysis indices match one model, an
unambiguous preference rule must pick the winner or enrichment is non-deterministic.
**Handling:** Documented preference order in the index builder.
**Regression test:** `test/aa-enrichment.test.mjs`.
**Why it matters:** Removing the preference makes enrichment order-dependent and
non-reproducible across runs.

## 9. `falCanonicalId` modality-suffix logic

**Where:** `scripts/fetch-fal.mjs` — `falCanonicalId()`.
**The trap:** fal.ai preserves nested endpoint identity (modality suffix) that
`canonicalId` would strip — because fal's image/video endpoints are distinct
despite sharing a base model.
**Handling:** Separate `falCanonicalId` that preserves modality; fal.ai is a
Tier-1 source for image/video, prepended to OpenRouter rows and deduped with
Tier-1 precedence (ADR 0007). It is NOT a post-dedup sidecar on the text pipeline.
**Regression test:** `test/fal-canonicalization.test.mjs`;
`test/parity.test.mjs:192-227` (fal image/video presence + schema).
**Why it matters:** Routing fal.ai through `canonicalId` would collapse distinct
image/video endpoints onto their base model.

## 10. Frontend `canonicalModelId()` parity (guarded, with limits)

**Where:** `public/app.js` — `canonicalModelId()` (near `public/app.js:300`;
mirror of `shared/normalize.mjs` — `canonicalId()`); guard at
`test/parity.test.mjs:56-89`.
**The trap:** Two independent implementations of the same normalization. Change
`shared/normalize.mjs` without mirroring in `public/app.js` → the typeahead
suggests IDs the API won't recognize. This is the `-preview-customtools` class
of bug (Edge Case 1) that retired API-local `normalizeId`.
**Handling — the guard and its limits:** An automated parity guard EXISTS at
`test/parity.test.mjs:56-89`. It works by **vendoring a verbatim copy** of
`public/app.js`'s `canonicalModelId` as an inline function `appCanonicalId` (test
lines 57-70) and asserting it equals `canonicalId()` (imported from
`shared/normalize.mjs`) over a **fixed 12-input case list** (test lines 71-84).

Two limits of this mechanism:

1. **No execution of `public/app.js`.** The test compares a *copy* against the
   shared module. If someone edits the live `public/app.js`'s `canonicalModelId`
   in a way that diverges from the test's embedded copy, the test still passes —
   CI sees only the embedded copy, not the live file.
2. **Fixed case list.** A canonicalization rule that diverges only on an input
   *outside* the 12 cases passes parity while drifting in production.

**Regression test:** `test/parity.test.mjs:56-89` —
"app.js canonicalModelId() matches shared canonicalId() for key inputs".
Also: "every model produces a non-empty canonical key" (42-51) and the
gemini-3.1-pro non-collapse guard (17-41).
**Why it matters — three-way sync, not two:** changing `canonicalId` requires
updating `shared/normalize.mjs`, `public/app.js`, **and** the verbatim copy
embedded at `test/parity.test.mjs:57-70` in the same commit. Updating only the
first two leaves the test asserting against a stale reference. Updating the
test's copy without updating `public/app.js` makes the test green while the
live frontend drifts — the most dangerous failure mode, since CI reports
success. Strengthening the guard (importing the live `public/app.js`, or
expanding the corpus) is a code change, out of scope here — see ADR 0010.
