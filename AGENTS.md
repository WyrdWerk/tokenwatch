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

Static site comparing pay-as-you-go LLM API pricing across inference providers. Uses OpenRouter's `/endpoints` API to de-aggregate per-backend pricing (each backend like DeepInfra, Fireworks, Together becomes its own row). Zero dependencies, pure Node ESM. Deployed to Cloudflare Pages with daily CI/CD refresh + auto-deploy on push.

## Architecture

- **Data pipeline**: `scripts/fetch-pricing.mjs` fetches pricing from 3 tiers:
  - **Tier 1 — Direct providers** (authoritative): DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova — fetched via their own `/v1/models` endpoints
  - **Tier 2 — OpenRouter de-aggregated**: `/v1/models` lists models, then `/endpoints` per model returns per-backend pricing. Each backend (Fireworks, Together, Novita, SiliconFlow, etc.) becomes its own row — NOT "OpenRouter"
  - **Tier 3 — CSV/hardcoded**: Hyper, Makora, Xiaomimimo (CSV), OpenCode Go (hardcoded)
  - **3-tier precedence**: `(canonical_model, normalized_provider)` — direct wins over OpenRouter, which wins over CSV/hardcoded. Quantization is NOT part of the dedup key — same model+provider at different quants collapses to one row (first-seen/highest-tier wins).
  - Writes `public/pricing.json` with ~910 text-generation models across ~75 inference providers. **648 models (71%) are ZDR-tagged.**
- **models.dev enrichment**: after the 3-tier fetch + dedup, `fetch-pricing.mjs` calls `fetchModelsDevEnrichment()` (sidecar, non-fatal) which pulls `https://models.dev/api.json` and builds a `(provider, normalizedModelId)` index. `applyEnrichment()` decorates each model with a `modelsdev` block (base URL, native model ID, capability metadata) and fills `null` cache_read/cache_write/context_length/max_output values. Never overwrites existing values. Two-tier matching: Tier A (exact normalized, confidence `'high'`) + Tier B (bounded fuzzy subset, confidence `'medium'`, surfaces a ⚠ pill in the UI).
- **ZDR (Zero Data Retention)**: Two-stage tagging in `main()`:
  1. **Endpoint-level**: `fetchZdrEndpoints()` fetches `/api/v1/endpoints/zdr` (documented, no auth) and builds a Set of `dedupKey()` strings. Models matching the set get `zdr: true`.
  2. **Provider-level fallback**: models not tagged at endpoint level are checked against `providers_meta[provider].retains_prompts === false`.
  - `MANUAL_PROVIDER_META` includes `retains_prompts`, `may_train`, `retention_days` for 8 manual providers (crof, ember, hyper, lilac, makora, synthetic, opencode, xiaomimimo) based on privacy policy review.
- **Provider metadata**: `fetchProviderMeta()` fetches 3 sources: (1) `MANUAL_PROVIDER_META` (manual, includes ZDR fields), (2) OpenRouter `/api/v1/providers` (policy URLs, HQ, datacenters — guarded to not overwrite manual entries), (3) `/api/frontend/all-providers` (undocumented, non-fatal enrichment for `dataPolicy.retainsPrompts`, `training`, `retentionDays`). Alias resolution via `PROVIDER_NAME_MAP` (e.g. `xiaomimimo` inherits `xiaomi` metadata).
- **Frontend**: `public/` static site loads `pricing.json` client-side. Typeahead search (by inference provider and by model) on all three pages (text, image, video) via native HTML5 datalist. Cost computation entirely in-browser. Features: group-by toggle (None/Org/Provider), comparison mode (up to 6, side-by-side modal), cost mode toggle (Per Session / Monthly Volume with ×30 multiplier), budget mode (Budget → Tokens/Count/Seconds inverse affordability calculator on all 3 tabs), URL hash state persistence, provider HQ flag badges, ZDR badges + "ZDR only" filter, privacy/ToS/status links, promo badges + "Promos only" filter, cache-write cost amortization input. Mobile: table→card layout at ≤640px via `td[data-label]` attributes on all pages; mobile sort dropdown (`<select class="mobile-sort">`) visible only at ≤640px with bidirectional sync to desktop column header clicks.
- **API**: Cloudflare Pages Functions at `functions/api/v1/` serve queryable endpoints: `/api/v1/models` (with filters: org, provider, min_context, min_output, quantization, cache_read, cache_write, promo, zdr, sub, search, sort), `/api/v1/models/:id/providers` (mix-aware cost sort), `/api/v1/stats` (org/zdr/sub/quantization breakdowns), `/api/v1/orgs`, `/api/v1/providers` (?zdr=true), `/api/v1/images`, `/api/v1/images/:id`, `/api/v1/videos`, `/api/v1/videos/:id`. CORS enabled.
- **Widget**: `public/widget/embed.js` — embeddable JS snippet using Shadow DOM, auto-detects `[data-tw-model]` elements, fetches the API, renders compact pricing cards.
- **CI/CD**: `.github/workflows/refresh-pricing.yml` — daily cron at 00:00 UTC (fetch → commit → deploy) + push-to-main trigger (deploy-only, no fetch).

## Key conventions

### Pricing normalization

All prices are stored as **USD per million tokens ($/M)**. Conversion by source:
- OpenRouter `/endpoints`: $/token → ×1e6
- SambaNova / EmberCloud / Lilac: $/token → ×1e6
- DeepInfra / Crof / Hyper / Makora / Xiaomimimo / OpenCode Go: $/M (passthrough)
- Wafer: cents/M → ÷100
- Synthetic: $/token → ×1e6, cache_read = input × 0.20 (per spec, not from API)

### Endpoint fields captured from OpenRouter

- `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, `pricing.input_cache_write` → all converted to $/M
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
- **Other direct providers** (Crof, Wafer, Lilac): ID-based regex fallback for embeddings/TTS (no structured metadata available).

### Provider-name normalization

`PROVIDER_NAME_MAP` reconciles direct-provider keys (`ember`, `deepinfra`, `wafer`) with OpenRouter display names (`EmberCloud`, `DeepInfra`, `Wafer`) for dedup precedence. Also used for provider metadata alias resolution (e.g. `xiaomimimo` → `xiaomi`). Direct providers also stored in `providers` array with display names for frontend rendering.

### Provider metadata

`providers_meta` top-level key in pricing.json contains per-provider policy data:
- `privacy_policy_url`, `terms_of_service_url`, `status_page_url` — from OpenRouter `/api/v1/providers` or `MANUAL_PROVIDER_META`
- `headquarters` — country code (US, SG, CN, etc.)
- `datacenters` — array of region codes
- `source` — `openrouter` or `manual`

Manual entries (`MANUAL_PROVIDER_META` in fetch-pricing.mjs) cover providers not in OR: crof, ember, hyper, lilac, makora, synthetic, opencode, xiaomimimo. **Manual entries take precedence** — OR data only fills missing URL fields when the slug matches a manual entry; manual ZDR/policy fields are never overwritten.

### Org extraction

The `org` field identifies the underlying model creator (not the inference provider):
1. From parser-set org (Synthetic from `hugging_face_id`, SambaNova from leading ID segments via `ORG_ALIASES`)
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

## Files to know

| File | Purpose |
|---|---|
| `shared/normalize.mjs` | Pure canonicalization helpers (`canonicalId`, `orgLookupKey`) — imported by both the Node pipeline and the Cloudflare Pages Function. No `node:` imports so it bundles cleanly into the Worker. |
| `shared/modelsdev.mjs` | Pure reconciliation helpers for the models.dev enrichment source — provider map, per-provider ID normalizers (cloudflare/amazon/fireworks/minimax), two-tier matcher (exact + bounded fuzzy). Imported by the pipeline via `scripts/lib.mjs`. |
| `scripts/fetch-pricing.mjs` | 3-tier fetch, OpenRouter de-aggregation, ZDR tagging (endpoint + provider level), provider metadata + data policy enrichment, org extraction, dedup, pricing normalization, dry-run mode — imports shared utils from `scripts/lib.mjs` |
| `scripts/fetch-modelsdev.mjs` | Sidecar fetcher for models.dev enrichment — pulls `https://models.dev/api.json` (single call, non-fatal), builds the `(twProvider → normalizedId → record)` index. Called by `fetch-pricing.mjs` after subscription tagging. |
| `public/app.js` | Frontend state, URL hash persistence, search, cost computation (per-request + monthly ×30), group-by, comparison mode, ZDR filter/badge, HQ badges, meta links, rendering |
| `public/index.html` | UI layout: controls, usage-grid with mode toggle, 10-column results table, ZDR + promo filters, group-by, comparison tray + modal |
| `public/styles.css` | Dark/light theme, all badges (org, provider, promo, ZDR, HQ, meta-link), group headers, comparison modal/tray, mode toggle, responsive |
| `public/pricing.json` | Generated data — models (with pricing, cache_write, uptime_30m, max_completion_tokens, zdr), providers, providers_meta (with retains_prompts, may_train, retention_days) — do not hand-edit, CI refreshes daily |
| `functions/api/v1/[[route]].js` | Cloudflare Pages Functions API — imports `canonicalId` from `shared/normalize.mjs`. /models (with filters: org, provider, min_context, min_output, quantization, cache_read, cache_write, promo, zdr, sub, search, sort), /models/:id/providers (mix-aware cost sort), /stats (org/zdr/sub/quantization breakdowns), /orgs, /providers (?zdr=true), /images, /images/:id, /videos, /videos/:id, CORS |
| `public/widget/embed.js` | Embeddable widget — Shadow DOM, auto-detects [data-tw-model], fetches API, renders pricing card |
| `public/widget/demo.html` | Widget demo page |
| `.github/workflows/refresh-pricing.yml` | Three jobs: `test` (push/PR, runs `node --test`), `refresh` (daily cron: test→fetch→commit JSON→bust-cache→deploy), `deploy` (push: test→bust-cache→deploy). Cache-busting rewrites `?v=` tokens to content hashes before deploy (not committed). |
| `data/manual-pricing.csv` | Static pricing for CSV-sourced providers (Hyper, Makora, Xiaomimimo) |
| `scripts/lib.mjs` | Shared utilities: org extraction, dedup, HTTP retry, coverage guard, dry-run — imported by all three fetchers. Re-exports `canonicalId`/`orgLookupKey` from `shared/normalize.mjs`. |
| `scripts/bust-cache.mjs` | Rewrites `?v=` cache-bust tokens in `public/*.html` to 8-char SHA-1 content hashes of the referenced assets. Run before deploy in CI (deploy + refresh jobs) and locally via `npm run bust:cache`. |
| `scripts/fetch-images.mjs` | Image pipeline: fetch `/images/models` + `/endpoints`, normalize flat/megapixel/token pricing → `public/image-pricing.json` |
| `scripts/fetch-videos.mjs` | Video pipeline: fetch `/videos/models`, normalize cents→dollars, filter per-second → `public/video-pricing.json` |
| `public/image.html` + `public/image-app.js` | Image pricing tab: calculator (count × $/unit), provider + model typeahead search, unit-adaptive table, variant filter, mobile card layout, mobile sort dropdown |
| `public/video.html` + `public/video-app.js` | Video pricing tab: calculator (seconds × $/sec), provider + model typeahead search, resolution + audio filters, mobile card layout, mobile sort dropdown |
| `public/image-pricing.json` | Generated data — 34 image models with pricing arrays (image/megapixel/token units) |
| `public/video-pricing.json` | Generated data — 13 video models with per-second pricing (resolution + audio variants) |
| `test/` | Automated test suite (`node --test`): `canonicalization.test.mjs` (canonicalId/orgLookupKey behavior), `parity.test.mjs` (regression guard against real pricing.json), `api.test.mjs` (API routing/filters/sort with mocked env.ASSETS), `video-audio.test.mjs` (audio filter regression). Fixtures in `test/fixtures/`. |

## Development

```bash
npm run fetch           # Fetch text pricing (~317 API calls, ~15-20s)
npm run fetch:images    # Fetch image pricing (~40 API calls, ~12s)
npm run fetch:videos    # Fetch video pricing (1 API call, ~2s)
npm run fetch:all       # Run all three fetchers
npm run serve           # Serve public/ on localhost:3000
npm test                # Run the test suite (node --test, zero-dep)
npm run bust:cache      # Rewrite ?v= tokens in public/*.html to content hashes
```

## Deployment

Cloudflare Pages project: `payg-inference-calculator`
- Custom domain: https://tokenwatch.wyrdwerk.com (also at https://payg-inference-calculator.pages.dev)
- Production branch: `main`
- Build output: `public/`
- GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Auto-deploy on push to main (deploy-only) + daily cron (fetch+commit+deploy)

Manual deploy: `npx wrangler pages deploy public --project-name payg-inference-calculator --branch main --commit-dirty true`

## API endpoints

- `GET /api/v1/` — API info and endpoint directory
- `GET /api/v1/stats` — summary: model count, provider count, org count, ZDR count, subscription count, cache_read/cache_write counts, quantization breakdown, per-provider and per-org counts, source_providers
- `GET /api/v1/orgs` — all orgs with model counts, sorted by count descending
- `GET /api/v1/providers` — provider metadata (privacy/ToS/status URLs, HQ, datacenters, `retains_prompts`, `may_train`, `retention_days`). Optional `?zdr=true` filters to ZDR-compliant providers only.
- `GET /api/v1/models` — list models with filters: `?org=`, `?provider=`, `?min_context=`, `?min_output=`, `?quantization=`, `?cache_read=true`, `?cache_write=true`, `?promo=true`, `?zdr=true`, `?sub=true`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `input`, `output`, `cache_read`, `cache_write`, `context`, `max_output`, `uptime`, `discount`. Model objects include `zdr: true` and `subscription: true` when applicable.
- `GET /api/v1/models/:canonicalId/providers` — all providers hosting a model, sorted by cost (includes `zdr` and `subscription` fields per provider). Optional `?tokens=N&mix=inputPct,cachePct,outputPct` for mix-aware cost sorting.
- `GET /api/v1/images` — list image models with filters: `?org=`, `?provider=`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `org`, `provider`.
- `GET /api/v1/images/:id` — single image model with pricing variants (accepts bare canonical ID or full `org/model` ID)
- `GET /api/v1/videos` — list video models with filters: `?org=`, `?provider=`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `org`, `provider`.
- `GET /api/v1/videos/:id` — single video model with pricing variants (accepts bare canonical ID or full `org/model` ID)

## Image & Video Generation (separate catalogs)

OpenRouter has dedicated APIs for image and video generation — separate from the chat `/v1/models` endpoint. These are fetched by `fetch-images.mjs` and `fetch-videos.mjs`.

### Image pipeline (`scripts/fetch-images.mjs`)
- Source: `GET /api/v1/images/models` → `GET /api/v1/images/models/:id/endpoints` per model
- 34 models, pricing from endpoint `pricing[]` array with `billable: "output_image"`
- 3 unit types: `image` (flat per-image, computable), `megapixel` (per-MP, varies), `token` (per-image-token, varies)
- Model creator = provider (no de-aggregation; each model has one endpoint)
- Shared lib (`scripts/lib.mjs`) for org extraction, dedup, HTTP retry, coverage guard, `--dry-run`
- Writes `public/image-pricing.json` — model records with `pricing[]` array

### Video pipeline (`scripts/fetch-videos.mjs`)
- Source: `GET /api/v1/videos/models` — pricing_skus on model level (no endpoint fetch)
- 16 models listed, 13 with per-second pricing (3 Seedance models excluded — per-token only)
- Normalization: cent-denominated keys (`cents_*`) → dollars; non-per-second keys (`video_tokens`) filtered out
- Writes `public/video-pricing.json` — per-second pricing with resolution + audio variants

### Frontend tabs
- `public/image.html` + `public/image-app.js`: image calculator (count × $/image for flat-priced; varies for others), provider + model typeahead search, variant/resolution filter, sortable table with unit-adaptive columns, mobile card layout via data-label, mobile sort dropdown
- `public/video.html` + `public/video-app.js`: video calculator (seconds × $/sec), provider + model typeahead search, resolution + audio filters, mobile card layout via data-label, mobile sort dropdown
- Tab navigation bar (Text/Image/Video) on all three pages, shared `styles.css` (including responsive: 768px control stacking, 640px table→card transform, mobile-sort visibility)

### CI/CD
Three jobs in `.github/workflows/refresh-pricing.yml`:
- **`test`** (push/PR): runs `node --test test/*.test.mjs` — gates the `deploy` job via `needs: test`.
- **`refresh`** (daily cron + manual): test → fetch all three pipelines → commit JSON only (`git add public/*.json`) → bust-cache → deploy. The cache-bust rewrites `?v=` tokens to content hashes in the checked-out HTML; the rewritten HTML is deployed but NOT committed.
- **`deploy`** (push to main): test (via `needs: test`) → bust-cache → deploy. No fetch, no commit — just re-publishes `public/` with fresh cache hashes.

All three JSON files (`pricing.json`, `image-pricing.json`, `video-pricing.json`) committed and deployed together by the `refresh` job.

## Next steps

1. **Subscription pricing details**: Show subscription plan pricing (monthly cost, token quotas) for the 13 subscription providers. Would need integration with codingplans.cc or manual CSV maintenance.
2. **Auth-gated providers**: Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate, Mistral have auth-gated `/v1/models` endpoints. Would need API keys as GitHub Actions secrets. All are already covered via OpenRouter `/endpoints` backends — direct fetch would give Tier-1 precedence + fresher data, not new coverage.
3. **CSV maintenance**: `data/manual-pricing.csv` needs periodic manual updates for Hyper/Makora/Xiaomimimo pricing. If these models appear in OpenRouter backends, the CSV could be dropped.
4. **Turbo/preview grouping**: Currently turbo and preview variants are kept separate. Could add UI to group them with their base model.
5. **Historical price tracking**: Store daily snapshots to surface price-drop alerts or trend charts.
6. **EmberCloud provider metadata**: `MANUAL_PROVIDER_META` for ember has URLs filled but no HQ/datacenters — update if available.
