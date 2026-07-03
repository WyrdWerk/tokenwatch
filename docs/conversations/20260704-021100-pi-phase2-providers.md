---
timestamp: "2026-07-04T02:11:00+05:30"
agent_id: "pi"
agent_name: "Pi (Oh My Pi)"
session_id: "payg-pricing-phase2-provider-expansion-20260704"
user: "yash"
duration_minutes: 180
topics: ["payg-inference-calculator", "llm-pricing-comparison", "provider-expansion", "llmgateway", "synthetic", "lilac", "hyper", "makora", "xiaomimimo", "opencode-go", "csv-sourced-providers", "canonicalization", "org-extraction", "cloudflare-pages"]
related_repos: ["WyrdWerk/payg-inference-calculator"]
related_sessions: ["20260704-001612-pi"]
artifacts: []
learnings: [
  "LLMGateway is no longer an OpenRouter mirror — has 228 models, 39 providers, 83 unique canonicals vs OpenRouter as of 2026-07-03. Previously removed as mirror, now re-added as independent aggregator.",
  "Synthetic's /v1/models returns pricing with $ prefix ($0.0000014) — num() must strip $ and commas, not just parseFloat",
  "Synthetic cache_read is always 20% of input price per user spec, not from the API's input_cache_reads field",
  "Synthetic org extracted from hugging_face_id field, not model ID — model IDs are aliases like syn:large:text",
  "Novita pricing unit: integers where 10000=$1/M (verified by cross-referencing GLM-5.2 across providers)",
  "Lilac (api.getlilac.com) is a public no-auth provider with 6 models — discovered via CSV, not in original 6 endpoints",
  "Hyper, Makora, Xiaomimimo, Baseten, Fireworks, GeneralCompute, SiliconFlow all have auth-gated or pricing-less APIs — CSV is the fallback for static pricing",
  "OpenCode Go has no pricing in API but user provided corrected pricing table with 16 models including tiered Qwen (≤256K vs >256K as separate entries)",
  "canonToOrg map must be built from m.org (parser-set) not orgFromId(m.id) — otherwise Synthetic's hf: prefixed IDs pollute the map",
  "orgLookupKey() strips quantization suffixes (-fp8, -nvfp4, -int4-mixed-ar) and tier suffixes (-long) for org cross-referencing only, keeping canonicalId() separate for model matching",
  "Zero-price filter: drop models where both input=0 AND output=0 (catches TTS/image/video generation models from LLMGateway)",
  "Cloudflare Pages doesn't auto-deploy on git push — only GitHub Actions cron triggers deploy. Manual deploy with wrangler pages deploy needed after pushing changes.",
  "CSV model IDs with spaces must be normalized to hyphens for cross-provider matching (Hyper CSV uses 'DeepSeek V4 Flash' → 'deepseek-v4-flash')"
]

---

## Context

Continued work on the PAYG Inference Calculator project at `~/projects/PAYGO Pricing`. This session covered: Phase 2 completion (dual search UX, aggressive canonicalization), then a major provider expansion adding 7 new providers (LLMGateway, Synthetic, Lilac, Hyper, Makora, Xiaomimimo, OpenCode Go) bringing the total from 469 models across 5 providers to 726 models across 12 providers.

## Key Discussion Points

1. **Phase 2: Canonicalization improvements** — Updated `canonicalId()` in both `fetch-pricing.mjs` and `app.js` to strip date suffixes (`-2024-08-06`), preview suffixes (`-preview`, `-preview-05-06`), and `:thinking` suffix. 9 near-miss clusters now merge correctly (gpt-4o date variants, gemini preview variants, qwen-plus :thinking). Turbo variants kept separate (genuinely different SKUs).

2. **Phase 2: Dual search UX** — Replaced "Compare by: [Model|Provider]" dropdown with two `<datalist>`-powered typeahead inputs: "Search by provider" (lists orgs, not aggregators) and "Search by model" (lists canonical model names). Both work together (AND filter). State refactored from `mode`/`selectedModel`/`selectedProvider` → `providerSearch`/`modelSearch` + lookup maps. Org display names: `z-ai`→`Z.ai`, `openai`→`OpenAI`, etc.

3. **Provider investigation** — Investigated 6 user-provided endpoints + LLMGateway. Found: Hyper has no pricing in API, Makora/Xiaomimimo/SiliconFlow need auth, Synthetic/LLMGateway/Lilac have public no-auth pricing. User's Google Sheet CSV (`~/Downloads/PAYG Inference Pricing - Sheet1.csv`) has 16 providers with pricing for auth-gated ones.

4. **LLMGateway re-added** — Previously removed as an OpenRouter mirror. Now has 228 models, 39 underlying providers, 83 unique canonicals. Re-added with org extracted from `providers[0].providerId` field (bare IDs like `gpt-4o-mini` have no slash prefix). 33 zero-price models (TTS/image/video) dropped.

5. **Synthetic added** — 11 models. Pricing has `$` prefix (`$0.0000014`) requiring `num()` fix. Cache_read = 20% of input price (per user spec, not API). Org from `hugging_face_id` field (model IDs are aliases like `syn:large:text` → `hugging_face_id: zai-org/GLM-5.2`).

6. **Lilac added** — 6 models. Standard $/token pricing, org from ID prefix. Discovered via CSV, not in original 6 endpoints.

7. **CSV-sourced providers (Hyper, Makora, Xiaomimimo)** — Created `data/manual-pricing.csv` from the Google Sheet export. Added `parseCsvProviders()` that reads the CSV, extracts provider sections by URL matching, normalizes model IDs (spaces→hyphens). All prices already $/M — passthrough.

8. **OpenCode Go hardcoded** — 16 models with user-provided pricing table. Includes tiered Qwen models as separate entries: `qwen3.7-plus` (≤256K) and `qwen3.7-plus-long` (>256K). Hardcoded because CSV data was stale and user provided corrected pricing directly.

9. **Org resolution architecture** — 5-level fallback: (1) parser-set org, (2) orgFromId, (3) canonToOrg via orgLookupKey (strips quantization/tier suffixes), (4) canonToOrg via canonicalId, (5) orgFromName, (6) fallback to provider. canonToOrg map built from `m.org` not `orgFromId(m.id)`. Added `zai`→`z-ai` alias (LLMGateway's providerId returns "zai" without dot).

10. **Browser smoke test** — Verified all acceptance criteria: GLM-5.2 shows 12 offerings across all 12 providers with consistent "Z.ai" org badge. OpenAI org search returns 84 models from LLMGateway(41) + OpenRouter(41) + Synthetic(1) + Hyper(1). OpenCode Go tiered Qwen models appear as separate entries.

## Decisions Made

- [x] Phase 2 canonicalization: strip date/preview/:thinking suffixes, keep turbo separate
- [x] Phase 2 dual search: replace mode dropdown with dual typeahead inputs
- [x] Re-add LLMGateway as independent aggregator (no longer a mirror)
- [x] Synthetic cache_read = 20% of input (user spec overrides API value)
- [x] Add Lilac as API-fetched provider (discovered via CSV)
- [x] CSV-sourced providers: Hyper, Makora, Xiaomimimo from committed `data/manual-pricing.csv`
- [x] OpenCode Go: 16 models hardcoded from user-provided pricing table
- [x] Exclude Novita for now (postponed)
- [x] Zero-price filter: drop models where both input=0 AND output=0
- [x] orgLookupKey() separate from canonicalId() — quantization/tier suffixes stripped for org lookup only
- [x] canonToOrg map built from m.org (parser-set) not orgFromId(m.id)

## Action Items

- [ ] Consider adding Novita (132 models, pricing unit ÷10000) in a future iteration
- [ ] Consider adding auth-gated providers (Makora API, Xiaomimimo API, SiliconFlow) with API keys
- [ ] Consider rate limit display for OpenCode Go (user provided request limits per 5h/week/month)
- [ ] Cloudflare Pages doesn't auto-deploy on git push — consider setting up push-triggered deploy or documenting manual deploy step
- [ ] Update `data/manual-pricing.csv` periodically when CSV-sourced provider prices change

## Code/Config References

- **Repo**: https://github.com/WyrdWerk/payg-inference-calculator
- **Live site**: https://payg-inference-calculator.pages.dev
- **Commits**: `e4c2bf8` (Phase 2: dual search + canonicalization), `c681afb` (7 new providers)
- **fetch-pricing.mjs**: `scripts/fetch-pricing.mjs` — 12 providers, 3 parser types (API, CSV, hardcoded)
- **CSV data**: `data/manual-pricing.csv` — static pricing for Hyper/Makora/Xiaomimimo
- **OpenCode Go**: hardcoded `OPENCODE_GO_MODELS` array in fetch-pricing.mjs
- **LLMGateway**: `parseLLMGateway()` — org from `providers[0].providerId`, 195 models with pricing
- **Synthetic**: `parseSynthetic()` — org from `hugging_face_id`, cache_read = input × 0.20
- **Lilac**: `parseLilac()` — standard $/token, org from ID prefix
- **CI/CD**: `.github/workflows/refresh-pricing.yml` — daily cron, does NOT auto-deploy on push (manual wrangler deploy needed)
- **GitHub secrets**: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

## Next Steps / Follow-up

1. **Novita integration** — 132 models with non-standard pricing unit (÷10000). Endpoint is public no-auth. Could be added as another API-fetched provider. User excluded for now but it's the next obvious addition.

2. **Auth-gated provider APIs** — Makora, Xiaomimimo, SiliconFlow, Baseten, Fireworks, GeneralCompute all have /v1/models endpoints that require Bearer tokens. Would need API keys stored as GitHub Actions secrets to integrate into the automated pipeline. Currently covered via CSV fallback.

3. **Cloudflare Pages auto-deploy** — The CI/CD workflow only deploys on daily cron, not on push. Changes pushed to main require manual `wrangler pages deploy` to go live. Should either set up push-triggered deploy in the workflow or document the manual step.

4. **Rate limits display** — User provided OpenCode Go request limits (per 5h/week/month) which could be displayed as supplementary info in the calculator UI.

5. **CSV maintenance** — The `data/manual-pricing.csv` file needs periodic manual updates when CSV-sourced provider prices change.
