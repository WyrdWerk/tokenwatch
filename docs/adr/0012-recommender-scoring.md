# ADR 0012 — Workload-aware model and provider recommendations

**Status:** Accepted

## Context

Recommendations compare models and providers despite mixed benchmark scales and missing metadata. Raw quality/price ratios favor cheap, weak models.

## Decision

Define nine workload presets for token mix, hard capability/context gates, benchmark/provider weights, absolute quality floors, and quantization. Convert each benchmark field to a percentile among eligible canonical models and average available weighted signals. Keep models with no use-case scores in an explicit unbenchmarked group. Choose best value from the non-dominated quality/cheapest-blended-price frontier by normalized distance to its ideal; choose cheapest only when its raw primary benchmark meets the use-case's absolute floor. These floors are not catalog-relative and do not change the percentile-based best-quality or Pareto ordering.

Floors were chosen against the committed public catalogs on 2026-10-04, after open-weight and use-case capability/context filters. Counts are distinct canonical model families with a primary score; direct LiveBench coverage is sparse, so the table makes that limitation visible.

| Use case | Primary benchmark | Absolute floor | Current scored families | Current p25 / median |
|---|---|---:|---:|---:|
| agentic-coding | AA coding index | 25 | 67 | 20.7 / 43.4 |
| tool-agents | AA agentic index | 10 | 54 | 1.0 / 13.1 |
| long-context-rag | AA intelligence index | 15 | 74 | 11.2 / 19.5 |
| structured-extraction | LiveBench instruction following | 60 | 7 | 56.3 / 62.3 |
| high-volume-cheap | AA intelligence index | 10 | 75 | 11.1 / 19.5 |
| chat-assistant | AA intelligence index | 15 | 75 | 11.1 / 19.5 |
| creative-writing | LiveBench language | 70 | 7 | 70.1 / 76.2 |
| reasoning-math | LiveBench math | 80 | 7 | 79.6 / 79.9 |
| frontend-ui | Design Arena Elo | 1120 | 52 | 1120 / 1214 |

Cost remains USD per million tokens: use `shared/cost.mjs`'s `blendedRate()` unchanged. The agentic-coding regression fixture pins the recommender to `shared/model-summary.mjs`'s `rankOfferings()` at the same mix. A 1,000-token session amount is the per-million rate multiplied by 1,000/1,000,000; these are different labels/scales, not a factor to apply inside blended pricing.

Provider ranking first applies capability, minimum-context, requested ZDR/HQ/uptime, and known-issue gates. Confirmed providers are scored on available weighted blended price, TTFT p50, throughput p50, and uptime; missing required capability/context metadata goes to `unverified[]` with reasons and never enters the confirmed ranking. The result includes `ranked`, `unverified`, and a message when no provider is confirmed. Known-issue verdicts `broken` and `unavailable` block; `degraded` warns. Reasoning support is informational only for reasoning-math. Exclude `:batch` asynchronous variants except for high-volume-cheap or an explicit `includeBatch` option.

For demanding workloads, reject fp4/nvfp4/mxfp4/int4 offerings when a non-low-bit alternative qualifies. If all qualifying offerings are low-bit, allow them and put that fallback explicitly in `reasons[]`. Unknown quantization is never rejected, but remains an `unknowns[]` warning.

## Consequences

Weighted benchmark/provider scores remain relative, not absolute guarantees; only the primary quality floor is an absolute threshold. Missing optional metrics are omitted and remaining weights renormalized. Thin LiveBench sample counts can leave a use case without a `cheapestAboveFloor` pick; that is preferable to inventing or substituting an unrelated absolute benchmark score.
