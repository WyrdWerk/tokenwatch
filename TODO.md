# TokenWatch — ToDos

## Critical bugs

### STALE CACHE — column misalignment on returning visitors
**Status**: ✅ FIXED (automated). `scripts/bust-cache.mjs` rewrites `?v=` tokens in `public/*.html` to 8-char SHA-1 content hashes of the referenced assets. Runs automatically in CI before every deploy (both `deploy` and `refresh` jobs). The repo HTML keeps its old `?v=` strings; the busted HTML is deployed but not committed. No more manual version-string bumps.

### MOBILE RESPONSIVE LAYOUT — ✅ SHIPPED
Card layout + mobile sort dropdown shipped at ≤640px across all 3 tabs. See README Usage > Mobile.


## Planned features

### ZDR (Zero Data Retention) — ✅ IMPLEMENTED
**Status**: Implemented. 648 of 910 models (71%) tagged ZDR.

**What's done**:
- Pipeline: two-stage ZDR tagging via OpenRouter `/api/v1/endpoints/zdr` (endpoint-level) + `/api/frontend/all-providers` (provider-level fallback)
- Manual providers: privacy policies reviewed for Crof (ZDR), Lilac (ZDR), Synthetic (ZDR), Makora (ZDR on PAYG), Hyper (not ZDR, 30d retention), OpenCode (not ZDR), Xiaomi (not ZDR)
- `MANUAL_PROVIDER_META` enriched with `retains_prompts`, `may_train`, `retention_days`, `headquarters`, `datacenters`
- Frontend: green ZDR badge on provider cells, "ZDR only" filter checkbox, ZDR row in compare modal, URL hash `#zdr=1`
- API: `?zdr=true` filter on `/api/v1/models`, `zdr` field on `/api/v1/models/:id/providers` response
- `providers_meta` includes `retains_prompts`, `may_train`, `retention_days` for 102 providers

**Remaining**:
- EmberCloud ZDR status not yet determined (no policy URLs reviewed)
- Tooltip showing retention policy details on hover (currently badge only)
- Data retention info in comparison modal (ZDR badge shown, retention days not displayed)

### Subscription badges — ✅ IMPLEMENTED
**Status**: Implemented. 142 models across 13 providers tagged.

**What's done**:
- Provider-level subscription tagging for coding plan providers: Hyper, Synthetic, Lilac, Makora, Opencode Go, Z.AI, Minimax, Xiaomi, Alibaba, Chutes, Moonshot, X AI, Xiaomimimo
- `SUBSCRIPTION_PROVIDERS` Set in fetch-pricing.mjs for manual provider-level tagging
- Frontend: blue "Sub" badge stacked with ZDR badge on provider cells, "Sub only" filter checkbox, Sub badge in compare modal ZDR row, URL hash `#sub=1`
- API: `?sub=true` filter on `/api/v1/models`, `subscription` field on `/api/v1/models/:id/providers` response
- Cache-bust version bumped to `?v=20260707e`

**Remaining**:
- Subscription pricing details (monthly cost, token quotas) — would need data source like codingplans.cc or manual CSV maintenance

### Budget mode — ✅ SHIPPED
**Status**: Implemented on all 3 tabs. Inverse affordability calculator — enter a $ budget, see how many tokens/images/seconds each provider offers, ranked by affordability.

**What's done**:
- Text tab: Budget → Tokens (M), with token-mix percentages and cache-write amortization factored in
- Image tab: Budget → Count (flat per-image units only; megapixel/token units show "varies")
- Video tab: Budget → Seconds
- Sort direction auto-flips when on cost column; exclusion filter symmetric with forward mode (drops offerings that can't serve the requested token mix)
- URL hash persistence (`#by=budget`, `#budget=N`)

### Auth-gated direct providers (A1 — postponed)
Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate, Mistral all have auth-gated `/v1/models` endpoints. All are already covered as OpenRouter backends (Tier 2). Direct fetch would give Tier-1 precedence + fresher data, not new model coverage. Postponed until user has API keys.

### Historical price tracking (A7 — not started)
Store daily pricing.json snapshots to enable price-drop alerts, trend charts, and "cheapest this model has ever been" features. Would require a `pricing-history/` archive or Cloudflare D1/KV storage.

### EmberCloud provider metadata
`MANUAL_PROVIDER_META` for ember has privacy/ToS URLs filled but no HQ/datacenters — update if available.

### Image & Video Generation Tabs — ✅ IMPLEMENTED
**Status**: Implemented. 34 image models, 13 video models across separate tabs.

**What's done**:
- `scripts/lib.mjs`: shared utilities extracted from fetch-pricing.mjs (org extraction, dedup, HTTP retry, coverage guard, --dry-run)
- `scripts/fetch-images.mjs`: fetches 34 image models from OpenRouter `/api/v1/images/models` + `/endpoints`, handles 3 unit types (image/megapixel/token), writes `public/image-pricing.json`
- `scripts/fetch-videos.mjs`: fetches 13 video models from `/api/v1/videos/models`, normalizes cents→dollars, filters per-second only, writes `public/video-pricing.json`
- `public/image.html` + `image-app.js`: image calculator (count × $/unit), unit-adaptive table, variant filter
- `public/video.html` + `video-app.js`: video calculator (seconds × $/sec), resolution + audio filters
- Tab navigation (Text/Image/Video) on all pages, shared from `styles.css`
- CI: daily cron runs all three fetch scripts

**Remaining**:
- Video: Seedance models (3) excluded — only have per-token pricing, no per-second SKUs yet
- Image: token-priced models show $/M image-tokens but can't compute per-image cost without tokens-per-image ratio from provider

### Turbo/preview model grouping
Currently turbo and preview variants are kept separate. Could add UI to group them with their base model.

### ~~Cache write in cost computation~~ ✅ IMPLEMENTED
The **Advanced: cache write** collapsible section allows cache-population tokens (one-time) with amortization over N requests, included in Total Cost.

### API enhancements — ✅ IMPLEMENTED
**Status**: Implemented. Extended the Cloudflare Pages Functions API to serve all three catalogs (text/image/video) with new filters, sort keys, and endpoints — all backed by existing data.

**New endpoints**:
- `GET /api/v1/orgs` — all orgs with model counts (53 orgs)
- `GET /api/v1/images` — list image models (34 models) with org/provider/search/sort filters
- `GET /api/v1/images/:id` — single image model with pricing variants (accepts bare canonical or full `org/model` ID)
- `GET /api/v1/videos` — list video models (13 models) with org/provider/search/sort filters
- `GET /api/v1/videos/:id` — single video model with pricing variants

**New filters on `/api/v1/models`**:
- `?quantization=` — filter by quantization type (fp8, fp4, fp16, bf16, int4, unknown)
- `?cache_read=true` — only models that support cache read (565 models)
- `?cache_write=true` — only models that support cache write (61 models)
- `?min_output=N` — filter by max_completion_tokens ≥ N

**New sort keys**: `cache_write`, `max_output`, `uptime` (in addition to existing `id`, `input`, `output`, `cache_read`, `context`, `discount`)

**Enhanced stats** (`/api/v1/stats`): now includes org_count, zdr_count, subscription_count, cache_read_count, cache_write_count, quantization breakdown, and per-org counts

**Enhanced providers** (`/api/v1/providers`): optional `?zdr=true` filter to list only ZDR-compliant providers

**E2E tested**: all 9 endpoints verified locally via `wrangler pages dev` — 34 test cases covering list/detail/filter/sort/404/CORS for text, image, and video catalogs.

**Docs updated**: README.md, AGENTS.md, TODO.md all reflect the new API surface.

### models.dev enrichment — ✅ IMPLEMENTED
**Status**: Implemented. ~385 of 920 text models (42%) enriched with base URL, native model ID, capability metadata, and cache-pricing null-fills. The sub-60% yield is expected — DeepInfra (112 models) and ~26 smaller OR-exclusive providers are structurally absent from models.dev, so they can never match. This is documented in the design spec.

**What's done**:
- `shared/modelsdev.mjs`: provider map (48 entries), 4 bespoke ID normalizers (cloudflare, amazon-bedrock, fireworks, minimax), two-tier matcher (exact + bounded fuzzy)
- `scripts/fetch-modelsdev.mjs`: sidecar fetcher, non-fatal on failure
- Pipeline integration in `fetch-pricing.mjs` (runs after subscription tagging)
- Frontend detail modal: whole-row clickable, 4 conditional sections (connect/pricing/capabilities/about), copy-to-clipboard, ⚠ pill for Tier B matches
- Test suite: `test/modelsdev-normalizers.test.mjs`, `test/modelsdev-enrichment.test.mjs`, 3 new parity regression tests

**Remaining**:
- Image/video tab detail cards (deferred — models.dev has no image/video pricing)
- Tuning normalizers for providers with high unmatched counts (DeepInfra has 0 models on MD; others may need format-specific normalizers as miss patterns emerge from logs)
