# ADR 0012 — Workload-aware model and provider recommendations

**Status:** Accepted

## Context

Recommendations compare models and providers despite mixed benchmark scales and missing metadata. Raw quality/price ratios favor cheap, weak models.

## Decision

Define nine workload presets for token mix, hard capability/context gates, benchmark/provider weights, and quantization. Convert each benchmark field to a percentile among eligible canonical models and average available weighted signals. Keep models with no use-case scores in an explicit unbenchmarked group. Choose best value from the non-dominated quality/cheapest-blended-price frontier by normalized distance to its ideal; choose cheapest above a configurable relative-quality floor. Gate providers before weighted price, TTFT p50, throughput p50, and uptime scoring. Preserve unknowns; prefer non-fp4/int4 for demanding tasks, but warn rather than reject unknown quantization.

## Consequences

Scores are relative, not absolute guarantees. Hard requirements fail closed; missing optional metrics are omitted and remaining weights renormalized.
