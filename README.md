# 💰 TokenWatch

Compare pay-as-you-go LLM inference pricing across inference providers. Enter your token volumes and find the cheapest option.

**Live site:** https://tokenwatch.wyrdwerk.com (also at https://payg-inference-calculator.pages.dev)

## How it works

0. **`scripts/fetch-benchmarks.mjs`** builds `public/benchmarks.json` — practical benchmark scores (Artificial Analysis indices, LiveBench per-release CSV from GitHub, Design Arena Elo) joined to per-provider prices, powering the `/benchmarks` use-case explorer. Model-creator orgs are resolved via a 4-layer scheme (clean org → provider-slug blocklist → variant-family inheritance → creator-prefix map), regression-pinned in `test/benchmarks-page.test.mjs`.

1. **`scripts/fetch-pricing.mjs`** fetches text-generation pricing from 3 tiers: direct `/v1/models` providers (DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova, HyperCharm, Sference, Neuralwatt, Merius, Aster Labs), OpenRouter de-aggregated `/endpoints` (Fireworks, Together, Novita, SiliconFlow, etc.), plus CSV/hardcoded (Makora, Xiaomimimo), docs-page-scraped OpenCode Go pricing (`parseOpenCodeGoDocs` scrapes the opencode.ai/docs/go table; catalog endpoint has no prices), and manually maintained Umans pricing (`UMANS_MODELS` in the fetcher). Also fetches provider metadata, ZDR data, models.dev enrichment, and quality benchmarks. Normalizes all pricing to $/M tokens and writes `public/pricing.json`.
2. **`scripts/fetch-images.mjs`** fetches image generation models from OpenRouter plus fal.ai (Tier-1 precedence). Handles flat per-image, per-megapixel, and per-token pricing. Writes `public/image-pricing.json` (~160 models).
3. **`scripts/fetch-videos.mjs`** fetches video generation models from OpenRouter plus fal.ai (Tier-1 precedence). Normalizes per-second pricing with resolution and audio variants. Writes `public/video-pricing.json` (~100 models).
4. **`public/`** is a zero-dependency static site (HTML/CSS/JS) with three tabs (Text/Image/Video), each loading its own pricing JSON and computing costs in-browser.
5. **`functions/api/v1/`** provides a queryable API via Cloudflare Pages Functions for all three catalogs (text, image, video).
6. **GitHub Actions** refreshes pricing + performance on a 2-hourly cron, commits updated JSON, and deploys to Cloudflare Pages.

## SEO

TokenWatch ships SEO infrastructure for a client-side-rendered SPA:

- **`scripts/generate-seo.mjs`** (`npm run seo`) server-renders the **25 cheapest models** (by effective cost at the agentic mix 2.5/97/0.5) into `index.html` as a real HTML table — so Google's crawler sees pricing content in the raw HTML, not an empty JS-rendered shell. It also generates `sitemap.xml` (with `lastmod` from `generated_at`) and `robots.txt`. **Idempotent** — replaces the existing `class="seo-models"` section, never re-inserts.
- All 3 HTML pages carry keyword-rich titles/descriptions, canonical tags, `og:image` (1200×630), `twitter:card=summary_large_image`, and JSON-LD structured data (`WebSite` + `SoftwareApplication` + `BreadcrumbList`; `FAQPage` lives on the consolidated `/faq/`). A generated `llms.txt` (markdown manifest for LLM/agent crawlers) is refreshed on every deploy alongside `sitemap.xml` (now including `/benchmarks` and `/faq/`).
- `_headers` sets `X-Robots-Tag: noindex` on `/api/*` and the raw JSON data files so they don't compete with the HTML pages.
- See [docs/conversations/20260803-seo-gsc-setup-public.md](docs/conversations/20260803-seo-gsc-setup-public.md) for the full setup record.

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
| DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova, HyperCharm, Sference, Neuralwatt, Merius, Aster Labs | 1 | Direct `/v1/models` fetch (authoritative for their own offerings) |
| OpenRouter `/endpoints` | 2 | De-aggregated per-backend pricing (Fireworks, Together, Novita, SiliconFlow, etc.) |
| Makora, Xiaomimimo | 3 | CSV (`data/manual-pricing.csv`) |
| OpenCode Go | 3 | Hardcoded |
| Umans | 3 | Manually maintained `UMANS_MODELS` / `parseUmansHardcoded()` |

## Image & Video Generation

OpenRouter has dedicated APIs for image and video generation — separate from the chat `/v1/models` endpoint. These are fetched by `fetch-images.mjs` and `fetch-videos.mjs`, then merged with fal.ai (Tier-1 precedence).

## API

Cloudflare Pages Functions at `functions/api/v1/` serve queryable endpoints for all three catalogs (text, image, video). See [AGENTS.md](AGENTS.md#api-endpoints) for the full endpoint list.

## Embeddable widget

`public/widget/embed.js` — embeddable JS snippet using Shadow DOM. Auto-detects `[data-tw-model]` elements, fetches the API, renders compact pricing cards. See `public/widget/demo.html`.

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

# Server-render cheapest models into index.html + generate sitemap.xml/robots.txt (run before deploy)
npm run seo

# Rewrite ?v= cache-bust tokens to content hashes (run before deploy)
npm run bust:cache
```

Requires Node ≥18 (uses native `fetch`). No dependencies.

## Project structure

ARCHITECTURE.md               # Pipeline diagram (3 pipelines: text / image / video → enrichments → outputs → API)
docs/
  canonicalization-edge-cases.md  # 10 canonicalization traps + frontend parity guard
  adr/                           # Architecture Decision Records (settled + proposed design choices)
  conversations/                 # Sanitized public records of working sessions (incl. SEO/GSC setup)
```
scripts/
  fetch-pricing.mjs          # 3-tier fetch + OR de-aggregation + provider metadata + org extraction + dedup
  generate-seo.mjs           # Server-renders 25 cheapest models into index.html + generates sitemap.xml/robots.txt (npm run seo)
data/
  manual-pricing.csv          # Static pricing for CSV-sourced providers
public/
  index.html                 # UI: dual search, usage inputs, 11-column results table (incl. Speed + Blended $/M), group-by, comparison modal, Export CSV, mobile sort. Also SEO head metadata + JSON-LD + FAQ + server-rendered table
  app.js                     # State, URL hash, search, cost computation, blendedCostFor, exportCsv, group-by, comparison (Speed + Blended rows), monthly mode, rendering
  benchmarks.html            # /benchmarks: use-case tabs (agentic/reasoning/knowledge/UI), value-benchmark dropdown incl. "no filter", mix-aware From $/M (Text-page localStorage), org filter, FAQ → /faq/
  benchmarks-app.js          # Benchmarks page app (mirrors blendedRate; value = score ÷ blended price normalized best-in-view = 100)
  styles.css                 # Dark/light theme, all badges, group headers, comparison modal, mode toggle, responsive (card layout, mobile sort). Includes .seo-faq/.seo-models/.noscript-note
  image.html                 # Image tab: search, count input, variant filter, sortable table, mobile sort
  image-app.js               # Image pricing calculator, typeahead search, unit-adaptive columns, mobile card layout
  video.html                 # Video tab: search, duration input, resolution/audio filters, sortable table, mobile sort
  video-app.js               # Video pricing calculator, typeahead search, resolution/audio filters, mobile card layout
  pricing.json               # Generated data (refreshed every 2h by CI)
  image-pricing.json         # Generated image model data (refreshed every 2h)
  video-pricing.json         # Generated video model data (refreshed every 2h)
  sitemap.xml                # Generated by generate-seo.mjs (npm run seo)
  robots.txt                 # Generated by generate-seo.mjs (npm run seo)
  favicon.svg                # Site favicon
  og/og-image.svg            # Open Graph social preview image (1200×630)
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