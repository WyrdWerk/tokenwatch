# 💰 TokenWatch

Compare pay-as-you-go LLM inference pricing across inference providers. Enter your token volumes and find the cheapest option — or start from your use case and let TokenWatch recommend an open-weight model and the provider to run it.

**Live site:** https://tokenwatch.wyrdwerk.com · **Model finder:** https://tokenwatch.wyrdwerk.com/choose/

## Choose a model for your use case

The [`/choose/`](https://tokenwatch.wyrdwerk.com/choose/) page answers *"which open-weight model should I use for this workload, and which provider should run it?"*. The homepage finder strip hands a use case straight to it (`/choose/?useCase=<id>`).

**Nine use cases:** agentic coding, tool-using agents, long-context RAG, structured extraction, high-volume/low-cost, chat assistant, creative writing, reasoning and math, and frontend/UI development.

**What you get:**

- **Three picks** — *best quality* (highest benchmark composite), *best value* (the balanced point on the quality-versus-price Pareto frontier, never a raw score-per-dollar ratio) and *cheapest good-enough* (the cheapest model whose primary benchmark clears an absolute floor).
- **A provider ranking** for the selected model, with reasons, caveats, unknowns and a confidence label (*stable*, *moderately stable*, *close call*). Providers missing required capability or context metadata are listed as unverified, not ranked.
- **A priority control** — balanced, cheapest, fastest or most reliable — that re-weights the provider ranking.
- **Optional constraints** — zero data retention, excluded provider headquarters, and an opt-in for proprietary models (open weights only by default).
- **People's preference** — creative writing is led by LMArena Creative Writing ratings; chat keeps capability-ranked picks and shows the Arena Text favourite separately as the *people's favourite*.
- Shareable URL state, "Copy setup", "Copy agent prompt" and links into the calculator at the use case's mix.

### How it works

1. Each use case (`shared/use-cases.mjs`) defines an **assumed token mix**, **hard requirements** (tool calling, structured output, minimum context), **benchmark weights**, **provider weights**, a **quantization policy** and an **absolute quality floor** on its primary benchmark.
2. Offerings are grouped by canonical model. Only resolved open-weight models are kept by default (`shared/open-weights.mjs`: reviewed overrides → strict models.dev majority → known-closed org priors; unknown is excluded). Subscription offerings and `:batch` variants (except high-volume work) are excluded.
3. Each provider must pass the capability/context gates, any ZDR/headquarters constraint, known-issue checks, and have a price at the assumed mix. Low-bit quants (fp4/nvfp4/mxfp4/int4) are rejected for demanding workloads when a better-precision provider qualifies.
4. Each benchmark becomes a percentile among eligible models; weighted percentiles form a 0–100 composite that is shrunk toward the cohort median by the share of benchmark weight that is missing. At least 50% coverage is required for best quality / best value.
5. Providers are scored on blended price (`shared/cost.mjs`), TTFT p50, throughput p50 and uptime (30-minute window preferred); missing metrics are omitted and weights renormalized.
6. Confidence is the margin over the runner-up: ≥10 points stable, 3–10 moderately stable, <3 close call.

The engine (`shared/recommend.mjs`) is pure and Worker-safe: the `/choose/` page runs it in the browser, and the API and WebMCP tools run it at the edge. Design: [ADR 0012](docs/adr/0012-recommender-scoring.md); field contract: [docs/recommender-data-contract.md](docs/recommender-data-contract.md); dated comparison with outside leaderboards and sensitivity results: [docs/research/recommender-validation.md](docs/research/recommender-validation.md). `node scripts/recommender-sensitivity.mjs` re-runs the one-input-at-a-time robustness screen locally.

### Recommendation data sources

| Signal | Source |
|---|---|
| Prices, capabilities, context, uptime | `public/pricing.json` (the 3-tier text catalog below) |
| Open-weight status and licence | `data/open-weights-overrides.json` + [models.dev](https://models.dev) |
| Quality indices | [Artificial Analysis](https://artificialanalysis.ai/) intelligence / coding / agentic indices |
| Category scores | [LiveBench](https://livebench.ai/) (2026-06-25 release) |
| UI quality | [Design Arena](https://www.designarena.ai/) Elo |
| Human preference | [LMArena leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) — Text Arena `overall` and `creative_writing`, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Fetched weekly by `scripts/fetch-arena.mjs` into `data/arena-benchmarks.json`; ratings are unchanged and matched conservatively to TokenWatch IDs. |
| TTFT / throughput | `public/performance.json` (OpenRouter endpoint telemetry plus direct providers) |

Arena ratings are attributed wherever they appear (page, API `preference.source`, methodology page and WebMCP guidance). If you republish ratings from the API, keep that attribution.

### Recommendation API

```bash
# The nine presets: assumed mixes, weights, requirements, quality floors
curl 'https://tokenwatch.wyrdwerk.com/api/v1/use-cases'

# Model picks for a use case (compact by default; pretty=1 indents)
curl 'https://tokenwatch.wyrdwerk.com/api/v1/recommend?use_case=agentic-coding&priority=balanced&zdr=true&exclude_hq=CN&limit=5&pretty=1'

# Creative writing, including the Arena preference favourite and its attribution
curl 'https://tokenwatch.wyrdwerk.com/api/v1/recommend?use_case=creative-writing&pretty=1'

# Provider ranking for one canonical model, with full explanations for every row
curl 'https://tokenwatch.wyrdwerk.com/api/v1/recommend/providers?use_case=agentic-coding&model=glm-5.3&priority=fastest&detail=full&pretty=1'
```

Parameters: `use_case` (required), `model` (required for `/recommend/providers`), `priority` (`balanced`|`cheapest`|`fastest`|`most-reliable`), `zdr`, `exclude_hq`, `include_proprietary`, `detail` (`compact`|`full`), `limit` (1–100, default 10), `pretty`. Invalid values return 400 with the offending `parameter`. Full reference: [/docs/api/](https://tokenwatch.wyrdwerk.com/docs/api/) and [`openapi.json`](https://tokenwatch.wyrdwerk.com/openapi.json). In-page agents can call the same engine through the WebMCP tools `recommend_model` and `recommend_provider` (see [docs/WEBMCP.md](docs/WEBMCP.md)).

### Limitations

- **Assumed mixes.** Each use case prices providers at a fixed, assumed input/cached/output mix; it is not measured from your traffic. Check your own mix in the calculator.
- **Judgment-based weights and floors.** Benchmark weights, provider weights and floors are documented product judgments, calibrated against the 2026-10-04 catalog snapshot. Scores are relative within a workload; only the floor is absolute.
- **Thin or missing benchmarks.** Some LiveBench categories cover only a handful of open models, and Arena ratings match roughly half of open-weight canonical IDs. Models without enough evidence are listed separately, not ranked.
- **Incomplete provider data.** Headquarters, TTFT, throughput, uptime and capability metadata are missing for some providers. Excluding a country only removes providers whose headquarters is known; missing telemetry is unknown, not zero.
- **Snapshot, not a guarantee.** Prices, promotions and policies change between refreshes; verify a shortlisted provider's current terms before committing spend.

## How it works

0. **`scripts/fetch-benchmarks.mjs`** builds `public/benchmarks.json` — practical benchmark scores (Artificial Analysis indices, LiveBench per-release CSV from GitHub, Design Arena Elo) joined to per-provider prices, powering the `/benchmarks` use-case explorer. Model-creator orgs are resolved via a 4-layer scheme (clean org → provider-slug blocklist → variant-family inheritance → creator-prefix map), regression-pinned in `test/benchmarks-page.test.mjs`.

1. **`scripts/fetch-pricing.mjs`** fetches text-generation pricing from 3 tiers: direct `/v1/models` providers (DeepInfra, EmberCloud, Wafer, Synthetic, SambaNova, HyperCharm, Sference, Neuralwatt, Merius, Aster Labs, Arilo.id, Avian, CoralBricks, SingularityAPI, RunInfra), OpenRouter de-aggregated `/endpoints` (Fireworks, Together, Novita, SiliconFlow, etc.), plus CSV/hardcoded (Makora, Xiaomimimo), docs-page-scraped OpenCode Go pricing (`parseOpenCodeGoDocs` scrapes the opencode.ai/docs/go table; catalog endpoint has no prices), and manually maintained Umans pricing (`UMANS_MODELS` in the fetcher). Also fetches provider metadata, ZDR data, models.dev enrichment, and quality benchmarks. Normalizes all pricing to $/M tokens and writes `public/pricing.json`; recommender-facing open-weight, license, and endpoint capability semantics are documented in [docs/recommender-data-contract.md](docs/recommender-data-contract.md).
2. **`scripts/fetch-images.mjs`** fetches image generation models from OpenRouter plus fal.ai (Tier-1 precedence). Handles flat per-image, per-megapixel, and per-token pricing. Writes `public/image-pricing.json` (~160 models).
3. **`scripts/fetch-videos.mjs`** fetches video generation models from OpenRouter plus fal.ai (Tier-1 precedence). Normalizes per-second pricing with resolution and audio variants. Writes `public/video-pricing.json` (~100 models).
4. **`public/`** is a zero-dependency static site (HTML/CSS/JS) with Text/Image/Video calculators, a Benchmarks explorer and the Choose model finder, each loading its own JSON and computing in-browser. The Choose page (`public/choose/` + `choose-app.js`) runs the shared recommender engine (`shared/use-cases.mjs`, `shared/recommend.mjs`, `shared/choose-page.mjs`) client-side.
5. **`functions/api/v1/`** provides a queryable API via Cloudflare Pages Functions for all three catalogs (text, image, video), plus the workload recommender (`/api/v1/use-cases`, `/api/v1/recommend`, `/api/v1/recommend/providers`).
6. **`functions/api/advisor.js`** powers the on-site conversational AI Advisor (using Nemotron / InferX via OpenAI-compatible API) with dynamic knowledge base ingestion and edge rate-limiting (4 queries / 24h per IP).
7. **`scripts/build-advisor-knowledge.mjs`** builds `public/advisor-knowledge.json` joining live model pricing, benchmarks, and provider policy URLs for the advisor bot.
8. **GitHub Actions** refreshes pricing + performance on a 2-hourly cron, commits updated JSON, and deploys to Cloudflare Pages.

## SEO

TokenWatch ships SEO infrastructure for a client-side-rendered SPA:

- **`scripts/generate-seo.mjs`** (`npm run seo`) writes crawlable pricing tables for text, image, video, and benchmarks, plus provider/model directories, eligible comparison pages, methodology, API docs, and FAQ. Static text comparisons use the agentic mix (2.5% input, 97% cached input, 0.5% output); image billing units stay separate.
- Generated pages have titles, descriptions, canonical URLs, social metadata, and page-appropriate JSON-LD. `npm run verify:seo` checks local page structure, FAQ/schema agreement, optional history wiring, unique titles, matching sitemap canonicals, valid model/provider links, and whether every sitemap URL is reachable from the homepage through ordinary HTML links. It does not establish live HTTP behavior or search-engine indexation.
- `sitemap.xml`, `robots.txt`, and `llms.txt` regenerate during deployment. Committed generated copies can lag catalog data; inspect deployed output before diagnosing staleness. Update the `buildLlmsTxt()` template in `scripts/seo-pages.mjs`, not only the generated text file.
- `/choose/` is in the sitemap (priority 0.8) and linked from the nav, the homepage finder strip, explore links, every generated model page ("Is this the right model for your workload?"), the methodology page (`#recommendations`), and the FAQ ("Choosing a model and provider" group, mirrored in FAQPage JSON-LD). Its static HTML carries WebApplication + use-case ItemList JSON-LD and crawlable `?useCase=` deep links. The sitemap is now provider pages + model pages + 10 fixed pages.
- `llms.txt` opens with a "Choose a model and provider for a use case" section (deep links, recommend API URLs, WebMCP tools, limitations) and provides model/provider discovery, API/OpenAPI links, units, workload assumptions, freshness limits, and interpretation notes for agents. WebMCP supports browser-agent interaction. Neither is a guarantee of search indexing or AI citations. [Google explicitly says it does not use llms.txt for visibility or rankings](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide).
- `_headers` adds `noindex` to raw catalog/reference JSON files. Its `/api/*` rule **does not apply to Pages Functions**, so both API Functions now set `X-Robots-Tag: noindex` on their responses ([Cloudflare documentation](https://developers.cloudflare.com/pages/configuration/headers/)). Generated `robots.txt` allows public API crawling so search engines can read those headers. This also allows AI crawlers to read public API data; it does not override Cloudflare's account-side crawler controls. No crawler-specific training-policy rule has been added or changed.
- The [2026-08-03 setup record](docs/conversations/20260803-seo-gsc-setup-public.md) is historical. Provider/model pages have since shipped. Its FAQ rich-result monitoring advice is obsolete: [Google stopped showing FAQ rich results on May 7, 2026](https://developers.google.com/search/updates). Visible FAQs remain useful documentation.

### Live recheck: 2026-10-02

- All **201 sitemap URLs** returned HTML with HTTP 200, matching canonicals, unique titles, and no page-level `noindex`. JSON-LD was present and parseable on 200 pages; the benchmarks page lacked it. The sitemap included 91 provider pages and 101 model pages, plus nine directory/calculator/documentation pages. These checks establish basic technical crawlability, **not that Google or Bing indexed them**.
- HTTP redirects to HTTPS. Sample `.html` and slash variants redirect to preferred paths. A nonexistent page returned HTTP 404 with `noindex`, rather than the homepage with HTTP 200.
- Served `robots.txt` allowed public pages and had no AI-specific disallows. Requests using crawler user-agent names from the audit orb received the same rules; this does not verify access from genuine crawler IP addresses or Cloudflare bot-policy settings.
- Live `llms.txt` and the pricing FAQ were current. Older committed copies were not evidence of a production freshness defect.
- Mobile Lighthouse 13.5.0 scored homepage performance **94**, accessibility **96**, and basic SEO **100**; a representative model page scored **99**, **96**, and **100**. Homepage LCP was 2.3 seconds, total blocking time 190 ms, and layout shift 0.045. These are single lab runs, not real-user Core Web Vitals or ranking measurements. Desktop and narrow Chromium captures showed no obvious clipping or page-wide horizontal overflow.

### Repository-side fixes prepared after the audit

These changes are local until an authorized deployment. The dated live checks above describe the site before these fixes.

1. **HTML discovery and URL retention:** Models is in navigation and generated footers/explore links. Pricing, provider, and benchmark tables link to actual generated pages, not guessed slugs. The initial regeneration matched the 201 live sitemap URLs but dropped six URLs from the older committed sitemap. `data/seo-published-pages.json` now retains their union: 207 URLs (94 provider pages, 104 model pages, nine directory/calculator/documentation pages). The five URLs new relative to Git were already in the live sitemap, rechecked through Composio/Firecrawl on 2026-10-02. No genuinely new landing URLs are added. Regeneration refreshes established pages even below the original three-provider/three-model floor; absent catalog data produces an explicit unavailable state, not stale prices or a claim of retirement. New landing pages require approval and an intentional registry update; preserve existing entries until a separate retirement/redirect decision is approved. The regression test checks that generated directories and sitemap match the registry.
2. **Consistent metadata:** Homepage search, social, visible, and structured-data descriptions use the current provider count and call text records offerings rather than unique models. The audit found 1,577 offerings across 100 providers, representing 504 canonical IDs with variants included. Structured data names TokenWatch and its publisher; methodology names its maintainer. Benchmarks now has CollectionPage and breadcrumb schema, and the verifier checks valid generated JSON-LD on every sitemap page. The evergreen social card contains no volatile counts; PNG is the primary social image, with dimensions and alternative text supplied.
3. **Index exclusion:** API responses, all root catalog/reference JSON, the widget demo, and the existing history-state gallery are excluded from search results. Public HTML references remain indexable. `noindex` does not prevent agents or applications from fetching public data.
4. **Honest freshness:** Sitemap `lastmod` is omitted until meaningful content-change times are tracked. A fetch timestamp is not a reliable modification date. Pricing snapshots still identify their source dates, and benchmark content now names its own catalog timestamp and exact token mix.
5. **Existing-page content:** Methodology explains offerings versus models, links catalogs and source implementations, identifies the maintainer and correction channel, and compares four illustrative workloads. It states the mixes, snapshot date, units, billing assumptions, and limits of price-only rankings. These examples are not measured workload averages or quality recommendations.
6. **Usability and measurement:** Subscription badges have contrast-safe colors in both themes; history error/detail text and the Advisor accessible name are corrected. The production build omits history panels while D1 history storage is unavailable. Local history components/tests remain intact; enabling production history still needs its separate approval. CSP permits the already-injected Cloudflare beacon from its script origin and keeps connections restricted to the same site, matching [automatic-injection guidance](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy-csp). No analytics account or extra tracking script was added. Confirm deployed beacon collection before relying on analytics.
7. **Advisor evidence:** Missing benchmark scores stay unknown, numeric zero is preserved, and unconfirmed provider ZDR is not presented as confirmed retention. The prompt acknowledges unavailable evidence instead of inventing scores. It labels its existing 50% input / 0% cached / 50% output price mix and exclusion of cache-write/storage charges; these rates are not interchangeable with the calculator's default agentic mix. This tests the evidence supplied to the model, not every possible generated answer.

Run `npm test`, `npm run seo`, and `npm run verify:seo` before publishing. Regeneration updates tracked snapshots; deployment also fingerprints/minifies assets. Do not commit deploy-only `/h/` references.

### Owner-side indexation and AI-visibility checklist

1. In the verified Search Console property, check **Sitemaps** for `https://tokenwatch.wyrdwerk.com/sitemap.xml`: successful processing, recent reads, and discovery consistent with the current sitemap. Review **Page indexing**, including discovered/crawled-but-not-indexed URLs, duplicates, and chosen canonicals. Export the reports; a public `site:` search is not an index inventory.
2. Use **URL Inspection** on `/`, `/image`, `/video`, `/benchmarks`, `/models/`, and representative model/provider pages. Compare the indexed status, Google's selected canonical, last crawl, and live-test rendered HTML. Request indexing for important missing or materially changed pages, not every unchanged pricing refresh.
3. Check **Settings > Search generative AI** for inclusion, including controls inherited from a parent property. [Google's current help documents inclusion as the default and explains inheritance](https://support.google.com/webmasters/answer/16908024). Review its **Generative AI performance** report when available, alongside normal Search Performance page/query/device/country data.
4. Verify or import the site in Bing Webmaster Tools, submit the sitemap, inspect representative URLs, and review [AI Performance citation/grounding-query reports](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/). Consider IndexNow for genuinely added, changed, or removed URLs, not blanket notifications every two hours.
5. Check Cloudflare bot/WAF logs for real Googlebot, Bingbot, and AI-search crawler requests. Keep search access separate from training preferences: [OpenAI documents OAI-SearchBot and GPTBot as independent controls](https://developers.openai.com/api/docs/bots). Do not change training policy merely to pursue search visibility.
6. Review real-user Core Web Vitals and analytics referrals/conversions, including AI referrals. Lack of field data is not a passing or failing result. The audit had no active Search Console connection, account reports, real-crawler logs, complete backlink inventory, or verified AI-citation history; these remain owner-side evidence to obtain.
7. Configure a permanent redirect from `payg-inference-calculator.pages.dev` to `tokenwatch.wyrdwerk.com` in Cloudflare, preserving paths and query strings. Current custom-domain canonicals already signal the preferred host, but the alternate host still serves HTTP 200. [Pages `_redirects` does not support domain-level redirects](https://developers.cloudflare.com/pages/configuration/redirects/); do not substitute an invalid rule or make every static request a Function merely to work around it. Confirm any applicable sponsorship/affiliate disclosures before publishing those claims. None has been invented here.

## Usage

- **Search by provider**: Type a provider name (e.g. "deepinfra", "fireworks", "wafer") to filter results to that inference provider across all models.
- **Search by model**: Type a model name (e.g. "glm", "kimi", "gpt-4o") to filter results to matching models across all providers.
- **Both together**: Use both search fields simultaneously (AND filter).
- **Token input**: Enter total tokens (in millions) and set the percentage breakdown across input, cached input, and output. The calculator computes costs per offering and sorts cheapest-first.
- **Cost mode**: Toggle between **"Per Session"** (enter total tokens, see per-session cost) and **"Monthly Volume"** (enter daily tokens, see monthly cost × 30 days).
- **Budget mode**: Toggle "Compute by" to **Budget → Tokens** (text tab), **Budget → Count** (image), or **Budget → Seconds** (video) to invert the calculator — enter a $ budget and see how many tokens/images/seconds each provider offers. Results re-rank by affordability (most units for your budget).
- **Group by**: Group results by Organization, Provider, or keep flat.
- **Compare**: Checkboxes on each row let you select up to 6 models for side-by-side comparison (pricing, measured speed, Blended $/M, Total Cost, ZDR, and more). Reported decode speeds are labelled separately from p50 throughput.
- **Provider metadata**: HQ flag badges (🇺🇸🇸🇬🇨🇳) and links to privacy policy, ToS, and status pages appear next to provider names. Data policy fields (retains prompts, may train, retention days) are sourced from OpenRouter and provider policy review.
- **ZDR badges**: Models from providers with Zero Data Retention show a green "ZDR" badge. Use the "ZDR only" filter to restrict results to ZDR-compliant offerings.
- **Subscription badges**: Providers with coding plan subscriptions show a blue "Sub" badge. Use the "Sub only" filter to restrict results to currently tagged offerings; coverage changes with the catalog.
- **Promo badges**: Discounted offerings show a "promo" badge with the discount percentage.
- **Cache write**: Fresh-input estimates honor a provider's explicit default cache-write billing rule, even when the write tariff is lower than normal input. Missing explicit tariffs make fresh-input workloads unpriceable. Otherwise a higher finite positive write tariff applies, or normal input pricing. Cached reads use the cache-read price or original input rate. No separate amortized write charge is added; storage charges are excluded.
- **Blended $/M**: Table column (before Total Cost) showing the effective per-million-token rate at your current input/cache/output mix, including the same fresh-input billing rule as total cost. It excludes token volume and the monthly multiplier. Also shown in the comparison modal.
- **Export CSV**: Button above the results table downloads the current filtered/sorted results (all pricing columns, Speed, Blended $/M, ZDR, subscription, discount).
- **Speed**: Throughput p50 or explicitly labelled provider-reported decode speed (tokens/sec), shown in the table and comparison modal. Missing measurements stay blank; CSV exports include the speed statistic and measurement windows.
- **Column customization**: Drag the ⠿ handle on any of the 9 middle column headers (Org … Blended $/M) to reorder them; the # and Total Cost columns stay locked first/last. Use the **Hide Columns** button to show/hide any middle column via per-column checkboxes + a Reset button. Order + visibility persist in the URL hash.

- **WebMCP (text, image, and video tabs)**: In ChatGPT's in-app browser or Chrome with WebMCP enabled, the calculators register **site tools** so an agent can inspect and operate the table **the human is looking at**. The first tool alphabetically is `about_tokenwatch` (operating brief). The text tab exposes the full workload/filter/compare tool set (21 tools, including the read-only `recommend_model` and `recommend_provider`); image and video expose page-specific catalog, view, and sorting tools. Tools live at the same origin; without WebMCP the site is unchanged. See [docs/WEBMCP.md](docs/WEBMCP.md).

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

Example: 1000 million total tokens × 2.5% = 25 million fresh-input tokens. At a billable fresh-input rate of $2 per million, that leg costs $50. Add the cached-input and output legs using their own rates and percentages.

Presets: Agentic (2.5/97/0.5), Balanced (30/50/20), Heavy output (10/0/90), No cache (70/0/30).

## Data sources

| Source | Tier | Description |
|---|---|---|
| DeepInfra, EmberCloud, Wafer, Synthetic, SambaNova, HyperCharm, Sference, Neuralwatt, Merius, Aster Labs, Avian | 1 | Direct `/v1/models` fetch (authoritative for their own offerings) |
| Arilo.id | 1 | Public [`/v1/models`](https://api.arilo.id/v1/models); only `deepseek-v4.1-flash`, as requested in [issue #22](https://github.com/WyrdWerk/tokenwatch/issues/22) |
| CoralBricks | 1 | Authenticated [`/v1/models`](https://inference.coralbricks.ai/v1/models) (`CORAL_API_KEY`), with public [`/api/public/models`](https://www.coralbricks.ai/api/public/models) pricing fallback |
| SingularityAPI, RunInfra | 1 | Auth-gated `/v1/models` (`SINGULARITY_API_KEY`, `RUNINFRA_API_KEY`) |
| OpenRouter `/endpoints` | 2 | De-aggregated per-backend pricing (Fireworks, Together, Novita, SiliconFlow, etc.) |
| Makora, Xiaomimimo | 3 | CSV (`data/manual-pricing.csv`) |
| OpenCode Go | 3 | Hardcoded |
| Umans | 3 | Manually maintained `UMANS_MODELS` / `parseUmansHardcoded()` |

Arilo's public catalog supplies `cost.input`, `cost.output`, and `cost.cache_read` in USD per million tokens, plus `max_context_tokens`. Prices refresh from that API without credentials; other models and the `-alt` SKU are excluded. The provider's [October 5 clarification](https://github.com/WyrdWerk/tokenwatch/issues/22#issuecomment-5992990470) confirms MXFP4, a 60,000-token output limit, no separate cache-write charge, and that the original $10/1.111B subscription quote is stale. The coding-plan badge indicates availability, not a discount to PAYG rates. Hong Kong and Ireland are provider-reported datacenter locations; headquarters remains unknown. ZDR remains unconfirmed: the provider says diagnostic logging is non-persistent and upstream hosts use ZDR, but its [privacy policy §2](https://arilo.id/privacy) still permits brief diagnostic content logging and image-description caching. Training is opt-in through the Research Program (§3); the 30-day request-log period (§8) is not a prompt-retention limit.

CoralBricks' [docs](https://www.coralbricks.ai/docs.md) describe its public production catalog and authenticated model endpoint. With `CORAL_API_KEY`, TokenWatch uses explicit API tariffs, exact context lengths, and chat/image-input/tool flags. The public catalog supplies names and precision, never overrides authenticated prices, and remains the pricing fallback if authentication is unavailable. Its nested OpenRouter fields are competitor comparisons, not CoralBricks tariffs. Reviewed fallback multipliers, checked October 2, 2026, produce current write tariffs of $1.68/M for GLM 5.3, $0.23/M for GLM Flash, and $0.09/M for DeepSeek. Unknown SKUs keep fallback cache-write pricing unknown. Native IDs and quantization stay distinct; unpublished output limits remain unknown.

CoralBricks bills novel input at the cache-write rate by default; `prompt_cache_retention: "off"` switches it to plain-input billing. TokenWatch preserves both published rates and sets `pricing.input_billing: "cache_write"` so default fresh-input billing uses the write tariff even when lower than input. Unknown write tariffs make fresh-input workloads unpriceable rather than falling back to the opt-out price. Providers without this explicit rule keep the existing higher-write-rate estimate. Cache billing controls do not establish data privacy. Its [privacy policy](https://www.coralbricks.ai/content/privacy.md) says customer content is retained up to 30 days by default and is not used for model training. Organization-level zero content retention is opt-in, so CoralBricks does not receive a provider-wide ZDR badge.

CoralBricks performance requires `CORAL_API_KEY`. The performance sidecar reads measured decode speed, median time-to-first-token, and cache-hit rates from `/v1/models`, preferring the 30-minute window per metric and labelling one-day fallbacks. TTFT seconds are converted to milliseconds for storage. Decode speed is stored as `throughput.reported`, never as a fabricated percentile. Missing measurements stay unknown; cache-hit rates describe observed traffic and do not change the visitor's pricing mix. CI passes the repository secret to both pricing refreshes and both performance-fetch steps. The [status page](https://www.coralbricks.ai/status) is linked as a gateway reachability check, not an uptime metric.

## Image & Video Generation

OpenRouter has dedicated APIs for image and video generation — separate from the chat `/v1/models` endpoint. These are fetched by `fetch-images.mjs` and `fetch-videos.mjs`, then merged with fal.ai (Tier-1 precedence).

## API

Cloudflare Pages Functions at `functions/api/v1/` serve queryable endpoints for all three catalogs (text, image, video) and the workload recommender (see [Recommendation API](#recommendation-api)). See [AGENTS.md](AGENTS.md#api-endpoints) for the full endpoint list.

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
  fetch-arena.mjs            # Weekly LMArena (CC BY 4.0) preference fetch → data/arena-benchmarks.json
  recommender-sensitivity.mjs # One-input-at-a-time robustness screen for recommender defaults
shared/
  use-cases.mjs              # Nine workload presets + priority presets
  recommend.mjs              # Pure recommender engine: shortlistModels(), rankProviders()
  choose-page.mjs            # /choose/ labels, URL state, featured-provider helpers
data/
  manual-pricing.csv          # Static pricing for CSV-sourced providers
  arena-benchmarks.json       # Committed last-good LMArena cache (attribution, license, publish dates)
public/
  index.html                 # UI: dual search, usage inputs, 11-column results table (incl. Speed + Blended $/M), group-by, comparison modal, Export CSV, mobile sort. Also SEO head metadata + JSON-LD + FAQ + server-rendered table
  app.js                     # State, URL hash, search, cost computation, blendedCostFor, exportCsv, group-by, comparison (Speed + Blended rows), monthly mode, rendering
  benchmarks.html            # /benchmarks: use-case tabs (agentic/reasoning/knowledge/UI), value-benchmark dropdown incl. "no filter", mix-aware From $/M (Text-page localStorage), org filter, FAQ → /faq/
  benchmarks-app.js          # Benchmarks page app (mirrors blendedRate; value = score ÷ blended price normalized best-in-view = 100)
  choose/index.html          # /choose/: open model finder (nine use cases, three picks, provider ranking, priority + constraints)
  choose-app.js              # Finder app; imports the shared engine from /shared/*.mjs (copied by generate-seo.mjs)
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
  og/og-image.png            # Primary Open Graph social preview image (1200×630)
  og/og-image.svg            # Editable source for the social preview
  widget/
    embed.js                 # Embeddable widget (Shadow DOM, auto-detect, theme support)
    demo.html                # Widget demo page
functions/
  api/
    advisor.js               # Conversational AI Advisor API (Laggingway / InferX, IP rate-limited)
    v1/
      [[route]].js           # Cloudflare Pages Functions API
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

GitHub secrets required: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SINGULARITY_API_KEY`, `RUNINFRA_API_KEY` (the last two are used by the 2-hourly text pricing refresh).

## License

MIT. See [LICENSE](LICENSE).
