# ADR 0002 — Three-tier precedence: direct > OpenRouter > CSV

**Status:** Accepted

## Context

Pricing data arrives from heterogeneous sources with differing authority.
Direct providers expose their own `/v1/models`; OpenRouter aggregates many
backends behind one API; some providers have no public API and need CSV/manual
entry. Without a precedence rule, the same model+provider could appear multiple
times with conflicting prices.

## Decision

Three tiers with strict precedence on the `canonicalId(m.id) | normalized_provider`
dedup key (`dedupKey()` in `scripts/lib.mjs`): **Tier 1 direct > Tier 2 OpenRouter
de-aggregated > Tier 3 CSV/hardcoded**. First-seen/highest-tier wins among
identical keys. Quantization IS part of the key — `canonicalId()` preserves
quant suffixes (`shared/normalize.mjs`), so different quants of the same
model+provider produce distinct keys and stay distinct rows
(`test/canonicalization.test.mjs:88-97`). Note: AGENTS.md previously stated
the opposite ("Quantization is NOT part of the dedup key") — that claim was
stale relative to the code and has been corrected; this ADR documents the code's actual behavior.

## Consequences

- **Enables:** one authoritative price per model+provider; direct-provider
  freshness wins over aggregator lag.
- **Costs:** OpenRouter-only providers (no direct endpoint) are Tier-2 forever;
  CSV providers need manual maintenance.
- **Forbids:** treating OpenRouter's aggregate `/v1/models` price as the row
  price — `/endpoints` per-backend de-aggregation is mandatory.
