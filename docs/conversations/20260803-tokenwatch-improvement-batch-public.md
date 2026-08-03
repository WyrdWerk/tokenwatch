# TokenWatch — Improvement Batch: Analysis, MOA Review, Implementation & Deploy (Public Conversation Record)

**Date**: 2026-08-03
**Repo**: [WyrdWerk/tokenwatch](https://github.com/WyrdWerk/tokenwatch)
**Live site**: https://tokenwatch.wyrdwerk.com
**Commits**: `1636189`…`d285339` (batch, rebased onto cron commits), `3d03e71` (CI smoke polish)
**CI**: runs `30841268238` + `30841463158` — both success (test + deploy jobs; /h/* smoke ✓)

> This is a sanitized, publicly-shareable record of the session that analyzed the TokenWatch
> codebase, planned an evidence-backed improvement batch via a Mixture-of-Agents (MOA) review,
> implemented seven change sets, ran the live fetch pipeline, and deployed to production with
> verify@deploy guards. No sensitive information is included.

---

## What TokenWatch is

TokenWatch is a zero-dependency, pure-Node-ESM static site that compares pay-as-you-go LLM inference pricing across **996 models and 81 providers** (as of the 2026-08-03 refresh), plus separate image (~172) and video (~134) generation catalogs. Deployed to Cloudflare Pages with a 2-hourly CI/CD refresh. OpenRouter's `/endpoints` API is de-aggregated so each backend becomes its own row. Highlights: per-backend pricing with cache discounts, ZDR (zero data retention) tagging, quality benchmarks (Artificial Analysis indices), a Blended $/M comparison metric, budget mode, and a queryable `/api/v1` API on Pages Functions.

Prior session records: [SEO & Google Search Console setup](20260803-seo-gsc-setup-public.md), [models.dev enrichment](20260709-modelsdev-enrichment-public.md), [top-5 fixes](20260708-top5-fixes-public.md).

---

## The headline change

This batch hardened the API, fixed the deploy pipeline economics, made SEO generation a CI concern instead of a manual step, corrected a ranking bug, and closed a data-quality gap — **10 commits, 7 change sets, +21 tests (249 → 270), two CI-green production deploys**.

---

## Change sets

### 1. API hardening (`1636189`)
- `/api/v1/images/:id` and `/api/v1/videos/:id` threw an **uncaught URIError → HTTP 500** on malformed `%`-encoding. Now return `400 {"error":"Invalid model id encoding"}` (the models route already had this guard).
- Pagination clamps `limit` to [1,500] and `offset` to ≥ 0 — negative values silently returned wrong slices (`offset=-1` → last page; `limit=-5` → dropped trailing rows).
- +5 regression tests (`test/api.test.mjs`).

### 2. CI overhaul (`1ec6500`)
- **Skip-write fetchers**: `maybeWriteJson()` in `scripts/lib.mjs` — the three JSON fetchers only rewrite their file when content changed (excluding `generated_at`, original timestamp preserved). Without this, a deploy gate could never fire correctly because `generated_at` churned every run.
- **Gated deploys**: bust-cache/minify/deploy (and SEO generation + integrity guard + `/h/*` smoke) in `refresh-pricing.yml`/`refresh-aa.yml` now run only when `changed == 'true' || inputs.force == 'true'` — ending ~12 wasted deploys/day. `inputs.force` on `workflow_dispatch` is the recovery lever after a failed deploy.
- **SEO in CI**: `generate-seo.mjs` now runs in every deploy path (refresh, deploy, refresh-aa), so the server-rendered cheapest-models table, `sitemap.xml`, and `robots.txt` never go stale again — previously they were only regenerated when someone remembered `npm run seo` manually.
- **`/h/*` content-type smoke**: after every deploy, CI curls a hashed asset and asserts `application/javascript` — automating the manual verification that guarded the 2026-07-30 SPA-fallback outage.
- `timeout-minutes: 60` on refresh jobs; removed an unreachable `pull_request` condition (PRs covered by `ci.yml`).

### 3. SEO generation correctness (`ef762bd`)
- **Ranking bug fixed**: `generate-seo.mjs` computed effective cost as `input×0.025 + output×0.005` when `cache_read` was null — dropping the 97% cached leg entirely and making null-cache models rank ~97% too cheap (a null-cache Mistral Nemo sat at #1 with $0.0006/M effective). New shared `shared/cost.mjs` `blendedRate` falls back `cache_read → input`, matching `app.js blendedCostFor`. The cheapest-25 table now agrees with the in-app Blended $/M ordering.
- **Live counts**: provider/model counts are `{{modelCount}}`/`{{providerCount}}` placeholders substituted at build — the stale hardcoded "75 providers / 994 models" (in 7 spots incl. JSON-LD and FAQ) is replaced with real numbers on every deploy. Fail-loud if any placeholder survives.
- **Anchor fix**: `id="cheapest"` + `id="faq"` so the `<noscript>` links actually work.
- Pure builders + `main()` guard (testable), atomic `tmp+rename` writes, and a parity suite pinning `blendedRate` to a vendored copy of `app.js blendedCostFor` (+9 tests).

### 4. Frontend fix (`6704d1c`)
- The **Rank** column on image/video pages carried `data-sort="cost"` (same as Total Cost): clicking Rank sorted by cost and both headers showed the sort marker. Rank is now non-sortable (it renders from row index). Verified in-browser: clicking Rank is a no-op; only Total Cost shows `aria-sort`.

### 5. Pipeline cleanup + quantization (`0f13132`)
- **Quantization fill**: direct/CSV rows embedded the quant in the model ID (`glm-5.2-fp8`) but stored `quantization: null`, so the `?quantization=` filter and `/stats` missed them. New `quantFromId()` + shared `QUANT_SUFFIX_RE` in `shared/normalize.mjs` fill the field post-dedup (never overwriting OpenRouter values). Live first run: **6 rows filled** (`makora/glm-5.2-fp8 → fp8`, `-nvfp4 → nvfp4`, `hyper/llama-4-maverick-…-fp8 → fp8`, `qwen3-coder-…-int4-mixed-ar → int4-mixed-ar`).
- Removed dead `parseUmans()`, an unused `num` import, and unified the models.dev reverse-map (shared `REVERSE_PROVIDER_MAP`). Corrected the false "Quantization is NOT part of the dedup key" header comment (it **is** — pinned by tests). +5 tests.

### 6. Documentation (`d57c86a`)
- **AGENTS.md** refreshed to code reality: 994→996 models, 75→81 providers, benchmark coverage ~82%/AA ~77% (+ parity floors), 4→20 test files, `min_intelligence`/`benchmarked` filters + `intelligence/coding/agentic` sort keys, four workflows + gated flow + `inputs.force`, 2→7 secrets, bust-cache `/h/` mechanism, 8→12 manual providers, 9 files-to-know additions.
- **Citation hygiene**: ADR 0002/0007 + canonicalization edge-cases doc now cite **function names, not line numbers** (line refs drift; precedented by `parity.test.mjs`).

### 7. Hygiene (`da0fd11`)
- `.gitignore` now covers one-off investigation artifacts (`models_dev_api.json`, `final_*`, `investigation_summary.md`, `pipeline-investigation.md`, `tmp/`) and carries an explicit **"do NOT ignore `public/h/`"** guard comment (that exact mistake broke deploys on 2026-07-30).

---

## How the plan was validated (MOA)

Before implementing, the improvement plan went through a **Mixture-of-Agents review**: three reviewers (correctness/security, architecture/maintainability, ops/CI) independently probed every item against code, ran the test suite, and returned verdicts. They caught two flaws in the draft that would have shipped broken:
1. The deploy gate was **dead-on-arrival** without skip-write fetch logic (`generated_at` churn made `git diff` never quiet).
2. A `cache_read > 0` guard in the SEO formula would have misranked free-cache models (must fall back to input only when null).

They also surfaced the failed-deploy recovery gap (`inputs.force`), the missing `/h/*` smoke automation, and that `refresh-aa.yml` had the same ungated deploy. The full plan is archived at `docs/superpowers/plans/2026-08-03-tokenwatch-improvement-batch.md`.

---

## Decisions made

- Deploy only when data changed; `inputs.force` for manual recovery.
- **Do not commit SEO output** — deployed SEO ≡ f(committed `pricing.json`) in both CI paths; a grep integrity guard runs instead.
- Committed `index.html` keeps count placeholders; CI substitutes real numbers every deploy.
- `generate-seo.mjs` runs **before** `bust-cache.mjs` (it rewrites `index.html`, which bust-cache then fingerprints).
- Quantization fill runs post-dedup, matches the canonical ID, never overwrites OpenRouter values.
- `app.js` stays a mirrored classic script (no bundler) — pinned by vendored-copy parity tests.
- Live fetch first, then commits (so `pricing.json` shipped with quant fill before the next cron).

## Verification

- `npm test`: **270/270** (was 249) at HEAD, including parity floors against fresh data.
- `npm run seo` ×2: idempotent, counts substituted, no leftover placeholders.
- Live fetch: 996 models / 81 providers, "Quantization filled for 6 rows".
- Both CI runs green: test 8–11s, deploy 21–25s, `/h/*` smoke `application/javascript`.
- Production: title serves **"Compare 996 Models Across 81 Providers"**; `GET /h/app.9c71ea6c.js` → HTTP/2 200, `content-type: application/javascript`.

## Follow-ups

- Watch the next 2-hourly cron: unchanged cycles now produce zero commits/deploys; changed cycles exercise fetch → commit → SEO → deploy → smoke.
- Deferred: `tokenwatch-cli` plan, SVG `og:image` → PNG, optional cache-leg exclusion product decision, AGENTS.md "Next steps" backlog (subscription pricing details, historical price tracking, SEO content pages).