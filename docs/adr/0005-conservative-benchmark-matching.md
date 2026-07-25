# ADR 0005 — Conservative benchmark variant matching

**Status:** Accepted

## Context

Artificial Analysis quality indices and OpenRouter `design_arena_best` Elo
attach to model variants. Aggressive suffix stripping over-matches benchmarks
across distinct variants (e.g. stripping `Qwen3-30B-A3B` to `qwen3` would
misattribute). Coverage: ~75% any benchmark, ~60% AA indices.

## Decision

Conservative matching in `shared/benchmarks.mjs`: `conservativeBase()` strips
only trailing quant (`-fp8`, `-nvfp4`, `-int4`) and SKU (`-turbo`, `-fast`,
`-highspeed`) suffixes; `baseKey()` additionally strips variant suffixes. AA
collision preference resolves two-indices-one-model. Scale calibrated max ~55.
(Source: `docs/superpowers/specs/2026-07-09-quality-benchmarks-design.md`
resolved-decisions table.)

## Consequences

- **Enables:** ~75% any / ~60% AA coverage without misattribution.
- **Costs:** variants that differ only by an un-stripped suffix get no benchmark.
- **Forbids:** stripping size tokens or version bits (would misattribute benchmarks).
