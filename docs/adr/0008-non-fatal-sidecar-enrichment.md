# ADR 0008 — Non-fatal sidecar enrichment

**Status:** Accepted

## Context

After the 3-tier fetch + dedup, four enrichments run: models.dev, Artificial
Analysis benchmarks, ZDR tagging, and performance data. These sources have
independent uptime and rate limits. If any one failing blocked the deploy, the
2-hourly refresh would stall on transient outages and the catalog would go stale.

## Decision

All sidecar enrichments are **non-fatal**: a failure logs and skips; the pipeline
writes what it has and ships. The core 3-tier fetch + dedup is the only
deploy-blocking stage. (Source: `AGENTS.md` §Resilience, lines 115-123.)

## Consequences

- **Enables:** the 2-hourly cadence is robust to enrichment-source outages;
  partial enrichment is always better than no refresh.
- **Costs:** enrichment coverage fluctuates run-to-run (e.g. models.dev down →
  ~40% drops for that cycle). Coverage-floor tests (`test/parity.test.mjs`)
  catch regressions but tolerate the known ceiling.
- **Forbids:** making an enrichment deploy-blocking without a fallback.
