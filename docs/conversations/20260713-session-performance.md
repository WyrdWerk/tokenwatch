---
timestamp: 2026-07-13T18:54:02+05:30
topics: [tokenwatch, paygo-pricing, crof, performance-data, latency, throughput, openrouter, cloudflare-pages, ci-cd]
---

# TokenWatch Enhancement Session — 2026-07-13

## Phase Summary

Added Crof performance (speed) data to the TokenWatch performance pipeline, upgraded the CI refresh cadence from daily to every 2 hours, and integrated the previously-orphaned `fetch-performance.mjs` script into CI. TokenWatch compares pay-as-you-go LLM inference pricing across ~75 inference providers.

## What Was Built

### Performance data pipeline
- **Crof speed data** added as a supplementary source (23 models, tokens/sec from Crof's public `/v1/models` API – no auth required)
- **Graceful degradation** when running without an OpenRouter API key: OR portion is skipped, but direct providers (Crof/Lilac/Umans) still fetch. A threshold guard prevents overwriting existing OR data with direct-only records
- **OpenRouter remains the primary** performance source (~1000 records with full latency + throughput percentiles)

### CI/CD upgrades
- Refresh cadence: daily → **every 2 hours**
- `fetch-performance.mjs` now runs in CI alongside pricing fetches
- `public/performance.json` committed alongside pricing data

### Bug fixes
- Fixed variable shadowing in `fetch-performance.mjs` (inner `let failed` shadowed outer, causing summary to always report 0 failures)

## Key Decisions

1. **Crof data source**: Used `/v1/models` API (same endpoint pricing already uses) rather than scraping the JS-rendered `/pricing` page — both expose the same data, but the API is simpler and more reliable
2. **OR as primary**: OpenRouter provides ~96% of performance records. The pipeline is designed to degrade gracefully without it, not to replace it
3. **2-hourly cadence**: Performance data (latency/throughput) changes more frequently than pricing, justifying the faster refresh
4. **Supplementary direct providers**: Crof/Lilac/Umans are not routed through OpenRouter, so they are fetched directly and merged in

## Technical Discoveries

- Crof `/v1/models` returns a `speed` field (integer, tokens/second) on every model object
- OpenRouter `/endpoints` returns null latency/throughput without a valid API key (HTTP 200 but empty fields)
- Running without OR key: 30 direct-only records vs ~1000 OR records → 85% threshold guard preserves existing data

## Code Changes

| File | Changes |
|------|---------|
| `scripts/fetch-performance.mjs` | Added `fetchCrofPerformance()` function, restructured `main()` for graceful degradation, fixed variable shadowing |
| `.github/workflows/refresh-pricing.yml` | Cron: daily → every 2h, added performance fetch step, added `performance.json` to commit |
| `AGENTS.md` | Updated resilience, deployment, and CI/CD sections |
| `public/pricing.json` | Updated performance data (23 Crof entries added) |

## Final State

- **~1000+ performance records** from OpenRouter (latency + throughput percentiles)
- **23 Crof records** (tokens/sec, from public API)
- **7 Lilac + 3 Umans records** (from their status APIs)
- **CI runs every 2 hours** → fetch → commit → deploy

## Session Metadata

- Started: 2026-07-13T18:54:02+05:30
- Duration: ~45 minutes
- Dry-run verified locally with real OpenRouter key before pushing
