# 💰 TokenWatch

Compare pay-as-you-go LLM inference pricing across inference providers. Enter your token volumes and find the cheapest option.

**Live site:** https://tokenwatch.wyrdwerk.com (also at https://payg-inference-calculator.pages.dev)

## How it works

1. **`scripts/fetch-pricing.mjs`** fetches text-generation pricing from 3 tiers: direct `/v1/models` providers (DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova, Hyper), OpenRouter de-aggregated `/endpoints` (Fireworks, Together, Novita, SiliconFlow, etc.), plus CSV/hardcoded (Makora, Xiaomimimo, OpenCode Go) and manually maintained Umans pricing (`UMANS_MODELS` in the fetcher). Also fetches provider metadata, ZDR data, models.dev enrichment, and quality benchmarks. Normalizes all pricing to $/M tokens and writes `public/pricing.json`.
2. **`scripts/fetch-images.mjs`** fetches image generation models from OpenRouter plus fal.ai (Tier-1 precedence). Handles flat per-image, per-megapixel, and per-token pricing. Writes `public/image-pricing.json` (~160 models).
3. **`scripts/fetch-videos.mjs`** fetches video generation models from OpenRouter plus fal.ai (Tier-1 precedence). Normalizes per-second pricing with resolution and audio variants. Writes `public/video-pricing.json` (~100 models).
4. **`public/`** is a zero-dependency static site (HTML/CSS/JS) with three tabs (Text/Image/Video), each loading its own pricing JSON and computing costs in-browser.
5. **`functions/api/v1/`** provides a queryable API via Cloudflare Pages Functions for all three catalogs (text, image, video).
6. **GitHub Actions** refreshes pricing + performance on a 2-hourly cron, commits updated JSON, and deploys to Cloudflare Pages.

## Usage

- **Search by provider**: Type a provider name (e.g. "deepinfra", "fireworks", "wafer") to filter results to that inference provider across all models.
- **Search by model**: Type a model name (e.g. "glm", "kimi", "gpt-4o") to filter results to matching models across all providers.
- **Both together**: Use both search fields simultaneously (AND filter).
- **Token input**: Enter total tokens (in millions) and set the percentage breakdown across input, cached input, and output. The calculator computes costs per offering and sorts cheapest-first.
- **Cost mode**: Toggle between **"Per Session"** (enter total tokens, see per-session cost) and **"Monthly Volume"** (enter daily tokens, see monthly cost × 30 days).
- **Budget mode**: Toggle "Compute by" to **Budget → Tokens** (text tab), **Budget → Count** (image), or **Budget → Seconds** (video) to invert the calculator — enter a $ budget and see how many tokens/images/seconds each provider offers. Results re-rank by affordability (most units for your budget).
- **Group by**: Group results by Organization, Provider, or keep flat.
- **Compare**: Checkboxes on each row let you select up to 6 models for side-by-side comparison (pricing, Speed p50 throughput, Blended $/M, Total Cost, ZDR, and more).
- **Provider metadata**: HQ flag badges (🇺🇸🇸🇬🇨🇳) and links to privacy policy, ToS, and status pages appear next to provider names. Data policy fields (retains prompts, may train, retention days) are sourced from OpenRouter and provider policy review.
- **ZDR badges**: Models from providers with Zero Data Retention show a green "ZDR" badge. Use the "ZDR only" filter to restrict results to ZDR-compliant offerings.
- **Subscription badges**: Providers with coding plan subscriptions show a blue "Sub" badge. Use the "Sub only" filter to restrict results to subscription providers (13 providers, 142 models).
- **Promo badges**: Discounted offerings show a "promo" badge with the discount percentage.
- **Cache write**: An adjustable one-time cache-population cost with amortization over N requests, included in the Total Cost column.
- **Blended $/M**: Table column (before Total Cost) showing the effective per-million-token rate at your current input/cache/output mix. Excludes cache-write and monthly multiplier — pure cross-model comparison metric. Also shown in the comparison modal.
- **Export CSV**: Button above the results table downloads the current filtered/sorted results (all pricing columns, Speed, Blended $/M, ZDR, subscription, discount).
- **Speed**: Throughput p50 (tokens/sec) from performance data — table column + comparison modal row (blank when unavailable).
- **Column customization**: Drag the ⠿ handle on any of the 9 middle column headers (Org … Blended $/M) to reorder them; the # and Total Cost columns stay locked first/last. Use the **Hide Columns** button to show/hide any middle column via per-column checkboxes + a Reset button. Order + visibility persist in the URL hash.

- **Image tab**: Enter number of images, optionally filter by resolution variant. Search by provider or model using the typeahead inputs. Flat per-image models show total cost; token-priced and megapixel-priced models show per-unit rates (cost varies by generation complexity).
- **Video tab**: Enter video duration in seconds, filter by resolution and audio. Search by provider or model using the typeahead inputs. All models show per-second pricing with computed total cost.
- **Tab navigation**: Use the Text/Image/Video tabs at the top to switch between modalities.
- **Mobile**: On screens ≤640px, tables transform into stacked cards with field labels. A sort dropdown appears for reordering results (column headers are hidden in card mode).
- **Shareable URLs**: All state (search, tokens, mix, budget, sort, mode, group, filters, ZDR, subscription, column order + visibility) is encoded in the URL hash for sharing.

### Token calculation

Costs are computed from a **total token volume** + **percentage breakdown**:

| Field | Default | Description |
|---|---|---|
| Total tokens | 1000 (M) | Total tokens in millions (1000 = 1B tokens) |
| Input % | 2.5% | Tokens sent to the model |
| Cached input % | 97% | Cached prompt tokens (discounted input) |
| Output % | 0.5% | Tokens generated by the model |

Example: 1000M tokens × 2.5% = 25M input tokens. Cost = `(25M × $/M) / 1e6`.

Presets: Agentic (2.5/97/0.5), Balanced (30/50/20), Heavy output (10/0/90), No cache (70/0/30).

## Data sources

| Source | Tier | Description |
|---|---|---|
| Direct providers | Tier 1 | DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova, Hyper — public `/v1/models` endpoints |
| OpenRouter `/endpoints` | Tier 2 | De-aggregated per-backend pricing — each backend (Fireworks, Together, Novita, SiliconFlow, etc.) becomes its own row. Also captures cache_write, uptime, max_completion_tokens. |
| CSV-sourced | Tier 3 | Makora, Xiaomimimo (from `data/manual-pricing.csv`) |
| Hardcoded | Tier 3 | OpenCode Go + Umans (`UMANS_MODELS` manual table in fetcher; status.umans.ai SSR is for performance data only) |

**3-tier precedence**: when the same (model, provider) appears in multiple tiers, the higher-authority tier wins — direct > OpenRouter > CSV/hardcoded. Quantization IS part of the dedup key — `canonicalId()` preserves quant suffixes, so different quants of the same model+provider stay distinct rows.
**Text models**: ~940 text-generation models across ~75 inference providers and ~55 underlying orgs. **~65% are ZDR-compliant**.
**Sidecar enrichments** (non-fatal): models.dev metadata (~40% coverage), Artificial Analysis quality benchmarks (~75% coverage), fal.ai image/video (Tier-1 merge).

## Image & Video Generation

TokenWatch also tracks dedicated image and video generation models from OpenRouter and fal.ai:

| Modality | Source | Models | Pricing |
|---|---|---|---|
| **Image** | OpenRouter `/images` + fal.ai | ~160 | Flat per-image, per-megapixel, or per-token |
| **Video** | OpenRouter `/videos` + fal.ai | ~100 | Per-second with resolution/audio variants |

Image and video models have their own tabs (see navigation bar). Pricing units vary by model — flat per-image costs are directly computable; token-priced and megapixel-priced models show per-unit rates since total cost depends on generation complexity.

Only text-generation models are filtered from the text catalog. Image and video catalogs are separate and do not include text-generation models.

## API

Cloudflare Pages Functions serve a queryable API at `/api/v1/`:

- `GET /api/v1/` — API info and endpoint directory
- `GET /api/v1/stats` — summary statistics: model count, provider count, org count, ZDR count, subscription count, cache support counts, quantization breakdown, per-provider and per-org counts
- `GET /api/v1/orgs` — all orgs with model counts, sorted by count descending
- `GET /api/v1/providers` — provider metadata (privacy/ToS/status URLs, HQ, datacenters, `retains_prompts`, `may_train`, `retention_days`). Optional `?zdr=true` filters to ZDR-compliant providers only.
- `GET /api/v1/models` — list text models with filters: `?org=`, `?provider=`, `?min_context=`, `?min_output=`, `?quantization=`, `?cache_read=true`, `?cache_write=true`, `?promo=true`, `?zdr=true`, `?sub=true`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `input`, `output`, `cache_read`, `cache_write`, `context`, `max_output`, `uptime`, `discount`. Model objects include `zdr: true` and `subscription: true` when applicable.
- `GET /api/v1/models/:canonicalId/providers` — all providers hosting a model, sorted by cost (includes `zdr` and `subscription` fields per provider). Optional `?tokens=N&mix=inputPct,cachePct,outputPct` for mix-aware cost sorting.
- `GET /api/v1/images` — list image models with filters: `?org=`, `?provider=`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `org`, `provider`.
- `GET /api/v1/images/:id` — single image model with pricing variants (accepts bare canonical ID or full `org/model` ID)
- `GET /api/v1/videos` — list video models with filters: `?org=`, `?provider=`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`. Sort keys: `id`, `org`, `provider`.
- `GET /api/v1/videos/:id` — single video model with pricing variants (accepts bare canonical ID or full `org/model` ID)

All responses include CORS headers for cross-origin use.

## Embeddable widget

Embed a live pricing card on any site:

```html
<div data-tw-model="glm-5.2" data-tw-tokens="1000" data-tw-mix="2.5,97,0.5"></div>
<script src="https://tokenwatch.wyrdwerk.com/widget/embed.js"></script>
```

Options via data attributes: `data-tw-model` (required), `data-tw-tokens` (default: 1000), `data-tw-mix` (default: "2.5,97,0.5"), `data-tw-theme` (auto/dark/light).

Demo: https://tokenwatch.wyrdwerk.com/widget/demo.html

## Development

```bash
# Fetch pricing data (~317 API calls, ~15-20s)
npm run fetch

# Dry run — process but don't write pricing.json
npm run fetch -- --dry-run

# Serve locally
npm run serve

# Run the test suite (zero-dep, uses node:test)
npm test

# Rewrite ?v= cache-bust tokens to content hashes (run before deploy)
npm run bust:cache
```

Requires Node ≥18 (uses native `fetch`). No dependencies.

## Project structure

ARCHITECTURE.md               # Pipeline diagram (3 pipelines: text / image / video → enrichments → outputs → API)
docs/
  canonicalization-edge-cases.md  # 10 canonicalization traps + frontend parity guard
  adr/                           # Architecture Decision Records (settled + proposed design choices)
```
scripts/
  fetch-pricing.mjs          # 3-tier fetch + OR de-aggregation + provider metadata + org extraction + dedup
data/
  manual-pricing.csv          # Static pricing for CSV-sourced providers
public/
  index.html                 # UI: dual search, usage inputs, 11-column results table (incl. Speed + Blended $/M), group-by, comparison modal, Export CSV, mobile sort
  app.js                     # State, URL hash, search, cost computation, blendedCostFor, exportCsv, group-by, comparison (Speed + Blended rows), monthly mode, rendering
  styles.css                 # Dark/light theme, all badges, group headers, comparison modal, mode toggle, responsive (card layout, mobile sort)
  image.html                 # Image tab: search, count input, variant filter, sortable table, mobile sort
  image-app.js               # Image pricing calculator, typeahead search, unit-adaptive columns, mobile card layout
  video.html                 # Video tab: search, duration input, resolution/audio filters, sortable table, mobile sort
  video-app.js               # Video pricing calculator, typeahead search, resolution/audio filters, mobile card layout
  pricing.json               # Generated data (refreshed every 2h by CI)
  image-pricing.json         # Generated image model data (refreshed every 2h)
  video-pricing.json         # Generated video model data (refreshed every 2h)
  widget/
    embed.js                 # Embeddable widget (Shadow DOM, auto-detect, theme support)
    demo.html                # Widget demo page
functions/
  api/v1/
    [[route]].js             # Cloudflare Pages Functions API
.github/workflows/
  refresh-pricing.yml        # 2-hourly cron (fetch+deploy) + push-to-main (deploy-only)
```

## CI/CD

The `refresh-pricing.yml` workflow has three jobs:
- **`test`** (push/PR): runs `node --test` — gates the `deploy` job.
- **`refresh`** (every 2h cron + manual): test → fetch all pipelines + performance → commit JSON if changed → bust cache → deploy.
- **`deploy`** (push to main): test (via `needs: test`) → bust cache → deploy. No fetch, no commit.

Cache-busting (`scripts/bust-cache.mjs`) rewrites `?v=` tokens in `public/*.html` to 8-char SHA-1 content hashes of the referenced assets before each deploy. The rewritten HTML is deployed but not committed — the repo keeps its old `?v=` strings.

Safety checks:
- Aborts if >20% of API calls fail
- Aborts if model count drops >15% vs previous run
- Tests must pass before deploy (`needs: test`)

GitHub secrets required: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## License

MIT
