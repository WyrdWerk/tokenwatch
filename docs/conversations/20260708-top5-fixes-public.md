# TokenWatch — Top 5 Fixes Session (Public Conversation Record)

**Date**: 2026-07-08
**Repo**: [WyrdWerk/tokenwatch](https://github.com/WyrdWerk/tokenwatch)
**Live site**: https://tokenwatch.wyrdwerk.com
**Commit**: `b1634a6` — "fix: unify canonicalization, video audio filter, cache-busting, tests"

> This is a sanitized, publicly-shareable record of the full working session. It covers the audit, issue ranking, planning, implementation, and verification of the top 5 fixes applied to the TokenWatch codebase. No sensitive information (API keys, secrets, private infra details) is included.

---

## What TokenWatch is

[TokenWatch](https://tokenwatch.wyrdwerk.com) is a zero-dependency, pure-Node-ESM static site that compares pay-as-you-go LLM inference pricing across ~75 providers, plus separate image (34 models) and video (13 models) generation catalogs. Deployed to Cloudflare Pages with daily CI/CD refresh. The core innovation: OpenRouter's `/endpoints` API is de-aggregated so each backend (Fireworks, Together, Novita, SiliconFlow…) becomes its own row with its own pricing, rather than one generic "OpenRouter" row.

The pipeline has three tiers: (1) direct provider fetches (DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova), (2) OpenRouter de-aggregation, (3) CSV/hardcoded (Hyper, Makora, Xiaomimimo, OpenCode Go). Precedence is direct > OpenRouter > CSV. All prices normalized to USD per million tokens.

---

## Phase 0: Full codebase internalization

The session began with a request to internalize the repo end-to-end. Per the repo's own `AGENTS.md` "Delegation Gate" rule (investigation work requiring 3+ file reads must be delegated to `explore` subagents), four parallel explore subagents were dispatched:

1. **Data pipeline explorer** — read `scripts/fetch-pricing.mjs` (1056 lines), `scripts/lib.mjs`, `scripts/fetch-images.mjs`, `scripts/fetch-videos.mjs`, `data/manual-pricing.csv`, `package.json`. Mapped the 3-tier fetch flow, ZDR tagging (endpoint + provider level), pricing normalization per source, dedup/precedence, org extraction (5-step fallback), text-only filtering, and resilience safeguards.

2. **Frontend explorer** — read `public/app.js`, `public/image-app.js`, `public/video-app.js`, the three HTML files, and `styles.css`. Mapped state management, URL hash persistence, the percentage-based cost computation (`costFor`), cache-write amortization, Per Session vs Monthly (×30) modes, budget mode (inverse affordability), comparison mode (up to 6), group-by, search typeahead, filters, and the mobile table→card transform via `td[data-label]`.

3. **API/widget/CI explorer** — read `functions/api/v1/[[route]].js` (the entire API in one 441-line catch-all file), `public/widget/embed.js`, `.github/workflows/refresh-pricing.yml`, and the generated JSON files. Mapped the flat if-chain router, all `/models` filters and sort keys, the mix-aware cost sort on `/models/:id/providers`, the Shadow-DOM widget, and the two CI jobs (refresh + deploy).

4. **Docs/discussions explorer** — found and read all 11 prose artifacts: `AGENTS.md`, `README.md`, `TODO.md`, `SESSION-2026-07-05-enhancement.md`, and 7 session logs under `docs/conversations/` spanning 2026-07-04 to 2026-07-07. Extracted the complete developmental narrative from Phase 1 foundation through the most recent budget-mode/compare-mode/mobile-fix session.

**Result:** A comprehensive context briefing was delivered, covering the 3-tier pipeline internals, frontend state/cost/compare/budget mechanics, API routing and filter semantics, widget Shadow DOM architecture, CI/CD two-job structure, the complete session-log narrative, and the consolidated open-items list.

---

## Phase 1: Identifying the top 5 issues

The user asked for the "top five biggest headache-inducing issues" — things that would cause problems down the line. Two parallel verification subagents were dispatched to confirm candidate bugs against live code (not just trust the docs).

### Verification approach

The verification subagents were instructed to CONFIRM or REFUTE each candidate with concrete code evidence (file:line + quoted snippet), and to flag sub-claims that were actually handled. This discipline mattered — several initial assumptions were refuted:

- **Refuted:** "Wafer's `centsToDollars` (÷100) is wrong" — actually correct, the field is literally named `input_cents_per_million`.
- **Refuted:** "Direct providers don't check `res.ok`" — both `fetchJson` and `fetchJsonWithRetry` do check it.
- **Refuted:** "Coverage-drop check runs before dedup" — it runs after, which is correct (apples-to-apples).

### The verified top 5

1. **`normalizeId` (API) diverges from `canonicalId` (pipeline) — wrong models merged.** The pipeline's `canonicalId` uses specific date-shaped regexes and preserves unknown `-preview-<foo>` suffixes. The API's `normalizeId` uses a greedy `-preview-.*$` catch-all that over-strips. Concrete consequence: `/api/v1/models/gemini-3.1-pro/providers` returns 3 distinct Google models merged as "providers of the same model" (pro + pro-preview + pro-preview-customtools). Silently wrong output from the public API today.

2. **Duplicated, diverged utilities between `fetch-pricing.mjs` and `lib.mjs`.** `fetch-pricing.mjs` does zero imports from `./lib.mjs` — it re-declares the entire surface inline. The copies drifted: `ORG_ALIASES` has 11 keys in fetch-pricing vs 17 in lib (lib adds `alibaba`, `x-ai`, etc.); `PROVIDER_NAME_MAP` has 49 vs 55. `checkCoverageDrop` is implemented twice. This is the root cause of #1 — two sources of truth for canonicalization.

3. **Video audio filter silently drops 58% of the catalog.** `video-app.js:172` does `String(p.audio) !== state.audioFilter`. `String(null) === "null"` matches neither `"true"` nor `"false"`, so 22 of 38 pricing entries — including 8 entire models (Sora 2 Pro, Grok Imagine, Wan 2.6/2.7, Hailuo 2.3, etc.) — vanish under either audio filter.

4. **Manual `?v=` cache-busting strings — already caused one documented "code bug" mirage.** 6 hand-edited references across 3 HTML files, no automation. The 2026-07-05 session log (Lesson #7) documents: "Stale browser cache masquerading as code bug: No cache-busting on script tags caused old 9-cell JS against new 10-col HTML." Someone spent time debugging a phantom bug that was just stale cache.

5. **Zero automated tests + no lint/typecheck anywhere.** No test files, no `test` script, no test framework, CI runs no verification. This is what made #1–#4 possible.

### Honorable mentions (verified but lower severity)

- Mix-percent normalization mismatch (widget renormalizes to 100, API + apps apply verbatim) — only triggers on hand-crafted non-100 mixes.
- Sort key silent-fallback (invalid `sort=price` → silently becomes `id`, HTTP 200, no warning) — only affects third-party API consumers; the in-repo apps sort client-side.
- Coverage-drop check is per-run, not cumulative — two consecutive 14% drops bypass the 15% guard.
- Synthetic `cache_read = input × 0.20` — undocumented hardcoded multiplier.

---

## Phase 2: Planning the fixes

The user asked for an extensive plan with assumptions verified against docs. Two more parallel verification subagents gathered precise implementation details:

- **Exact canonicalization code** for all three copies, with a suffix-stripping diff table showing the single behavioral divergence (`-preview-<anything-else>`).
- **Code-sharing architecture** — confirmed that Cloudflare Pages Functions ARE esbuild-bundled and follow relative imports outside `functions/`, but `node:fs` in the imported module breaks the Workers bundle unless `nodejs_compat` is enabled (verified via Cloudflare docs, Stack Overflow, and GitHub issues). This meant the shared module must be pure (no `node:` imports).
- **Video audio data** — counted 22 null-audio entries out of 38 total; confirmed 8 models have null as their ONLY pricing entry and would completely disappear.
- **CI workflow structure** — confirmed Node 22 in CI, no test step, `deploy` job has no `setup-node`.
- **Doc-stated constraints** — confirmed zero-dependency is a hard, repeatedly-stated constraint; no prior testing-framework decision exists, so `node:test` (built-in, zero-dep) is fully consistent.

### Three approach decisions (confirmed with user via AskUserQuestion)

1. **Code-sharing:** Create a new `shared/` directory with a pure `normalize.mjs` (no `node:` imports), imported by both the pipeline and the API. Chosen over splitting `lib.mjs` or using a parity-test-only approach.

2. **Video audio semantics:** Null → "Without audio". "With audio" = strictly `audio === true`; "Without / no audio" = anything not strictly true (null + false survive). Chosen over adding a 4th "Audio N/A" option or making null survive both filters.

3. **Cache-busting location:** Deploy job, no commit. The `bust-cache` script runs in the `deploy` CI job (every push) after checkout, before `wrangler pages deploy`. Repo HTML stays at old `?v=`; deploys always get fresh hashes. Chosen over refresh-job+commit or both jobs.

The plan was approved and submitted via `ExitPlanMode`.

---

## Phase 3: Implementation (5 phases)

### Phase 1 — Unify canonicalization (fixes issues #1 + #2)

**Created `shared/normalize.mjs`** — a new pure module containing `canonicalId` and `orgLookupKey`. No `node:` imports, so it bundles cleanly into the Cloudflare Worker with no `nodejs_compat` flag. The docstring explicitly warns against reintroducing the `-preview-.*$` catch-all:

> IMPORTANT: unknown -preview-<foo> suffixes (e.g. -preview-customtools) are PRESERVED as distinct entries. The API's former normalizeId used a greedy -preview-.*$ catch-all that over-stripped these, causing distinct models (e.g. gemini-3.1-pro vs gemini-3.1-pro-preview-customtools) to collide in /models/:id/providers. Do NOT reintroduce that catch-all.

**Updated `scripts/lib.mjs`** — replaced its inline `canonicalId`/`orgLookupKey` with a re-export from `shared/normalize.mjs`. Kept `ORG_ALIASES` and `PROVIDER_NAME_MAP` as the single data source (lib's versions, which are supersets). Kept `dedupKey`/`dedupModels`/`normalizeProvider` in lib (they depend on `PROVIDER_NAME_MAP` — data, not pure logic).

**Updated `scripts/fetch-pricing.mjs`** — added an import from `./lib.mjs` and deleted ~250 lines of inline re-declarations: `num`, `perTokToPerM`, `centsToDollars`, `passthrough`, `NON_TEXT_ID`, `isTextModel`, `ORG_ALIASES`, `orgFromId`, `orgFromName`, `canonicalId`, `orgLookupKey`, `PROVIDER_NAME_MAP`, `normalizeProvider`, `dedupKey`, `dedupModels`, `fetchJson`, `fetchJsonWithRetry`, and the inline `checkCoverageDrop`. The lib version of `checkCoverageDrop` returns `prevCount`, which is captured to preserve the dry-run delta printout. The unused constants `OR_MAX_RETRIES`/`OR_RETRY_DELAY_MS` were deleted (only `fetchJsonWithRetry` used them, and lib's version has equivalent parameter defaults).

**Updated `functions/api/v1/[[route]].js`** — added `import { canonicalId } from '../../../shared/normalize.mjs';`, deleted the local `normalizeId` function, and replaced all 6 call sites. Caught and fixed a naming collision: line 169 had a local variable `const canonicalId = decodeURIComponent(...)` that shadowed the imported function — renamed to `requestedId`.

**Verification:** The full pipeline ran successfully (920 models, up from 910 — normal daily drift, no dedup regressions from the `ORG_ALIASES` merge). The gemini-3.1-pro regression was confirmed fixed via a Node simulation against real data:

```
Request: /api/v1/models/gemini-3.1-pro/providers
Matches found: 2
  - google/gemini-3.1-pro | provider: deepinfra
  - google/gemini-3.1-pro-preview | provider: google

Request: /api/v1/models/gemini-3.1-pro-preview-customtools/providers
Matches found: 1
  - google/gemini-3.1-pro-preview-customtools | provider: google
```

Before the fix, the first request returned 3 merged models. After, it returns only the 2 that legitimately canonicalize to `gemini-3.1-pro` (the bare `-preview` suffix is stripped; `-preview-customtools` is preserved as distinct).

### Phase 2 — Fix video audio filter (issue #3)

**`public/video-app.js` line 172** — replaced:
```js
if (state.audioFilter !== '' && String(p.audio) !== state.audioFilter) continue;
```
with:
```js
if (state.audioFilter === 'true' && p.audio !== true) continue;
if (state.audioFilter === 'false' && p.audio === true) continue;
```

**`public/video.html`** — relabeled the audio options for clarity: "Any" → "Any audio", "Without audio" → "Without / no audio".

**`public/video-app.js`** — updated the results-title copy to match.

**Verification:** All 22 null-audio entries now survive "Without / no audio". All 8 null-only models (Sora 2 Pro, Grok Imagine, Wan 2.6/2.7, Hailuo 2.3, HappyHorse 1.0/1.1, Kling Video O1) are visible.

### Phase 3 — Automate cache-busting (issue #4)

**Created `scripts/bust-cache.mjs`** — a pure-Node, zero-dependency script that:
1. Reads each `public/*.html` file.
2. Finds all `href="...?v=..."` and `src="...?v=..."` references via regex `matchAll`.
3. Computes an 8-character SHA-1 content hash for each referenced asset.
4. Rewrites `?v=<old>` with `?v=<hash>` in place.
5. Prints a summary.

A key implementation detail: `String.replace` with an async callback doesn't await, so the script uses a `for...of` loop over `matchAll`, awaits all hashes into a Map, then does a synchronous replace.

**Updated `package.json`** — added `"bust:cache": "node scripts/bust-cache.mjs"`.

**Updated `.github/workflows/refresh-pricing.yml`** — added a `setup-node` + `bust-cache` step to the `deploy` job (runs on every push, before `wrangler pages deploy`) and to the `refresh` job (after the JSON commit, before deploy). The busted HTML is uploaded to Cloudflare but not committed — the repo keeps its old `?v=` strings.

**Verification:** Ran locally — 6 tokens busted across 3 HTML files. `styles.css` gets the same hash in all 3 pages (correct — shared asset). Each app JS gets its own hash. Repo HTML reverted after testing.

### Phase 4 — Add automated tests (issue #5)

Used Node's built-in `node:test` runner (stable since Node 18, CI uses Node 22) — zero dependencies, no install step, consistent with the repo's zero-dep convention.

**Created 4 test files + 3 fixtures (61 tests total):**

- `test/canonicalization.test.mjs` (27 tests) — locks down `canonicalId`/`orgLookupKey` behavior: org/ prefix strip, `:free`/`:thinking` strip, all date formats, known preview-date patterns, **`-preview-customtools` preserved** (the regression), quantization preserved, `orgLookupKey` strips quant that `canonicalId` keeps.

- `test/parity.test.mjs` (3 tests) — loads the real `public/pricing.json` and asserts the gemini-3.1-pro family has distinct keys, every model produces a non-empty key, and glm-5.2 quant variants stay distinct. This is the cross-implementation guard — catches future re-divergence.

- `test/api.test.mjs` (24 tests) — tests the API routing and filters with a mocked `env.ASSETS` (small fixtures). Covers CORS, `/`, `/stats`, `/models` (all filters: org/provider/zdr/promo/sub/search/sort/order/limit/offset/min_context), `/models/:id/providers` (the regression fix, mix-aware sort, 404, bare vs full ID), `/orgs`, `/providers?zdr=true`, `/images/:id`, `/videos/:id`, 404. Documents the silent-fallback behavior for invalid sort keys.

- `test/video-audio.test.mjs` (5 tests) — regression for issue #3. Reproduces the fixed filter logic (video-app.js is a non-module global script, can't import directly) and asserts null-audio entries survive "Without / no audio", null-only models stay visible, flagships present.

**Created fixtures** — small `pricing.json` (5 models), `image-pricing.json` (2 models), `video-pricing.json` (2 models) in `test/fixtures/`.

**Updated `package.json`** — added `"test": "node --test test/*.test.mjs"`. (Initial attempt with `node --test test/` failed — Node 22 needs the explicit glob pattern.)

**Updated CI workflow** — added a new `test` job that runs on push/PR. The `deploy` job is now gated via `needs: test`. The `refresh` job runs tests before fetching.

**Verification:** `npm test` → 61 pass, 0 fail. Three initial failures in `/orgs` and `/providers` tests were due to wrong assertion shapes (the responses are wrapped in `{ generated_at, org_count, orgs: [...] }` objects, not bare arrays) — fixed and all pass.

### Phase 5 — Documentation

**`AGENTS.md`** — updated the "Canonical model ID" section to note the shared source of truth; updated the "Files to know" table (added `shared/normalize.mjs`, `scripts/bust-cache.mjs`, `test/`); updated Development (added `npm test`, `npm run bust:cache`); rewrote CI/CD (3 jobs: test/refresh/deploy, cache-busting explanation).

**`README.md`** — added `npm test` and `npm run bust:cache` to Development; rewrote CI/CD section.

**`TODO.md`** — marked the cache-busting entry as properly automated (no more manual bumps).

**`docs/conversations/20260708-top5-fixes.md`** — new session log following the established schema (Overview, 5 numbered fix sections, Key Decisions, Technical Discoveries, Code Changes, Follow-up).

---

## Phase 4: Commit and push (with a rebase surprise)

All changes were staged (9 created, 10 modified files). Committed as `c97348e` with a detailed message. Then the push failed:

```
! [rejected]        main -> main (fetch first)
```

The daily cron had run at 00:00 UTC and pushed a pricing refresh (`0f36413`) while the session was in progress. A `git rebase origin/main` was attempted, which hit a conflict on `public/pricing.json` (both the cron and this session's verification run had written it).

**Resolution:** Took the cron's version of `pricing.json` (it's the authoritative daily refresh with fresher data — this session's `pricing.json` was from a verification run, not a deliberate change). All code changes applied cleanly on top. Re-ran `npm test` post-rebase → 61 pass. Pushed as `b1634a6`.

---

## Technical discoveries worth highlighting

1. **Cloudflare Pages Functions are esbuild-bundled** and follow relative imports outside `functions/`. No hard directory boundary. But `node:fs` in the imported module breaks the bundle unless `nodejs_compat` is enabled — confirmed via Cloudflare docs, Stack Overflow, and GitHub issues. The `shared/normalize.mjs` approach sidesteps this by being pure.

2. **`String.replace` with an async callback doesn't await.** The `bust-cache.mjs` script uses a `for...of` loop over `matchAll`, awaits all hashes into a Map, then does a synchronous replace.

3. **`node --test test/` doesn't work in Node 22** — needs `node --test test/*.test.mjs` (explicit glob). Fixed in `package.json` and CI.

4. **The `[[route]].js` had a local variable `canonicalId`** (the URL path segment) that shadowed the imported function. Renamed to `requestedId` to avoid the collision. This kind of shadowing is easy to miss when adding an import to a file that already uses the same name locally.

5. **`checkCoverageDrop` return value matters.** Lib's version returns `prevCount` (null on ENOENT); fetch-pricing's inline version didn't return it. The dry-run delta printout reuses `prevCount` — capturing the return value preserved that feature.

6. **Verification discipline pays off.** Several initial assumptions were refuted by reading the actual code (Wafer's cents math is correct, HTTP `res.ok` IS checked, coverage-drop runs after dedup). This prevented shipping "fixes" for non-bugs.

---

## Key decisions and their rationale

| Decision | Rationale |
|---|---|
| New `shared/` dir (not split `lib.mjs`, not parity-test-only) | `lib.mjs` has a top-level `node:fs` import that breaks the Workers bundle. A pure `shared/normalize.mjs` sidesteps this with no config changes. |
| Only `canonicalId` + `orgLookupKey` moved to shared | Those are the pure functions that diverged. `normalizeProvider`/`dedupKey`/`dedupModels` depend on `PROVIDER_NAME_MAP` (data) and stay in lib. The API only needs `canonicalId`. |
| Null → "Without audio" (not 4th option, not null-survives-both) | Smallest diff, matches user expectation. Slight semantic conflation but small catalog. |
| Cache-bust in deploy job, no commit | Runs on every push, no commit noise, repo HTML stays clean. Busted HTML deployed but not committed. |
| `node:test` over Jest/Vitest | Zero-dep convention. Built-in, no install step. |
| Video filter test reproduces logic | `video-app.js` is a non-module global script. Refactoring to exported module is a follow-up. |
| Take cron's `pricing.json` during rebase | Cron's version is the authoritative daily refresh. This session's was from a verification run. |

---

## Files created (9)

- `shared/normalize.mjs` — pure canonicalization helpers
- `scripts/bust-cache.mjs` — content-hash cache-busting
- `test/canonicalization.test.mjs` — 27 tests
- `test/parity.test.mjs` — 3 tests (regression guard against real pricing.json)
- `test/api.test.mjs` — 24 tests (API routing/filters/sort)
- `test/video-audio.test.mjs` — 5 tests (audio filter regression)
- `test/fixtures/pricing.json` — 5-model text fixture
- `test/fixtures/image-pricing.json` — 2-model image fixture
- `test/fixtures/video-pricing.json` — 2-model video fixture

## Files modified (10)

- `scripts/lib.mjs` — re-exports canonicalId/orgLookupKey from shared
- `scripts/fetch-pricing.mjs` — imports all shared utils from lib; deleted ~250 lines of inline re-declarations
- `functions/api/v1/[[route]].js` — imports canonicalId from shared; deleted normalizeId; renamed shadowing local var
- `public/video-app.js` — fixed audio filter logic + results title copy
- `public/video.html` — relabeled audio options
- `package.json` — added `test` and `bust:cache` scripts
- `.github/workflows/refresh-pricing.yml` — added `test` job (gates deploy), added setup-node + bust-cache to deploy + refresh jobs
- `AGENTS.md`, `README.md`, `TODO.md` — doc updates
- `public/pricing.json` — refreshed (from the cron's rebase, not this session's changes)
- `docs/conversations/20260708-top5-fixes.md` — full session log

---

## Follow-up / out of scope

- **Honorable-mention issues not addressed:** mix-percent normalization mismatch (widget renormalizes, API doesn't), sort silent-fallback (invalid sort → id, no error), coverage-drop per-run threshold (not cumulative), Synthetic `input×0.20` hardcoded cache multiplier.
- **Frontend ES-module refactor:** `video-app.js` etc. are non-module global scripts — can't be imported by tests directly. The audio filter test reproduces logic with a sync-note. A follow-up could extract filter logic into exported modules.
- **Linting/formatting:** not added. `node --test` is the verification gate for now.
- **`nodejs_compat` / `wrangler.toml`:** not added. Avoided by keeping `shared/normalize.mjs` pure.

---

## Lessons for future sessions

1. **Verify before fixing.** Several candidate "bugs" were actually handled correctly (Wafer's cents math, HTTP `res.ok` checks, coverage-drop timing). Reading the actual code prevented shipping "fixes" for non-bugs.
2. **Two sources of truth will diverge.** The canonicalization bug existed solely because three copies of the function drifted over time. Unifying into one source is the only durable fix — parity tests help but don't prevent drift.
3. **Cloudflare Workers bundling has a sharp edge.** A top-level `node:fs` import in a module imported by a Function breaks the bundle unless `nodejs_compat` is enabled. Keep shared modules pure.
4. **`String(null) === "null"`** is a common JavaScript footgun in filter logic. When a field can be `null`/`true`/`false`, use strict equality (`p.audio === true`) rather than string coercion.
5. **Manual cache-busting will be forgotten.** It already caused one documented phantom-bug debugging session. Automate it.
6. **The daily cron can push while you work.** Always `git fetch` before push; be ready to rebase and resolve `pricing.json` conflicts by taking the cron's fresher data.
7. **`node --test` needs an explicit glob** in Node 22 (`test/*.test.mjs`), not a directory (`test/`).
