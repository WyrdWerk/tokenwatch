# AGENTS.md — PAYG Inference Calculator

## Project overview

Static site comparing pay-as-you-go LLM API pricing across 5 providers (OpenRouter, DeepInfra, Crof, EmberCloud, Wafer). Zero dependencies, pure Node ESM. Deployed to Cloudflare Pages with daily CI/CD refresh.

## Architecture

- **Data pipeline**: `scripts/fetch-pricing.mjs` fetches `/v1/models` from each provider, normalizes pricing to $/M tokens, extracts `org` (underlying model creator) from model IDs, writes `public/pricing.json`.
- **Frontend**: `public/` static site loads `pricing.json` client-side. Cost computation happens entirely in-browser.
- **CI/CD**: `.github/workflows/refresh-pricing.yml` runs daily at 00:00 UTC — fetch → commit → deploy to Cloudflare Pages.

## Key conventions

### Pricing normalization

All prices are stored as **USD per million tokens ($/M)**. Conversion by provider:
- OpenRouter / EmberCloud: $/token → ×1e6
- DeepInfra / Crof: $/M (passthrough)
- Wafer: cents/M → ÷100

### Org extraction

OpenRouter is an aggregator, not a provider. The `org` field extracts the underlying model creator:
1. From model ID prefix: `anthropic/claude-sonnet-5` → `anthropic`
2. Cross-reference: models without `/` (e.g., Crof's `glm-5.2`) matched against canonical IDs from models that have org prefixes
3. From model name: `DeepSeek: DeepSeek V4 Pro` → `deepseek`
4. Fallback: provider name (e.g., Crof's `greg-2-ultra` → `crof`)

Org aliases normalized: `deepseek-ai`→`deepseek`, `zai-org`→`z-ai`, `meta-llama`→`meta`, `minimaxai`→`minimax`, etc.

### Data filtering

- `:free` entries are dropped (nobody cares about free tier)
- Negative placeholder prices are dropped (OpenRouter meta-routers use -1000000)
- LLMGateway was removed entirely (mirror of OpenRouter at identical prices)

### Canonical model ID

Used for cross-provider matching: strips provider prefix, removes `:free` suffix, lowercases. Example: `z-ai/glm-5.2` and `GLM-5.2` both canonicalize to `glm-5.2`.

### Cost computation

Percentage-based: user enters total tokens (in millions) + percentage breakdown (input %, cached input %, output %). Cost = `(tokens × $/M) / 1e6` per component, summed. If a provider doesn't support a requested token type (>0 tokens), that offering is excluded.

## Files to know

| File | Purpose |
|---|---|
| `scripts/fetch-pricing.mjs` | Provider fetch, org extraction, pricing normalization |
| `public/app.js` | Frontend state, selectors, cost computation, rendering |
| `public/index.html` | UI layout: controls, usage-grid, results table |
| `public/styles.css` | Dark/light theme, org-badge, provider-badge, pct-ok/pct-warn |
| `public/pricing.json` | Generated data (do not hand-edit — CI refreshes daily) |
| `.github/workflows/refresh-pricing.yml` | Daily cron + Cloudflare deploy |

## Development

```bash
npm run fetch     # Fetch and regenerate pricing.json
npm run serve     # Serve public/ on localhost:3000
```

## Deployment

Cloudflare Pages project: `payg-inference-calculator`
- Production branch: `main`
- Build output: `public/`
- GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

Manual deploy: `npx wrangler pages deploy public --branch main --commit-dirty true`

## Known limitations / Next steps

1. **OpenRouter segregation**: OpenRouter models have org prefixes but are still labeled as provider "openrouter" in the frontend. Should display org as the actual provider.
2. **Model aggregation**: `canonicalModelId` doesn't handle case/hyphen variants (`Kimi-K2.6` vs `kimi-k2.6` vs `Kimi-K2.6`). Needs more aggressive normalization.
3. **Search UX**: Current mode dropdown + select pattern should be replaced with dual typeahead search fields (provider search + model search).
4. **Canonicalization near-misses**: Date-suffixed variants (`gpt-4o-2024-08-06` vs `gpt-4o`) don't merge. 14 known cases.
