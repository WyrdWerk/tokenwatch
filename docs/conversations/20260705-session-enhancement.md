---
timestamp: 2026-07-05T11:40:01+05:30
topics: [tokenwatch, paygo-pricing, llm-pricing, openrouter, cloudflare-pages, frontend, api, widget, provider-metadata, cache-write, sambanova, enhancement-plan]
---

# TokenWatch Enhancement Session — 2026-07-05

## Phase Summary

Comprehensive enhancement session for TokenWatch (formerly PAYG Inference Calculator): a zero-dependency Node ESM static site comparing pay-as-you-go LLM API pricing across ~75 inference providers, deployed to Cloudflare Pages. Starting state: 891 models, 11 source providers, daily CI/CD cron. Eleven enhancements selected from a larger backlog and implemented.

## What Was Built

### Data pipeline enhancements
- **SambaNova** as Tier-1 direct provider (5 models; public `/v1/models`, `display.group.id` filter)
- **OpenRouter parser fix**: `pricing.input_cache_write` was being dropped to null — now populated for 58 models
- **Endpoint metadata**: `uptime_30m` (522 models), `max_completion_tokens` (584 models) from OR `/endpoints`
- **Provider metadata**: `/api/v1/providers` (90 providers) joined to rows — privacy_policy_url, terms_of_service_url, status_page_url, headquarters, datacenters; `MANUAL_PROVIDER_META` for seven providers not in OR
- **Alias resolution**: `xiaomimimo`→`xiaomi` via `PROVIDER_NAME_MAP`
- **Dry-run mode**: `--dry-run` flag in fetch pipeline

### Frontend features
- **Monthly cost estimator** mode toggle
- **Group-by toggle** (None/Org/Provider) with collapsible headers
- **Comparison mode**: checkbox per row, tray, side-by-side modal (max 4)
- **URL hash state persistence** (shareable filtered views)
- **Provider HQ flag badges** (country flags)
- **Privacy/ToS/status links** in provider cells
- **Cache Write $/M column** (display-only)
- **WyrdWerk homepage link** in header
- **Cache-busting**: `?v=20260705a` query strings on script/style tags

### API and widget
- **Queryable API**: Cloudflare Pages Functions at `functions/api/v1/[[route]].js`
- **Embeddable widget**: `public/widget/embed.js` (Shadow DOM, auto-detect, theme support) + `public/widget/demo.html`

### CI/CD
- **Auto-deploy on push**: two-job workflow (cron = fetch+deploy, push = deploy-only)

### Documentation
- `AGENTS.md` and `README.md` full rewrites
- `TODO.md` created with bugs and planned features

## Key Decisions

1. **Keep all direct fetches** — dropping risks 26% coverage loss and would trigger >15% coverage-drop abort. Provider metadata from `/api/v1/providers` joins to any row by slug.

2. **SambaNova parser**: Do NOT set `m.org` from `owned_by` (uniformly a no-reply address). Let the standard 5-level org pipeline resolve from model name.

3. **cache_write**: Display-only, not in cost computation. Percentage model (input% + cacheRead% + output% = 100%) represents per-request throughput; adding cache_write as a fourth percentage would double-count tokens.

4. **Provider metadata precedence**: OR data overwrites manual for same slug; manual entries fallback for providers not in OR.

5. **D5 via Cloudflare Pages Functions** (not standalone Worker) — same origin, deploys with Pages site.

6. **Widget in `public/widget/`** — must be inside `public/` for `wrangler pages deploy public`.

7. **Stale cache column misalignment**: Adding Cache Write column (9→10) caused returning visitors to see misaligned data — root cause was no cache-busting on script/style tags, not a code bug. Fixed with `?v=` query strings.

## Technical Discoveries

### Provider API investigation (14 providers probed)
- **Public**: SambaNova (6 models), Novita/DeepInfra/OpenRouter (already in pipeline)
- **Auth-gated (401/403)**: Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate, Mistral
- **Unreachable/404**: GeneralCompute, Mancer, Morph, Lepton, Chutes

### OpenRouter API
- `/endpoints`: `pricing.input_cache_write`, `ep.uptime_last_30m`, `ep.max_completion_tokens`, `ep.supports_implicit_caching`
- `latency_last_30m` and `throughput_last_30m` always null — not available via public API
- `/api/v1/providers`: 78/90 have populated policy URLs
- Seven providers missing from OR: crof, ember, hyper, lilac, makora, synthetic, opencode — manual metadata required

### Manual provider metadata (fallback for non-OR providers)
| Provider | Privacy | Terms |
|----------|---------|-------|
| Crof | crof.ai/privacy | crof.ai/tos |
| EmberCloud | embercloud.ai/privacy | embercloud.ai/terms |
| Hyper | hyper.charm.land/privacy | hyper.charm.land/terms |
| Lilac | getlilac.com/privacy | getlilac.com/terms |
| Makora | makora.com/privacy-policy | makora.com/terms-of-service |
| Synthetic | synthetic.new/policies/privacy | synthetic.new/policies/terms-of-service |
| OpenCode Go | opencode.ai/legal/privacy-policy | opencode.ai/legal/terms-of-service |

## Code Changes

| File | Lines | Changes |
|------|-------|---------|
| `scripts/fetch-pricing.mjs` | 752→918 | SambaNova parser, OR endpoint fix, MANUAL_PROVIDER_META, fetchProviderMeta(), dry-run |
| `public/app.js` | 376→743 | URL hash, monthly mode, group-by, comparison modal, HQ badges, meta links, cache_write column |
| `public/index.html` | 123→151 | Mode toggle, group-by, comparison tray+modal, cache_write header, WyrdWerk link |
| `public/styles.css` | 277→440+ | Mode toggle, group headers, comparison modal/tray, HQ badge, meta links |
| `public/pricing.json` | — | 891 models, 12 providers, providers_meta (97 entries) |
| `.github/workflows/refresh-pricing.yml` | — | Two-job workflow |
| `functions/api/v1/[[route]].js` | 188 | Pages Functions API (new) |
| `public/widget/embed.js` | 176 | Embeddable widget (new) |

**Commits**: `e71585e` (main features), `abf27ce` (WyrdWerk link + widget), `463fe60` (remove orphaned widget/), `fa8369b` (docs)

## Final State

- **891 models**, **12 source providers**, **97 providers_meta entries**
- **cache_write populated**: 58 models (was 0)
- **uptime_30m**: 522 models; **max_completion_tokens**: 584 models

## Lessons Learned

1. **Concurrent writes to same file**: Bundle same-file changes into one task to avoid clobbering.
2. **Module import caching**: After running fetch via execSync, subsequent import of `pricing.json` may return stale data — verify file contents on disk directly.
3. **Script tag position**: HTML elements referenced by JS must appear BEFORE the `<script>` tag, or `attachListeners` throws and init aborts.
4. **Edit boundary errors**: Text edit operations can silently drop/duplicate adjacent lines — always re-read after edits.
5. **Widget deployment**: `wrangler pages deploy public` only deploys `public/` — widget files must live there.
6. **PROVIDER_NAME_MAP affects dedup**: Adding `xiaomimimo`→`xiaomi` changed `normalizeProvider()` behavior, correctly deduping 2 models.
7. **Stale browser cache masquerading as code bug**: No cache-busting on script tags caused old 9-cell JS against new 10-col HTML — always add `?v=` when changing table column counts.

## Not Done / Postponed

- Auth-gated direct providers (covered via OR backends)
- Cache write in cost computation (display-only is correct for percentage model)
- ZDR enhancements (no API source; needs manual data)
- Mobile UI fix (10-column table too wide; card layout for ≤640px needed)
- Historical price tracking
- EmberCloud HQ/datacenters still null

## Next Steps

1. Mobile responsive layout — card layout for ≤640px
2. ZDR enhancements — manual ZDR status per provider
3. Cache-busting maintenance — update `?v=` on each deploy that changes app.js/styles.css
