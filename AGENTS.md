# CRITICAL: Delegation Gate

Before ANY tool call on a new task, STOP and classify:
1. Will this task require reading 3+ files or running multiple analysis scripts?
   → YES: Dispatch `explore` subagent(s) FIRST. Do NOT read files inline.
2. Is this a code edit that depends on investigation findings?
   → Investigate via subagent, then edit inline with the returned findings.
3. Is this a single quick lookup or sequential edit?
   → Proceed inline.

Rules: Investigation = delegate. Editing/deciding = inline. Never both.

---

# AGENTS.md — TokenWatch

## Project overview

Static site comparing pay-as-you-go LLM API pricing across inference providers. Uses OpenRouter's `/endpoints` API to de-aggregate per-backend pricing (each backend like DeepInfra, Fireworks, Together becomes its own row). Zero dependencies, pure Node ESM. Deployed to Cloudflare Pages with 2-hourly CI/CD refresh + auto-deploy on push.

> **Diagram:** [ARCHITECTURE.md](ARCHITECTURE.md) — three-pipeline flowchart (text / image / video).
> **Canonicalization traps:** [docs/canonicalization-edge-cases.md](docs/canonicalization-edge-cases.md) — read before touching `shared/normalize.mjs` or `public/app.js`.
> **Decisions:** [docs/adr/](docs/adr/) — why the pipeline is shaped this way.
> **SEO infrastructure:** `scripts/generate-seo.mjs` server-renders the 25 cheapest models into `index.html` for crawlability, and generates `sitemap.xml` + `robots.txt`. Run `npm run seo` before deploy. See [docs/conversations/20260803-seo-gsc-setup-public.md](docs/conversations/20260803-seo-gsc-setup-public.md).

## Architecture

- **Data pipeline**: `scripts/fetch-pricing.mjs` fetches pricing from 3 tiers:
- **Tier 1 — Direct providers** (authoritative): DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova, HyperCharm, Sference, Neuralwatt, Merius, Aster Labs, SingularityAPI, RunInfra — fetched via their own `/v1/models` endpoints. SingularityAPI and RunInfra require `SINGULARITY_API_KEY` / `RUNINFRA_API_KEY` (skipped with a warning if unset).
- **Tier 2 — OpenRouter de-aggregated**: `/v1/models` lists models, then `/endpoints` per model returns per-backend pricing. Each backend (Fireworks, Together, Novita, SiliconFlow, etc.) becomes its own row — NOT "OpenRouter"
- **Tier 3 — CSV/hardcoded/scraped**: Makora, Xiaomimimo (CSV), OpenCode Go (docs-page scrape: `parseOpenCodeGoDocs()` in `scripts/lib.mjs` scrapes the pricing table at `https://opencode.ai/docs/go/` — the `/zen/go/v1/models` catalog endpoint lists models but has no prices; context lengths stay manual via `OPENCODE_GO_CONTEXT`; legacy hardcoded array is the fallback), Umans (manually maintained `UMANS_MODELS` / `parseUmansHardcoded()` — not a live `/v1/models` fetch; status.umans.ai SSR is for performance data only)
  - **3-tier precedence**: dedup key is `canonicalId(m.id) | normalized_provider` (`scripts/lib.mjs:282-284`). Direct wins over OpenRouter, which wins over CSV/hardcoded; first-seen/highest-tier wins among identical keys. **Quantization IS part of the dedup key** — `canonicalId()` preserves quant suffixes (`shared/normalize.mjs:34-47`), so different quants of the same model+provider produce distinct keys and stay distinct rows (`test/canonicalization.test.mjs:88-97`). (Note: `orgLookupKey` strips quant for org resolution only — `normalize.mjs:54-58` — and is NOT the dedup key; see `docs/canonicalization-edge-cases.md` §2.)
  - Writes `public/pricing.json` with 1,180 text-generation models across 82 inference providers (2026-08-11 data). **~56.4% are ZDR-tagged.**
- **models.dev enrichment**: after the 3-tier fetch + dedup, `fetch-pricing.mjs` calls `fetchModelsDevEnrichment()` (sidecar, non-fatal) which pulls `https://models.dev/api.json` and builds a `(provider, normalizedModelId)` index. `applyEnrichment()` decorates each model with a `modelsdev` block (base URL, native model ID, capability metadata) and fills `null` cache_read/cache_write/context_length/max_output values. Never overwrites existing values. Two-tier matching: Tier A (exact normalized, confidence `'high'`) + Tier B (bounded fuzzy subset, confidence `'medium'`, surfaces a ⚠ pill in the UI).
- **Benchmark enrichment (sidecar)**: after models.dev enrichment, `applyBenchmarkEnrichment()` attaches Artificial Analysis quality indices (`intelligence_index`, `coding_index`, `agentic_index`, 0–100 scale) and `design_arena_best` Elo from OpenRouter's `/models` `benchmarks` field. Conservative variant matching (`shared/benchmarks.mjs`) — strips only trailing quant (`-fp8`, `-nvfp4`, `-int4`) and SKU (`-turbo`, `-fast`, `-highspeed`) suffixes; never size tokens or version bits (which would misattribute — `Qwen3-30B-A3B` must not collapse to `qwen3`). Coverage: ~82% of text models have some benchmark data; ~77% have AA indices specifically (enforceable parity floors: ≥65% / ≥48% in `test/parity.test.mjs`). Surfaced in the detail modal (not a table column) plus footer source links. No value-per-dollar in v1 — raw `intelligence/price` makes cheap-weak models rank above flagships.
- **Neuralwatt energy enrichment (sidecar)**: after benchmark + AA enrichment, `fetchNeuralwattEnergy()` scrapes Neuralwatt's SSR `/energy-pricing` page (page has TWO tables since 2026-08: a per-model summary table first, then the band grid — the parser selects the band grid by its `0–256` header, never by document order) → per-model `m.energy` block (Wh/request by prompt-size band, request share %, model-level avg cache-hit %, 48h-vs-7d trend). **Workload-dependent, NOT a flat $/M** — stored separately from `m.pricing`, never touches token-price fields. Only attached to `provider === 'neuralwatt'` rows (canonicalId collision guard prevents cross-provider misattribution). Rate is the canonical config `$10/kWh` PAYG (`effective_from: 2026-07`); the page's stated rate is observation-only — disagreement logs a warning, never overrides. Surfaced in the detail modal "Energy (Neuralwatt)" section (bands table + $/request computed client-side).
- **ZDR (Zero Data Retention)**: Two-stage tagging in `main()`:
  1. **Endpoint-level**: `fetchZdrEndpoints()` fetches `/api/v1/endpoints/zdr` (documented, no auth) and builds a Set of `dedupKey()` strings. Models matching the set get `zdr: true`.
  2. **Provider-level fallback**: models not tagged at endpoint level are checked against `providers_meta[provider].retains_prompts === false`.
  - `MANUAL_PROVIDER_META` stores URLs + `retains_prompts`/`may_train`/`retention_days` (where reviewed) for 15 manual providers (aster, crof, ember, hyper, lilac, makora, merius, neuralwatt, opencode, runinfra, sference, singularity, synthetic, umans, xiaomimimo). ZDR verdicts: Aster Labs full ZDR (prompts/outputs processed in memory and never stored or trained on). Merius full ZDR (no logging/storing). HyperCharm ZDR-by-default (retains_prompts:false, retention_days:30 — "not stored by default"; conditional retention up to 30 days for debugging/abuse/legal). Neuralwatt (retains_prompts:false, retention_days:1 — 24h volatile purge; anonymized semantic representations retained for cache). Sference (DPA https://sference.com/legal/dpa — Annex 1 transient retention, Annex 2 Pt 10 excluded from backups, Clause 2.6 no-train). SingularityAPI own-processing ZDR by default (logging opt-in; upstream model hosts may retain). RunInfra Model API: prompts in-memory only, 24h idempotency replay cache for non-streaming completions. EmberCloud ZDR/retention undetermined (URL-only metadata, no public policy evidence).
- **Provider metadata**: `fetchProviderMeta()` fetches 3 sources: (1) `MANUAL_PROVIDER_META` (manual, includes ZDR fields), (2) OpenRouter `/api/v1/providers` (policy URLs, HQ, datacenters — guarded to not overwrite manual entries), (3) `/api/frontend/all-providers` (undocumented, non-fatal enrichment for `dataPolicy.retainsPrompts`, `training`, `retentionDays`). Alias resolution via `PROVIDER_NAME_MAP` (e.g. `xiaomimimo` inherits `xiaomi` metadata).
- **Benchmarks pipeline**: `scripts/fetch-benchmarks.mjs` builds `public/benchmarks.json` — per-model use-case-tagged scores (AA intelligence/coding/agentic + Design Arena from pricing.json enrichment; LiveBench per-release CSV from the LiveBench/livebench.github.io GitHub repo, no key, 2026-06-25 release) joined to per-provider prices. Model-creator org resolution is 4-layer (clean org → global provider-slug blocklist → variant-family inheritance incl. dash-less/reseller spellings → leading-token creator map); pinned by `test/benchmarks-page.test.mjs` (provider-slug leak regression). The benchmarks page recomputes "cheapest provider blended $/M" CLIENT-SIDE at the visitor's mix — the Text calculator persists its mix to `localStorage['tw-mix']` (app.js) and `benchmarks-app.js` mirrors `blendedRate()` (parity-pinned). Value column = primary score ÷ blended price, normalized best-in-view = 100 (never raw ratio — scale-mixing bug fixed 2026-08-14).
- **Consolidated FAQ**: `renderFaqPage()` in seo-pages generates `public/faq/index.html` (text + image + video + benchmark FAQ groups, owns the FAQPage JSON-LD). Calculator pages carry only a pointer section linking /faq/. `llms.txt` generated per refresh (buildLlmsTxt). Nav order: Text · Image · Video · Benchmarks · Providers · Methodology · API · FAQ. verify-seo: sitemap = providers + 8; FAQ/JSON-LD parity enforced on /faq/ only.
- **Frontend**: `public/` static site loads `pricing.json` client-side. Typeahead search (by inference provider and by model) on all three pages (text, image, video) via native HTML5 datalist. Cost computation entirely in-browser. Features: group-by toggle (None/Org/Provider), comparison mode (up to 6, side-by-side modal with Speed p50 + Blended $/M rows), cost mode toggle (Per Session / Monthly Volume with ×30 multiplier), budget mode (Budget → Tokens/Count/Seconds inverse affordability calculator on all 3 tabs), **Blended $/M** column (mix-weighted effective rate via `blendedCostFor()`, excludes cache_write/monthly — pure comparison metric), **Export CSV** (`exportCsv()` downloads current results), **Speed** column (throughput p50 from performance.json), **benchmark bar** (dynamic median/mean/range/free strip over the current result cohort, recomputed on every render — sits between usage inputs and results table on all 3 tabs, mode-aware labels), URL hash state persistence, provider HQ flag badges, ZDR badges + "ZDR only" filter, privacy/ToS/status links, promo badges + "Promos only" filter, cache-write cost amortization input. Mobile: table→card layout at ≤640px via `td[data-label]` attributes on all pages; mobile sort dropdown (`<select class="mobile-sort">`) visible only at ≤640px with bidirectional sync to desktop column header clicks.
- **SEO**: `scripts/generate-seo.mjs` (build-time, `npm run seo`) server-renders the 25 cheapest models (by effective cost at the agentic mix 2.5/97/0.5) into `index.html` as a real HTML table — this is the crawlability fix for the client-side-rendered SPA. It also generates `sitemap.xml` (with `lastmod` from `pricing.json` `generated_at`) and `robots.txt`. **Idempotent**: checks for an existing `class="seo-models"` section and replaces it via regex — never re-inserts before `</main>`. All 3 HTML pages carry keyword-rich titles/descriptions, canonical, og:image (1200×630), twitter:card=summary_large_image, and JSON-LD (WebSite + SoftwareApplication + FAQPage + BreadcrumbList). `_headers` sets `X-Robots-Tag: noindex` on `/api/*` and the raw JSON data files so they don't compete with HTML pages.
- **API**: Cloudflare Pages Functions at `functions/api/v1/` serve queryable endpoints: `/api/v1/models` (with filters: org, provider, min_context, min_output, min_intelligence, quantization, cache_read, cache_write, promo, zdr, sub, benchmarked, search, sort), `/api/v1/models/:id/providers` (mix-aware cost sort), `/api/v1/stats` (org/zdr/sub/quantization breakdowns), `/api/v1/orgs`, `/api/v1/providers` (?zdr=true), `/api/v1/images`, `/api/v1/images/:id`, `/api/v1/videos`, `/api/v1/videos/:id`. CORS enabled. Invalid `%`-encoding returns 400; pagination clamps limit∈[1,500], offset≥0.
- **Widget**: `public/widget/embed.js` — embeddable JS snippet using Shadow DOM, auto-detects `[data-tw-model]` elements, fetches the API, renders compact pricing cards.
- **CI/CD**: four workflows in `.github/workflows/`:
  - `refresh-pricing.yml` — 2-hourly cron (fetch all pipelines → commit JSON → generate-seo → bust-cache → minify → deploy; the post-commit steps are **gated on `changed == 'true'` or `inputs.force`**) + push-to-main trigger (deploy-only: generate-seo → bust → minify → deploy). Both jobs end with a `/h/*` content-type smoke check.
  - `refresh-performance.yml` — 2-hourly at :30 (offset, no collision; serialized via `concurrency: repo-refresh`), same gating pattern, commits `public/performance.json`.
  - `refresh-aa.yml` — weekly (Mon 06:00 UTC), refreshes `data/aa-benchmarks.json` + re-runs fetch-pricing, gated the same way.
  - `ci.yml` — PR → main, tests only.
  - Manual `workflow_dispatch` on the three refresh workflows accepts `inputs.force` (boolean) to force a deploy even when nothing changed (recovery lever after a failed deploy).

## Key conventions

### Pricing normalization

All prices are stored as **USD per million tokens ($/M)**. Conversion by source:
- OpenRouter `/endpoints`: $/token → ×1e6
- SambaNova / EmberCloud / Lilac: $/token → ×1e6
- DeepInfra / Crof / HyperCharm / Aster Labs / Makora / Xiaomimimo / OpenCode Go / SingularityAPI / RunInfra: $/M (passthrough)
- Wafer: cents/M → ÷100
- Synthetic: $/token → ×1e6, cache_read = input × 0.20 (per spec, not from API)

### Endpoint fields captured from OpenRouter

- `pricing.prompt` (→ `input`), `pricing.completion` (→ `output`), `pricing.input_cache_read` (→ `cache_read`), `pricing.input_cache_write` (→ `cache_write`) → all converted to $/M. (Some direct providers use `pricing.cache_read`/`pricing.cache_write` instead of the `input_cache_*` variants; the pipeline handles both.)
- `pricing.discount` (0 = structural, >0 = promo fraction)
- `context_length`, `max_completion_tokens`, `uptime_last_30m`
- `quantization`, `provider_name`

### Discount field

OpenRouter `/endpoints` returns a `discount` field (0 = structural price, >0 = promotional). The `discount` magnitude is the fraction off (e.g., 0.7 = 70% off). Promo prices are shown with a "promo" badge in the UI. No pre-discount/original price is available from the API — only the current (possibly discounted) price and the discount fraction.

### Text-only filtering

Only text-generation models are included (output must be text). Filtering by source:
- **OpenRouter**: `architecture.output_modalities` must be exactly `["text"]`. Allows multimodal input (text+image+file→text).
- **DeepInfra**: `metadata.tags` excludes `image-gen`, `tts`, `stt`, `embed`, `embeddings`, `video-gen`, `audio`.
- **SambaNova**: `display.group.id` must be `text` or `reasoning`; drops `image-text`, `audio`, `embeddings`, `other`.
- **Aster Labs**: token-priced records only; excludes the `per_search_usd` Wildflower product.
- **Other direct providers** (Crof, Wafer, Lilac): ID-based regex fallback for embeddings/TTS (no structured metadata available).

### Provider-name normalization

`PROVIDER_NAME_MAP` reconciles direct-provider keys (`ember`, `deepinfra`, `wafer`) with OpenRouter display names (`EmberCloud`, `DeepInfra`, `Wafer`) for dedup precedence. Also used for provider metadata alias resolution (e.g. `xiaomimimo` → `xiaomi`). Direct providers also stored in `providers` array with display names for frontend rendering.

### Provider metadata

`providers_meta` top-level key in pricing.json contains per-provider policy data:
- `privacy_policy_url`, `terms_of_service_url`, `status_page_url` — from OpenRouter `/api/v1/providers` or `MANUAL_PROVIDER_META`
- `headquarters` — country code (US, SG, CN, etc.)
- `datacenters` — array of region codes
- `source` — `openrouter` or `manual`

Manual entries (`MANUAL_PROVIDER_META` in fetch-pricing.mjs) cover providers not in OR: aster, crof, ember, hyper, lilac, makora, merius, neuralwatt, opencode, runinfra, sference, singularity, synthetic, umans, xiaomimimo (15 total). **Manual entries take precedence** — OR data only fills missing URL fields when the slug matches a manual entry; manual ZDR/policy fields are never overwritten.

### Org extraction

The `org` field identifies the underlying model creator (not the inference provider):
1. From parser-set org (Synthetic from `hugging_face_id`, SambaNova from leading ID segments via `ORG_ALIASES`, Aster/Singularity/RunInfra from verified model-family mappings)
2. From model ID prefix: `anthropic/claude-sonnet-5` → `anthropic`
3. Cross-reference via `orgLookupKey()`: quantization suffixes (`-fp8`, `-nvfp4`, `-int4`) stripped for org lookup
4. From model name: `DeepSeek: DeepSeek V4 Pro` → `deepseek`
5. Fallback: provider name
Org aliases: `deepseek-ai`→`deepseek`, `zai-org`→`z-ai`, `meta-llama`→`meta`, `minimaxai`→`minimax`, etc.

### Data filtering
- Zero-price entries (both input=0 AND output=0) are dropped
- `:free` entries are dropped
- Negative placeholder prices are dropped (OpenRouter meta-routers use -1000000)
- Non-text models are dropped (TTS, image gen, video gen, embeddings, speech-to-text-only)

### Canonical model ID


> **Edge cases & parity guard:** [docs/canonicalization-edge-cases.md](docs/canonicalization-edge-cases.md) — 10 known traps incl. the `-preview-customtools` collision and the frontend `canonicalModelId` parity guard at `test/parity.test.mjs:56-89`.
Used for cross-provider matching and dedup: strips provider prefix, removes suffixes (`:free`, date suffixes, `-preview`, `:thinking`), lowercases. Turbo variants kept separate. Quantization suffixes baked into the model ID (e.g. `glm-5.2-fp8`, `glm-5.2-nvfp4`) are left as-is — they are distinct entries, not collapsed. Example: `z-ai/glm-5.2`, `zai-org/GLM-5.2`, `GLM-5.2` (Wafer) all canonicalize to `glm-5.2`.

**Single source of truth:** `canonicalId` and `orgLookupKey` live in `shared/normalize.mjs` — a pure (no `node:` imports) module imported by both the Node pipeline (via `scripts/lib.mjs` re-export) and the Cloudflare Pages Function (`functions/api/v1/[[route]].js`). The API's former local `normalizeId` was retired — it had a greedy `-preview-.*$` catch-all that over-stripped `-preview-customtools` and caused distinct models to collide in `/models/:id/providers`. Unknown `-preview-<foo>` suffixes are now preserved as distinct entries.

### Cost computation

Percentage-based: user enters total tokens (in millions) + percentage breakdown (input %, cached input %, output %). Cost = `(tokens × $/M) / 1e6` per component, summed. If a provider doesn't support a requested token type (>0 tokens), that offering is excluded.

Cache-write cost is a one-time charge (writing to cache on first request), amortized over N requests via the **Advanced: cache write** input. It IS included in the Total Cost computation: `cacheWriteTokens_M × cache_write_$/M ÷ N`. The percentage model represents per-request throughput where cache_read replaces input on subsequent requests.

Two cost modes: **Per Session** (default — enter total tokens, see per-session cost) and **Monthly Volume** (enter daily tokens, see monthly cost × 30). The `modeMultiplier` is applied at the `costFor()` call site in `computeAndRender()` and `showCompareModal()`, not inside `costFor()` itself.

### Resilience

The pipeline includes unattended-operation safeguards:
- **Retry on failure**: 429/5xx responses retried once with 2s backoff
- **Abort on >20% failure rate**: if >20% of OpenRouter `/endpoints` calls fail, the entire refresh aborts (prevents shipping a half-missing catalog)
- **Coverage-drop check**: if model count drops >15% vs previous `pricing.json`, the refresh aborts to preserve last-good data
- **Dry-run mode**: `node scripts/fetch-pricing.mjs --dry-run` runs the full pipeline without writing pricing.json
- **Performance preservation**: `fetch-performance.mjs` won't overwrite a 1000-record OR-backed `performance.json` with ~30 direct-only records (85% threshold guard)

## Files to know

| File | Purpose |
|---|---|
| `shared/normalize.mjs` | Pure canonicalization helpers (`canonicalId`, `orgLookupKey`) — imported by both the Node pipeline and the Cloudflare Pages Function. No `node:` imports so it bundles cleanly into the Worker. |
| `shared/modelsdev.mjs` | Pure reconciliation helpers for the models.dev enrichment source — provider map, per-provider ID normalizers (cloudflare/amazon/fireworks/minimax), two-tier matcher (exact + bounded fuzzy). Imported by the pipeline via `scripts/lib.mjs`. |
| `shared/benchmarks.mjs` | Pure benchmark matching helpers (`conservativeBase`, `buildBenchmarkIndex`, `applyBenchmarkEnrichment`) — conservative variant stripping (quant + turbo/fast suffixes only). Imported by the pipeline via `scripts/lib.mjs`. No `node:` imports so it bundles cleanly into the Worker. |
| `scripts/fetch-pricing.mjs` | 3-tier fetch, OpenRouter de-aggregation, ZDR tagging (endpoint + provider level), provider metadata + data policy enrichment, org extraction, dedup, pricing normalization, dry-run mode — imports shared utils from `scripts/lib.mjs` |
| `scripts/fetch-modelsdev.mjs` | Sidecar fetcher for models.dev enrichment — pulls `https://models.dev/api.json` (single call, non-fatal), builds the `(twProvider → normalizedId → record)` index. Called by `fetch-pricing.mjs` after subscription tagging. |
| `scripts/generate-seo.mjs` | Build-time SEO generation (`npm run seo`): server-renders the 25 cheapest models into `index.html` (crawlability fix), generates `sitemap.xml` + `robots.txt`. **Idempotent** — replaces existing `class="seo-models"` section, never re-inserts. |
| `public/app.js` | Frontend state, URL hash persistence, search, cost computation (per-request + monthly ×30), `blendedCostFor()` (Blended $/M column + compare row), `exportCsv()`, group-by, comparison mode (Speed p50 + Blended rows), column customization (`applyColumnLayout`, `initColumnDrag`, `renderColPopover` — drag-reorder + hide/show the 9 middle columns), ZDR filter/badge, HQ badges, meta links, rendering, **`window.TWCatalog` façade** for WebMCP (assigned only after pricing.json loads) |
| `public/webmcp.js` | WebMCP site-tool registrar (progressive enhancement). Feature-detects `document.modelContext`, registers text-page tools against `TWCatalog`, aborts on pagehide. Must be fingerprinted in `bust-cache.mjs`. |
| `docs/WEBMCP.md` | Tool catalog, Priya demo walkthrough, existing-vs-new commit evidence for the WebMCP Challenge |
| `public/index.html` | UI layout: controls, usage-grid with mode toggle, 11-column results table (# … Speed, Blended $/M, Total Cost sticky) with drag handles + Hide Columns popover, ZDR + promo filters, group-by, comparison tray + modal, Export CSV. Also carries SEO head metadata (title/description/canonical/og:image/twitter:image), JSON-LD, FAQ section, noscript fallback, and the server-rendered cheapest-models table. |
| `public/styles.css` | Dark/light theme, all badges (org, provider, promo, ZDR, HQ, meta-link), group headers, comparison modal/tray, mode toggle, responsive. Includes `.seo-faq`, `.seo-models`, `.noscript-note` styles. |
| `scripts/fetch-benchmarks.mjs` | Benchmarks sidecar — builds `public/benchmarks.json` (AA + Design Arena + LiveBench CSV join, 4-layer org resolution, per-offering prices for client-side mix recompute) |
| `public/benchmarks.html` + `benchmarks-app.js` | Benchmarks tab — use-case tabs, mix-aware From $/M (from Text page localStorage), normalized Value bar, org filter, all-column asc/desc sort, detail modal |
| `public/faq/index.html` | Generated consolidated FAQ (all modalities + benchmarks); owns FAQPage JSON-LD |
| `public/pricing.json` | Generated data — models (with pricing, cache_write, uptime_30m, max_completion_tokens, zdr), providers, providers_meta (with retains_prompts, may_train, retention_days) — do not hand-edit, CI refreshes every 2h |
| `functions/api/v1/[[route]].js` | Cloudflare Pages Functions API — imports `canonicalId` from `shared/normalize.mjs`. /models (with filters: org, provider, min_context, min_output, quantization, cache_read, cache_write, promo, zdr, sub, search, sort), /models/:id/providers (mix-aware cost sort), /stats (org/zdr/sub/quantization breakdowns), /orgs, /providers (?zdr=true), /images, /images/:id, /videos, /videos/:id, CORS |
| `public/widget/embed.js` | Embeddable widget — Shadow DOM, auto-detects [data-tw-model], fetches API, renders pricing card |
| `public/widget/demo.html` | Widget demo page |
| `.github/workflows/refresh-pricing.yml` | Main pipeline: `test` (push, runs `node --test`), `refresh` (every 2h cron: test→fetch all pipelines→fetch-performance→commit 4 JSONs→generate-seo→SEO integrity guard→bust-cache→minify-json→deploy→/h/* smoke; post-commit steps gated on `changed`/`inputs.force`), `deploy` (push: generate-seo→guard→bust-cache→minify→deploy→smoke). Performance data (latency/throughput) sourced from OR (primary, requires key) + Crof/Lilac/Umans (direct). SEO artifacts regenerate every deploy (committed index.html may be stale; `npm run seo` regenerates from committed pricing.json). Cache-busted HTML + `/h/` copies are never committed. |
| `data/manual-pricing.csv` | Static pricing for CSV-sourced providers (Makora, Xiaomimimo) |
| `scripts/lib.mjs` | Shared utilities: org extraction, dedup, HTTP retry, coverage guard, dry-run — imported by all three fetchers. Re-exports `canonicalId`/`orgLookupKey` from `shared/normalize.mjs`. |
| `scripts/bust-cache.mjs` | Rewrites asset refs in `public/*.html` to path-fingerprinted copies under `public/h/` (8-char SHA-1 content hashes of `styles.css`, `app.js`, `image-app.js`, `video-app.js`, `shared-ui.js`, `webmcp.js`) — this is `?v=`-token replacement plus `/h/` copy generation. Run before deploy in CI (deploy + refresh + refresh-aa jobs) and locally via `npm run bust:cache`. |
| `scripts/fetch-images.mjs` | Image pipeline: fetch `/images/models` + `/endpoints`, normalize flat/megapixel/token pricing → `public/image-pricing.json`. Merges fal.ai image models (Tier-1 precedence) + runs `dedupModels`. |
| `scripts/fetch-videos.mjs` | Video pipeline: fetch `/videos/models`, normalize cents→dollars, filter per-second → `public/video-pricing.json`. Merges fal.ai video models (Tier-1 precedence) + runs `dedupModels`. |
| `scripts/fetch-fal.mjs` | Sidecar fetcher for fal.ai image + video pricing — paginated `/v1/models` + batched `/v1/models/pricing`, filters to active priced endpoints, maps to schema. Exports `fetchFalImageModels()` / `fetchFalVideoModels()`. Auth: `FAL_API_KEY` env. |
| `scripts/fetch-aa.mjs` | Artificial Analysis benchmark sidecar — fetches AA intelligence/coding/agentic indices (live, `ARTIFICIAL_ANALYSIS_API_KEY`) with committed `data/aa-benchmarks.json` fallback cache; exposes `buildIndexFromModels` for tests. |
| `scripts/fetch-neuralwatt-energy.mjs` | Neuralwatt SSR energy scrape — per-model Wh/request bands with 24h daily estimator cache (`data/neuralwatt-estimator-cache.json`). |
| `scripts/fetch-performance.mjs` | Performance sidecar: OR + direct-provider latency/throughput → `public/performance.json`. Skip-if-unchanged write (the pattern `maybeWriteJson` generalizes), 85% record-count guard. |
| `scripts/minify-json.mjs` | Strips whitespace from `public/*.json` (JSON.parse+stringify) right before deploy; fails fast on parse error. |
| `shared/cost.mjs` | Pure mix-cost math (`blendedRate`, `AGENTIC_MIX`) shared by `generate-seo.mjs` + API + tests. No `node:` imports (Worker-safe). `app.js` keeps a mirrored copy pinned by `test/generate-seo.test.mjs`. |
| `shared/performance.mjs` | Pure merge helper for performance data — OR records preserved, direct-provider keys overwritten. Worker-safe. |
| `shared/umans-status.mjs` | Umans status snapshot extraction from status.umans.ai SSR (`__next_f` flight chunks). Pure, Worker-safe. |
| `data/aa-benchmarks.json` | Committed AA benchmark cache (79 KB) — refreshed weekly by `refresh-aa.yml`, used as offline fallback by `fetch-aa.mjs`. |
| `public/image.html` + `public/image-app.js` | Image pricing tab: calculator (count × $/unit), provider + model typeahead search, unit-adaptive table, variant filter, mobile card layout, mobile sort dropdown |
| `public/video.html` + `public/video-app.js` | Video pricing tab: calculator (seconds × $/sec), provider + model typeahead search, resolution + audio filters, mobile card layout, mobile sort dropdown |
| `public/image-pricing.json` | Generated data — ~160 image models with pricing arrays (image/megapixel/token units); includes fal.ai merge |
| `public/video-pricing.json` | Generated data — ~100 video models with per-second pricing (resolution + audio variants); includes fal.ai merge |
| `test/` | Automated test suite (`node --test`, 23 files / 277 tests): `canonicalization.test.mjs` (canonicalId/orgLookupKey/quantFromId), `parity.test.mjs` (regression guards against real pricing.json: coverage floors, quant distinctness, frontend parity), `api.test.mjs` (API routing/filters/sort/mix with mocked env.ASSETS), `video-audio.test.mjs` (audio filter regression), plus benchmarks/aa-enrichment/modelsdev/neuralwatt/fal-canonicalization/coverage-drop/performance-*/provider-parser tests (including Aster), umans-snapshot, url-state, `generate-seo.test.mjs`, and `write-if-changed.test.mjs`. Fixtures live in `test/fixtures/`. |

## Development

```bash
npm run fetch           # Fetch text pricing (~317 API calls, ~15-20s)
npm run fetch:images    # Fetch image pricing (~40 API calls, ~12s)
npm run fetch:videos    # Fetch video pricing (fetches video models list, ~2s)
npm run fetch:fal       # Fetch fal.ai image+video pricing standalone (writes /tmp/fal-image.json and /tmp/fal-video.json)
npm run fetch:all       # Run all three fetchers
npm run serve           # Serve public/ on localhost:3000
npm test                # Run the test suite (node --test, zero-dep)
npm run seo             # Server-render cheapest models into index.html + generate sitemap.xml/robots.txt (run before deploy)
npm run bust:cache      # Rewrite ?v= tokens in public/*.html to content hashes
```

## Deployment

Cloudflare Pages project: `payg-inference-calculator`
- Custom domain: https://tokenwatch.wyrdwerk.com (also at https://payg-inference-calculator.pages.dev)
- Production branch: `main`
- Build output: `public/`
- GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATA_BOT_APP_ID`, `DATA_BOT_PRIVATE_KEY`, `FAL_API_KEY`, `OPENROUTER_API_KEY`, `ARTIFICIAL_ANALYSIS_API_KEY`, `SINGULARITY_API_KEY`, `RUNINFRA_API_KEY` (9 total)
- Auto-deploy on push to main (deploy-only) + 2-hourly cron (fetch+commit+deploy)

Manual deploy: `npx wrangler pages deploy public --project-name payg-inference-calculator --branch main --commit-dirty true`

### Deploy gotchas

- **`public/h/` must NOT be gitignored**: `wrangler pages deploy` respects `.gitignore`. If `public/h/` (path-fingerprinted assets generated by `bust-cache.mjs`) is gitignored, those files are NOT uploaded. Cloudflare's SPA fallback serves `index.html` (`text/html`) for JS requests, and the `_headers` immutable rule (`/h/* max-age=31536000`) caches that broken response for 1 year. The site will appear broken (table stuck loading, buttons dead) with no JS errors in the console — the browser silently parses HTML as JS and fails. **Fix**: run `npm run bust:cache` before every deploy, ensure `public/h/` is not in `.gitignore`, and verify the bare hashed JS URL returns `application/javascript` (not `text/html`) after deploy.
- **Stale edge cache recovery**: If a broken `/h/*` response is already cached, changing the content (new hash = new URL) bypasses the stale entry. Temporarily set `_headers` `/h/*` to `must-revalidate`, deploy, verify the new bare URL serves correct content-type, then restore `immutable` in a follow-up deploy.
- **Verify bare URLs**: After deploy, always check `curl -sSI https://tokenwatch.wyrdwerk.com/h/app.<hash>.js | grep content-type` returns `application/javascript` — not just HTTP 200.
- **SEO files must be deployed**: `sitemap.xml`, `robots.txt`, `favicon.svg`, and `og/og-image.svg` are committed and deployed with `public/`. `generate-seo.mjs` now **runs in every CI deploy** (refresh + deploy + refresh-aa jobs), regenerating the server-rendered table, sitemap, and robots from the committed `pricing.json` — the committed `index.html` may be stale between runs, which is expected. Local `npm run seo` is still the pre-deploy manual path (idempotent). Cloudflare injects its own managed `robots.txt` rules (AI-crawler disallows) alongside the committed one — that's expected.

## API endpoints

- `GET /api/v1/` — API info and endpoint directory
- `GET /api/v1/stats` — summary: model count, provider count, org count, ZDR count, subscription count, cache_read/cache_write counts, quantization breakdown, per-provider and per-org counts, source_providers
- `GET /api/v1/orgs` — all orgs with model counts, sorted by count descending
- `GET /api/v1/providers` — provider metadata (privacy/ToS/status URLs, HQ, datacenters, `retains_prompts`, `may_train`, `retention_days`). Optional `?zdr=true` filters to ZDR-compliant providers only.
- `GET /api/v1/models` — list models with filters: `?org=`, `?provider=`, `?min_context=`, `?min_output=`, `?quantization=`, `?cache_read=true`, `?cache_write=true`, `?promo=true`, `?zdr=true`, `?sub=true`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `input`, `output`, `cache_read`, `cache_write`, `context`, `max_output`, `uptime`, `discount`, `intelligence`, `coding`, `agentic`. Model objects include `zdr: true` and `subscription: true` when applicable.
- `GET /api/v1/models/:canonicalId/providers` — all providers hosting a model, sorted by cost (includes `zdr` and `subscription` fields per provider). Optional `?tokens=N&mix=inputPct,cachePct,outputPct` for mix-aware cost sorting.
- `GET /api/v1/images` — list image models with filters: `?org=`, `?provider=`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `org`, `provider`.
- `GET /api/v1/images/:id` — single image model with pricing variants (accepts bare canonical ID or full `org/model` ID)
- `GET /api/v1/videos` — list video models with filters: `?org=`, `?provider=`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `org`, `provider`.
- `GET /api/v1/videos/:id` — single video model with pricing variants (accepts bare canonical ID or full `org/model` ID)

## Image & Video Generation (separate catalogs)

OpenRouter has dedicated APIs for image and video generation — separate from the chat `/v1/models` endpoint. These are fetched by `fetch-images.mjs` and `fetch-videos.mjs`.

### Image pipeline (`scripts/fetch-images.mjs`)
- Source: `GET /api/v1/images/models` → `GET /api/v1/images/models/:id/endpoints` per model
- OpenRouter image models (list fetched dynamically from `/api/v1/images/models`, auto-router excluded), pricing from endpoint `pricing[]` array with `billable: "output_image"`. Final catalog ~160 after fal.ai merge + dedup.
- 3 unit types: `image` (flat per-image, computable), `megapixel` (per-MP, varies), `token` (per-image-token, varies)
- Model creator = provider (no de-aggregation; each model has one endpoint)
- Shared lib (`scripts/lib.mjs`) for org extraction, dedup, HTTP retry, coverage guard, `--dry-run`
- Writes `public/image-pricing.json` — model records with `pricing[]` array

### Video pipeline (`scripts/fetch-videos.mjs`)
- Source: `GET /api/v1/videos/models` — pricing_skus on model level (no endpoint fetch)
- OpenRouter video models (list fetched dynamically from `/api/v1/videos/models`, auto-router excluded); `pricing_skus` parsed at model level (no endpoint fetch). Models without parsable per-second pricing are skipped. Final catalog ~100 after fal.ai merge + dedup.
- Normalization: cent-denominated keys (`cents_*`) → dollars; non-per-second keys (`video_tokens`) filtered out
- Writes `public/video-pricing.json` — per-second pricing with resolution + audio variants

### fal.ai pipeline (`scripts/fetch-fal.mjs`)
- Source: `GET /v1/models` (paginated, 500/page) + `GET /v1/models/pricing?endpoint_id=...` (batched 50/call) — both authenticated (`Authorization: Key ${FAL_API_KEY}`)
- Filters: `metadata.status === 'active'`, category in image/video sets, paid pricing in includable unit
- Includable units: `images`/`megapixels`/`processed megapixels` (image); `seconds`/`5 seconds`(÷5)/`minutes`(÷60) (video)
- Excluded: `compute seconds` (GPU-time, not output-based), `videos` (flat per-video, no duration data to convert to per-second), `generations`/`units`/`credits`/token-based, ~770 free/unpriced endpoints
- Canonicalization: `falCanonicalId()` (in `scripts/lib.mjs`) preserves model identity from nested paths (`fal-ai/kling-video/v3/pro/image-to-video` → `kling-video-v3-pro`); drops pure-modality segments (`image-to-video`, `edit`, etc.) anywhere in the path. The shared `canonicalId` would collapse all variants to `image-to-video`.
- Org extraction: `FAL_ORG_MAP` (41 families: flux→black-forest-labs, kling-video→kuaishou, nano-banana→google, etc.); `fal` fallback for long tail (~100 community/specialty models)
- Non-fatal: returns `[]` on failure; image/video pipelines continue without fal data
- Rate limiting: 500ms delay between pricing batches + exponential-backoff retry on 429 (`MAX_RETRIES = 5`, Retry-After honored, capped at 30s)
- Merge: fal rows prepended to OpenRouter arrays → `dedupModels` gives Tier-1 precedence (first-seen wins). First model-level dedup in fetch-images/fetch-videos.
- Auth: `FAL_API_KEY` GitHub secret, injected as env var on the image + video fetch CI steps
- Coverage: raw fal.ai endpoint scan historically ~270 image + ~145 video includable endpoints from ~1,398 listed (many free/excluded units). **Emitted catalogs after OR+fal merge + dedup: ~160 image, ~100 video** in `public/image-pricing.json` / `public/video-pricing.json`.

### Frontend tabs
- `public/image.html` + `public/image-app.js`: image calculator (count × $/image for flat-priced; varies for others), provider + model typeahead search, variant/resolution filter, sortable table with unit-adaptive columns, mobile card layout via data-label, mobile sort dropdown
- `public/video.html` + `public/video-app.js`: video calculator (seconds × $/sec), provider + model typeahead search, resolution + audio filters, mobile card layout via data-label, mobile sort dropdown
- Tab navigation bar (Text/Image/Video) on all three pages, shared `styles.css` (including responsive: 768px control stacking, 640px table→card transform, mobile-sort visibility)
- **WebMCP (text, image, and video calculators)**: `public/webmcp.js` feature-detects `document.modelContext`, waits for `window.TWCatalog` (`tw-catalog-ready` after a successful catalog load), registers 20 text tools or four page-specific image/video tools, and aborts on `pagehide`. Tools call existing UI functions via the façade — never copy cost math. `webmcp.js` **must** stay in `scripts/bust-cache.mjs` `FINGERPRINT`. Details: [docs/WEBMCP.md](docs/WEBMCP.md).

### CI/CD
Three jobs in `.github/workflows/refresh-pricing.yml`:
- **`test`** (push/PR): runs `node --test test/*.test.mjs` — gates the `deploy` job via `needs: test`.
- **`refresh`** (every 2h cron + manual): test → fetch all pipelines + performance → commit JSON only (`git add public/*.json`) → bust-cache → deploy. The cache-bust rewrites `?v=` tokens to content hashes in the checked-out HTML; the rewritten HTML is deployed but NOT committed.
- **`deploy`** (push to main): test (via `needs: test`) → bust-cache → deploy. No fetch, no commit — just re-publishes `public/` with fresh cache hashes.

All three JSON files (`pricing.json`, `image-pricing.json`, `video-pricing.json`) committed and deployed together by the `refresh` job.

## Next steps

1. **Subscription pricing details**: Show subscription plan pricing (monthly cost, token quotas) for the 13 subscription providers. Would need integration with codingplans.cc or manual CSV maintenance.
2. **Auth-gated providers**: SingularityAPI and RunInfra are wired (`SINGULARITY_API_KEY`, `RUNINFRA_API_KEY`). Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate, Mistral remain postponed — already covered via OpenRouter `/endpoints` backends.
3. **CSV maintenance**: `data/manual-pricing.csv` needs periodic manual updates for Makora/Xiaomimimo pricing. If these models appear in OpenRouter backends, the CSV could be dropped.
4. **Turbo/preview grouping**: Currently turbo and preview variants are kept separate. Could add UI to group them with their base model.
5. **Historical price tracking**: Store daily snapshots to surface price-drop alerts or trend charts.
6. **EmberCloud provider metadata**: `MANUAL_PROVIDER_META` for ember has URLs filled but no HQ/datacenters — update if available.
7. **ZDR tooltip**: Hover tooltip with retention policy details; retention days in compare modal (badge only today).
8. **Cache-write model revisit**: Simplifying "if cache_write exists, bill all input at cache_write" was considered and deferred — 50/131 models have `cache_write < input` and 29 have `cache_write === 0`, so it would understate cost. Keep amortized one-time charge for now.
9. **SEO content pages**: Build per-provider / per-model landing pages + workload pages (agentic, coding-agent, RAG) to rank for high-intent queries. See [docs/conversations/20260803-seo-gsc-setup-public.md](docs/conversations/20260803-seo-gsc-setup-public.md).

### Historical plans (SHIPPED)
Design plans under `docs/superpowers/plans/` and `docs/superpowers/specs/` (2026-07-09) for fal.ai, quality benchmarks, and models.dev enrichment are **complete** — treat as historical artifacts, not pending work. Also shipped: Hyper Tier-1 direct migration, Blended $/M column, Export CSV, Speed row in compare modal.
