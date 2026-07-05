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
  - Writes `public/pricing.json` with ~891 text-generation models across ~75 inference providers
- **Provider metadata**: `fetchProviderMeta()` fetches OpenRouter `/api/v1/providers` for policy URLs, HQ, datacenters. Merges with `MANUAL_PROVIDER_META` for providers not in OR (crof, ember, hyper, lilac, makora, synthetic, opencode). Alias resolution via `PROVIDER_NAME_MAP` (e.g. `xiaomimimo` inherits `xiaomi` metadata).
- **Frontend**: `public/` static site loads `pricing.json` client-side. Dual typeahead search (by inference provider and by model). Cost computation entirely in-browser. Features: group-by toggle (None/Org/Provider), comparison mode (side-by-side modal), monthly cost estimator mode, URL hash state persistence, provider HQ flag badges, privacy/ToS/status links, promo badges, Cache Write column (display-only).
- **API**: Cloudflare Pages Functions at `functions/api/v1/` serve queryable endpoints: `/api/v1/models` (with filters), `/api/v1/models/:id/providers`, `/api/v1/stats`, `/api/v1/providers`.
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

Manual entries (`MANUAL_PROVIDER_META` in fetch-pricing.mjs) cover providers not in OR: crof, ember, hyper, lilac, makora, synthetic, opencode. OR data takes precedence over manual for the same slug.

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

### Cost computation

Percentage-based: user enters total tokens (in millions) + percentage breakdown (input %, cached input %, output %). Cost = `(tokens × $/M) / 1e6` per component, summed. If a provider doesn't support a requested token type (>0 tokens), that offering is excluded.

Cache write pricing is **display-only** — shown in the table column and comparison modal but NOT included in cost computation. Cache write is a one-time cost (writing to cache on first request), not a recurring per-request throughput slice. The percentage model represents per-request throughput where cache_read replaces input on subsequent requests.

Two cost modes: **Per Request** (default) and **Monthly Volume** — same computation, different labels.

### Resilience

The pipeline includes unattended-operation safeguards:
- **Retry on failure**: 429/5xx responses retried once with 2s backoff
- **Abort on >20% failure rate**: if >20% of OpenRouter `/endpoints` calls fail, the entire refresh aborts (prevents shipping a half-missing catalog)
- **Coverage-drop check**: if model count drops >15% vs previous `pricing.json`, the refresh aborts to preserve last-good data
- **Dry-run mode**: `node scripts/fetch-pricing.mjs --dry-run` runs the full pipeline without writing pricing.json

## Files to know

| File | Purpose |
|---|---|
| `scripts/fetch-pricing.mjs` | 3-tier fetch, OpenRouter de-aggregation, provider metadata, org extraction, dedup, pricing normalization, dry-run mode |
| `public/app.js` | Frontend state, URL hash persistence, search, cost computation, group-by, comparison mode, monthly mode, HQ badges, meta links, rendering |
| `public/index.html` | UI layout: controls, usage-grid with mode toggle, 10-column results table, group-by, comparison tray + modal |
| `public/styles.css` | Dark/light theme, all badges (org, provider, promo, HQ, meta-link), group headers, comparison modal/tray, mode toggle, responsive |
| `public/pricing.json` | Generated data — models (with pricing, cache_write, uptime_30m, max_completion_tokens), providers, providers_meta (do not hand-edit — CI refreshes daily) |
| `functions/api/v1/[[route]].js` | Cloudflare Pages Functions API — /models, /models/:id/providers, /stats, /providers with filtering, sorting, pagination, CORS |
| `public/widget/embed.js` | Embeddable widget — Shadow DOM, auto-detects [data-tw-model], fetches API, renders pricing card |
| `public/widget/demo.html` | Widget demo page |
| `.github/workflows/refresh-pricing.yml` | Daily cron (fetch+commit+deploy) + push-to-main (deploy-only) |
| `data/manual-pricing.csv` | Static pricing for CSV-sourced providers (Hyper, Makora, Xiaomimimo) |

## Development

```bash
npm run fetch          # Fetch and regenerate pricing.json (~317 API calls, ~15-20s)
npm run fetch -- --dry-run  # Dry run — process but don't write pricing.json
npm run serve          # Serve public/ on localhost:3000
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

- `GET /api/v1/` — API info and available endpoints
- `GET /api/v1/stats` — summary: model count, provider count, per-provider counts
- `GET /api/v1/providers` — provider metadata (privacy/ToS/status URLs, HQ, datacenters)
- `GET /api/v1/models` — list models with filters: `?org=`, `?provider=`, `?min_context=`, `?promo=true`, `?search=`, `?sort=`, `?order=`, `?limit=`, `?offset=`
- `GET /api/v1/models/:canonicalId/providers` — all providers hosting a model, sorted by cost

## Next steps

1. **Auth-gated providers**: Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate, Mistral have auth-gated `/v1/models` endpoints. Would need API keys as GitHub Actions secrets. All are already covered via OpenRouter `/endpoints` backends — direct fetch would give Tier-1 precedence + fresher data, not new coverage.
2. **CSV maintenance**: `data/manual-pricing.csv` needs periodic manual updates for Hyper/Makora/Xiaomimimo pricing. If these models appear in OpenRouter backends, the CSV could be dropped.
3. **Turbo/preview grouping**: Currently turbo and preview variants are kept separate. Could add UI to group them with their base model.
4. **Historical price tracking**: Store daily snapshots to surface price-drop alerts or trend charts.
5. **Cache write in cost computation**: Currently display-only. Could add a separate "cache write tokens (one-time)" input with amortization.
6. **EmberCloud provider metadata**: `MANUAL_PROVIDER_META` for ember has URLs filled but no HQ/datacenters — update if available.
