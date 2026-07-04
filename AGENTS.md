# AGENTS.md — PAYG Inference Calculator

## Project overview

Static site comparing pay-as-you-go LLM API pricing across inference providers. Uses OpenRouter's `/endpoints` API to de-aggregate per-backend pricing (each backend like DeepInfra, Fireworks, Together becomes its own row). Zero dependencies, pure Node ESM. Deployed to Cloudflare Pages with daily CI/CD refresh.

## Architecture

- **Data pipeline**: `scripts/fetch-pricing.mjs` fetches pricing from 3 tiers:
  - **Tier 1 — Direct providers** (authoritative): DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac — fetched via their own `/v1/models` endpoints
  - **Tier 2 — OpenRouter de-aggregated**: `/v1/models` lists models, then `/endpoints` per model returns per-backend pricing. Each backend (Fireworks, Together, Novita, SiliconFlow, etc.) becomes its own row — NOT "OpenRouter"
  - **Tier 3 — CSV/hardcoded**: Hyper, Makora, Xiaomimimo (CSV), OpenCode Go (hardcoded)
  - **3-tier precedence**: `(canonical_model, normalized_provider, quantization)` — direct wins over OpenRouter, which wins over CSV/hardcoded
  - Writes `public/pricing.json` with ~944 text-generation models across ~75 inference providers
- **Frontend**: `public/` static site loads `pricing.json` client-side. Dual typeahead search (by org and by model). Cost computation entirely in-browser. Quantization column and promo badges for discounted offerings.
- **CI/CD**: `.github/workflows/refresh-pricing.yml` runs daily at 00:00 UTC — fetch → commit → deploy to Cloudflare Pages.

## Key conventions

### Pricing normalization

All prices are stored as **USD per million tokens ($/M)**. Conversion by source:
- OpenRouter `/endpoints`: $/token → ×1e6
- EmberCloud / Lilac: $/token → ×1e6
- DeepInfra / Crof / Hyper / Makora / Xiaomimimo / OpenCode Go: $/M (passthrough)
- Wafer: cents/M → ÷100
- Synthetic: $/token → ×1e6, cache_read = input × 0.20 (per spec, not from API)

### Discount field

OpenRouter `/endpoints` returns a `discount` field (0 = structural price, >0 = promotional). The `discount` magnitude is the fraction off (e.g., 0.7 = 70% off). Promo prices are shown with a "promo" badge in the UI. No pre-discount/original price is available from the API — only the current (possibly discounted) price and the discount fraction.

### Text-only filtering

Only text-generation models are included (output must be text). Filtering by source:
- **OpenRouter**: `architecture.output_modalities` must be exactly `["text"]`. Allows multimodal input (text+image+file→text).
- **DeepInfra**: `metadata.tags` excludes `image-gen`, `tts`, `stt`, `embed`, `embeddings`, `video-gen`, `audio`.
- **Other direct providers** (Crof, Wafer, Lilac): ID-based regex fallback for embeddings/TTS (no structured metadata available).

### Provider-name normalization

`PROVIDER_NAME_MAP` reconciles direct-provider keys (`ember`, `deepinfra`, `wafer`) with OpenRouter display names (`EmberCloud`, `DeepInfra`, `Wafer`) for dedup precedence. Direct providers also stored in `providers` array with display names for frontend rendering.

### Org extraction

The `org` field identifies the underlying model creator (not the inference provider):
1. From model ID prefix: `anthropic/claude-sonnet-5` → `anthropic`
2. From parser-set org: Synthetic sets org from `hugging_face_id` field
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

Used for cross-provider matching: strips provider prefix, removes suffixes (`:free`, date suffixes, `-preview`, `:thinking`), lowercases. Turbo variants kept separate. Example: `z-ai/glm-5.2`, `zai-org/GLM-5.2`, `GLM-5.2` (Wafer) all canonicalize to `glm-5.2`.

### Cost computation

Percentage-based: user enters total tokens (in millions) + percentage breakdown (input %, cached input %, output %). Cost = `(tokens × $/M) / 1e6` per component, summed. If a provider doesn't support a requested token type (>0 tokens), that offering is excluded.

### Resilience

The pipeline includes unattended-operation safeguards:
- **Retry on failure**: 429/5xx responses retried once with 2s backoff
- **Abort on >20% failure rate**: if >20% of OpenRouter `/endpoints` calls fail, the entire refresh aborts (prevents shipping a half-missing catalog)
- **Coverage-drop check**: if model count drops >15% vs previous `pricing.json`, the refresh aborts to preserve last-good data

## Files to know

| File | Purpose |
|---|---|
| `scripts/fetch-pricing.mjs` | 3-tier fetch, OpenRouter de-aggregation, org extraction, dedup, pricing normalization |
| `public/app.js` | Frontend state, selectors, cost computation, rendering (quant column, promo badges) |
| `public/index.html` | UI layout: controls, usage-grid, results table (9 columns incl. Quant) |
| `public/styles.css` | Dark/light theme, org-badge, provider-badge, quant, promo-badge, pct-ok/pct-warn |
| `public/pricing.json` | Generated data (do not hand-edit — CI refreshes daily) |
| `.github/workflows/refresh-pricing.yml` | Daily cron + Cloudflare deploy |
| `data/manual-pricing.csv` | Static pricing for CSV-sourced providers (Hyper, Makora, Xiaomimimo) |

## Development

```bash
npm run fetch     # Fetch and regenerate pricing.json (~317 API calls, ~15-20s)
npm run serve     # Serve public/ on localhost:3000
```

## Deployment

Cloudflare Pages project: `payg-inference-calculator`
- Production branch: `main`
- Build output: `public/`
- GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

Manual deploy: `npx wrangler pages deploy public --branch main --commit-dirty true`

## Next steps

1. **Auth-gated providers**: Makora, Xiaomimimo, SiliconFlow, Baseten, Fireworks, GeneralCompute have auth-gated `/v1/models` endpoints. Would need API keys as GitHub Actions secrets. Many are already covered via OpenRouter `/endpoints` backends — check overlap before adding direct keys.
2. **Cloudflare Pages auto-deploy on push**: Currently only deploys on daily cron. Code changes require manual `wrangler pages deploy`.
3. **CSV maintenance**: `data/manual-pricing.csv` needs periodic manual updates for Hyper/Makora/Xiaomimimo pricing. If these models appear in OpenRouter backends, the CSV could be dropped.
4. **Turbo/preview grouping**: Currently turbo and preview variants are kept separate. Could add UI to group them with their base model.
