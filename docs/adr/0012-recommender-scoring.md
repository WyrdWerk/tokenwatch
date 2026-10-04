# ADR 0012 — Workload-aware model and provider recommendations

**Status:** Accepted

## Context

Recommendations compare models and providers despite mixed benchmark scales and missing metadata. Raw quality/price ratios favor cheap, weak models.

## Decision

Define nine workload presets for token mix, hard capability/context gates, benchmark/provider weights, absolute quality floors, and quantization. Convert each benchmark field to a percentile among eligible canonical models, average the available weighted signals, then shrink that composite toward the eligible cohort median by the fraction of benchmark weight missing. A benchmark coverage of at least 50% is required for `bestQuality` and `bestValue`; scored models below that threshold remain visible in `partiallyBenchmarked`, and models with no scores remain in `unbenchmarked`. Choose best value from the non-dominated quality/cheapest-blended-price frontier by normalized distance to its ideal; do not rank by a score/price ratio. `cheapestAboveFloor` chooses the cheapest provider-gated, priced model whose primary benchmark reaches its use case's absolute floor, and calls out when it costs more than `bestValue`.

Floors were chosen against the committed public catalogs on 2026-10-04, after open-weight resolution, capability/context gates, and the use-case price gate. Counts are distinct canonical model families with a primary score; percentiles are descriptive snapshots, not the floor-setting rule. For structured extraction, creative writing, and reasoning/math, use AA intelligence as the floor metric because direct LiveBench coverage is thin (about seven models); the task-relevant LiveBench categories still contribute supplementary weight to composite quality. The committed pricing snapshot predates the top-level recommender fields, so these counts use per-offering models.dev open-weight metadata where available; a refreshed snapshot can change them.

| Use case | Primary benchmark | Absolute floor | Current scored families | Current p25 / median |
|---|---|---:|---:|---:|
| agentic-coding | AA coding index | 25 | 56 | 22.8 / 45.5 |
| tool-agents | AA agentic index | 10 | 44 | 1.2 / 17.2 |
| long-context-rag | AA intelligence index | 15 | 64 | 11.2 / 21.2 |
| structured-extraction | AA intelligence index | 15 | 59 | 11.8 / 22.2 |
| high-volume-cheap | AA intelligence index | 10 | 73 | 11.1 / 20.9 |
| chat-assistant | AA intelligence index | 15 | 65 | 11.1 / 20.9 |
| creative-writing | AA intelligence index | 15 | 65 | 11.1 / 20.9 |
| reasoning-math | AA intelligence index | 15 | 65 | 11.1 / 20.9 |
| frontend-ui | Design Arena Elo | 1120 | 44 | 1151 / 1222 |

Cost remains USD per million tokens: use `shared/cost.mjs`'s `blendedRate()` unchanged. The agentic-coding regression fixture pins the recommender to `shared/model-summary.mjs`'s `rankOfferings()` at the same mix. A 1,000-token session amount is the per-million rate multiplied by 1,000/1,000,000; these are different labels/scales, not a factor to apply inside blended pricing.

Provider ranking first applies capability, minimum-context, requested ZDR/HQ/uptime, and known-issue gates, then requires a price for the use-case mix. A present `supported_parameters` array is authoritative: omission of `tools` or structured-output parameters means unsupported; models.dev flags are consulted only when that field is absent or null. Confirmed, priced providers are scored on available weighted blended price, TTFT p50, throughput p50, and uptime; missing required capability/context metadata goes to `unverified[]` with reasons and never enters the confirmed ranking. Shortlist provider recommendations and prices use this same gated provider ranking. Subscription offerings are excluded from shortlist prices unless explicitly requested, but remain labelled in direct provider results. The result includes `ranked`, `unverified`, and a message when no provider is confirmed. Known-issue verdicts `broken` and `unavailable` block; `degraded` warns. Reasoning support is informational only for reasoning-math. Exclude `:batch` asynchronous variants except for high-volume-cheap or an explicit `includeBatch` option.

OpenRouter's `uptime_30m` (percentage points) is preferred to `uptime_1d`, also in percentage points; a value such as `0.99` means 0.99%, not 99%. Reasons name the selected window. TTFT reasons name the telemetry source and measurement window when available; OpenRouter endpoint p50s are last-30-minute measurements, while supplemental data should carry its source/window.

For demanding workloads, reject fp4/nvfp4/mxfp4/int4 offerings when a non-low-bit alternative qualifies. If all qualifying offerings are low-bit, allow them and put that fallback explicitly in `reasons[]`. Unknown quantization is never rejected, but remains an `unknowns[]` warning.

## Consequences

Weighted benchmark/provider scores remain relative, not absolute guarantees; only the primary quality floor is an absolute threshold. Missing optional provider metrics are omitted and remaining weights renormalized. Benchmark scores with thin coverage are visibly shrunk and excluded from `bestQuality`/`bestValue`; the lower coverage does not make the model disappear from the shortlist. Low-bit quantization is applied after capability, constraint, and price gates per canonical model; only if no non-low-bit provider remains is the fallback allowed and explained.
