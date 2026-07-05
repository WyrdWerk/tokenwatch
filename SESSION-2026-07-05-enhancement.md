---
timestamp: 2026-07-05T11:40:01+05:30
agent_id: pi
agent_name: Pi (Oh My Pi)
user: yash-jain
topics: [tokenwatch, paygo-pricing, llm-pricing, openrouter, cloudflare-pages, frontend, api, widget, provider-metadata, cache-write, sambanova, enhancement-plan]
---

# TokenWatch Enhancement Session — 2026-07-05

## Context

Comprehensive enhancement session for the PAYGO Inference Calculator (TokenWatch) project at `~/projects/PAYGO Pricing`. The project is a zero-dependency Node ESM static site comparing pay-as-you-go LLM API pricing across ~75 inference providers, deployed to Cloudflare Pages at tokenwatch.wyrdwerk.com. Starting state: 891 models, 11 source providers, daily CI/CD cron.

## Key Discussion Points

### 1. Repo comprehension (4 parallel explore subagents)
- Mapped data pipeline (fetch-pricing.mjs, 752 lines), frontend (app.js, index.html, styles.css), CI/CD (workflow YAML, package.json, manual-pricing.csv), and current data state (pricing.json)
- Confirmed 3-tier architecture: Tier 1 direct providers (DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac), Tier 2 OpenRouter de-aggregated via /endpoints, Tier 3 CSV/hardcoded (Hyper, Makora, Xiaomimimo, OpenCode Go)
- Dedup key: (canonical_model, normalized_provider) — quantization excluded

### 2. Enhancement scope identification
Identified 40+ potential enhancements across data coverage, UI/design, performance, features, and DX/ops. User selected 11 items:
- A1 (auth-gated providers — postponed, no API keys)
- A3 (SambaNova direct provider)
- A8 (cache_write support — dropped, no-op initially but later fixed as parser bug)
- B1 (comparison mode)
- B2 (group-by toggle)
- B5 (URL state persistence)
- D1 (monthly cost estimator)
- D5 (queryable API)
- D6 (embeddable widget)
- E1 (auto-deploy on push)
- E2 (dry-run mode)

### 3. Provider API investigation
Probed 14 LLM inference providers for public (no-auth) /v1/models endpoints:
- **Public**: SambaNova (6 models, $/token, display.group.id filter), Novita/DeepInfra/OpenRouter (already in pipeline)
- **Auth-gated (401/403)**: Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate, Mistral
- **Unreachable/404**: GeneralCompute, Mancer, Morph, Lepton, Chutes
- Decision: Keep all direct fetches. Join /api/v1/providers metadata onto all rows. Only SambaNova is a new public provider.

### 4. OpenRouter API deep dive
- `/endpoints` response contains: pricing.input_cache_write (was being DROPPED to null — parser bug), ep.uptime_last_30m, ep.max_completion_tokens, ep.supports_implicit_caching
- latency_last_30m and throughput_last_30m are always null — not available via public API
- `/api/v1/providers` (90 providers): privacy_policy_url, terms_of_service_url, status_page_url, headquarters, datacenters — 78/90 have populated policy URLs
- 7 of our providers missing from OR: crof, ember, hyper, lilac, makora, synthetic, opencode — need manual metadata

### 5. cache_write cost model decision
- cache_write is a one-time cost (writing prompt to cache on first request), NOT a recurring throughput slice
- The percentage model (input% + cacheRead% + output% = 100%) represents per-request throughput
- Adding cache_write as a 4th percentage would double-count tokens and corrupt the economic model
- Decision: cache_write is DISPLAY-ONLY in the table column + comparison modal. getTokens() hardcodes cacheWrite: 0 which is correct.

## Decisions Made

1. **Keep all direct fetches** — dropping them risks coverage loss (233/891 = 26% of models) and would trigger the >15% coverage-drop abort. Provider metadata from /api/v1/providers joins to ANY row by slug regardless of source.

2. **SambaNova parser**: Do NOT set m.org from owned_by (uniformly "no-reply@sambanova.ai"). Let the standard 5-level org pipeline resolve from model name. For bare IDs like "Meta-Llama-3.3-70B-Instruct", match leading segments against ORG_ALIASES.

3. **cache_write**: Display-only, not in cost computation. The data is parsed and shown but getTokens() hardcodes cacheWrite: 0.

4. **Provider metadata precedence**: OR data overwrites manual for the same slug. Manual entries are fallback for providers not in OR. Alias resolution via PROVIDER_NAME_MAP (e.g. xiaomimimo inherits xiaomi metadata).

5. **D5 via Cloudflare Pages Functions** (not standalone Worker) — same origin, deploys with the Pages site, no second pipeline.

6. **Widget in public/widget/** — must be inside public/ to deploy via `wrangler pages deploy public`. Root-level widget/ dir was orphaned and removed.

7. **Mobile UI is broken** — adding the Cache Write column (9→10 columns) caused column misalignment. Data is rendering in wrong columns. Documented as critical bug in TODO.md.

## Action Items

### Completed (all committed, pushed, deployed)
- E1: Auto-deploy on push (two-job workflow: cron=fetch+deploy, push=deploy-only)
- E2: --dry-run mode in fetch pipeline
- B5: URL hash state persistence (shareable filtered views)
- A3: SambaNova as Tier-1 direct provider (5 models)
- A3: Fixed OpenRouter cache_write parser (58 models now have real values, was hardcoded null)
- A3: Captured uptime_30m (522 models) + max_completion_tokens (584 models) from OR endpoints
- F1: Provider metadata from OR /api/v1/providers + MANUAL_PROVIDER_META for 7 providers
- F1: Alias resolution (xiaomimimo→xiaomi via PROVIDER_NAME_MAP)
- D1: Monthly cost estimator mode toggle
- B2: Group-by toggle (None/Org/Provider) with collapsible headers
- B1: Comparison mode (checkbox per row, tray, side-by-side modal, max 4)
- F2: Provider HQ flag badges (🇺🇸🇸🇬🇨🇳 etc.)
- F3: Privacy/ToS/status links in provider cells
- Cache Write $/M column (display-only)
- D5: Queryable API via Cloudflare Pages Functions
- D6: Embeddable widget (Shadow DOM, auto-detect, theme support)
- WyrdWerk homepage link in header
- AGENTS.md and README.md documentation updated
- TODO.md created with bugs and planned features

### Not done / Postponed
- A1: Auth-gated direct providers — postponed (no API keys, all covered via OR backends)
- A8: Cache write in cost computation — display-only (correct for percentage model)
- ZDR enhancements — not implemented (no API source, needs manual data from user)
- Mobile UI fix — documented as critical bug (column misalignment after adding Cache Write column)
- Historical price tracking — not started
- EmberCloud HQ/datacenters — still null

## Code/Config References

### Files modified
- `scripts/fetch-pricing.mjs` (752→918 lines): SambaNova parser, OR endpoint parser fix (cache_write/uptime/max_completion), MANUAL_PROVIDER_META, fetchProviderMeta(), alias resolution, dry-run mode
- `public/app.js` (376→743 lines): URL hash, monthly mode, group-by, comparison modal, HQ badges, meta links, cache_write column, setCostMode
- `public/index.html` (123→151 lines): mode toggle, group-by dropdown, comparison tray+modal, cache_write header, WyrdWerk link, colspan updates
- `public/styles.css` (277→440+ lines): mode toggle, group headers, comparison modal/tray, HQ badge, meta links, collapse arrows
- `public/pricing.json`: 891 models, 12 providers, providers_meta (97 entries), cache_write (58 populated), uptime_30m (522), max_completion_tokens (584)
- `.github/workflows/refresh-pricing.yml`: Two-job workflow (refresh on cron, deploy on push)
- `AGENTS.md`: Full rewrite with all new features
- `README.md`: Full rewrite with API, widget, new features

### Files created
- `functions/api/v1/[[route]].js`: Pages Functions API (188 lines)
- `public/widget/embed.js`: Embeddable widget (176 lines)
- `public/widget/demo.html`: Widget demo page
- `TODO.md`: Bugs and planned features

### Key data points
- Final model count: 891 (was 891 at start, went to 893 with SambaNova, back to 891 after xiaomimimo→xiaomi dedup)
- Provider count: 12 (was 11, +SambaNova)
- providers_meta: 97 entries (90 OR + 7 manual)
- cache_write populated: 58 models (was 0 — parser bug fixed)
- Commits: e71585e (main features), abf27ce (WyrdWerk link + widget deploy), 463fe60 (remove orphaned widget/), fa8369b (docs update)

### Manual provider metadata provided by user
- Crof: https://crof.ai/privacy, https://crof.ai/tos
- EmberCloud: https://www.embercloud.ai/privacy, https://www.embercloud.ai/terms
- Hyper: https://hyper.charm.land/privacy, https://hyper.charm.land/terms
- Lilac: https://getlilac.com/privacy, https://getlilac.com/terms
- Makora: https://www.makora.com/privacy-policy, https://www.makora.com/terms-of-service
- Synthetic: https://synthetic.new/policies/privacy, https://synthetic.new/policies/terms-of-service
- OpenCode Go: https://opencode.ai/legal/privacy-policy, https://opencode.ai/legal/terms-of-service

## Next Steps

1. **Fix mobile UI / column misalignment** — critical bug, data rendering in wrong columns
2. **Implement ZDR enhancements** — needs user to provide ZDR status per provider
3. **Start a fresh session** — context window is very large, rate limits were hit
4. **Verify column alignment** — renderModelRow td order must match index.html th order exactly
5. **Mobile responsive layout** — card layout for ≤640px

## Lessons Learned (this session)

1. **Concurrent writes to same file**: Two subagents writing fetch-pricing.mjs caused clobbering. Bundle same-file changes into one agent.
2. **Eval kernel import caching**: After running fetch-pricing.mjs via execSync, a subsequent import of pricing.json returned stale data. Use jq via bash to verify file contents on disk.
3. **Script tag position**: B1 subagent placed compare-modal HTML AFTER the `<script>` tag → els.compareClose was null → attachListeners threw → init aborted before computeAndRender → table showed empty state. Always place HTML elements BEFORE the script tag.
4. **SWAP edit boundary errors**: The edit tool's SWAP operation silently drops/duplicates adjacent lines when the range is off by one. The "Auto-repaired" warning is the signal. Always re-read after SWAP.
5. **Widget deployment**: `wrangler pages deploy public` only deploys the public/ directory. Widget files must be inside public/ to deploy.
6. **PROVIDER_NAME_MAP changes affect dedup**: Adding 'xiaomimimo'→'xiaomi' changed normalizeProvider() behavior, causing CSV Xiaomi rows to dedup against OR xiaomi rows (correct but dropped 2 models).
7. **Rate limits**: Very long sessions with many tool calls and large accumulated context will hit inference gateway rate limits. Start fresh sessions for new work.
