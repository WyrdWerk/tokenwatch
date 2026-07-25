# ADR 0006 — ZDR two-stage tagging

**Status:** Accepted

## Context

Zero-Data-Retention (ZDR) status must be tagged per model, but the signal comes
from two places with different granularity: an endpoint-level ZDR list
(`/api/v1/endpoints/zdr`, documented, no auth) and provider-level policy
(`retains_prompts === false`). Endpoint-level is more precise but incomplete;
provider-level is a fallback.

## Decision

Two-stage tagging in `main()`: **Stage 1** endpoint-level — `fetchZdrEndpoints()`
builds a Set of `dedupKey()` strings; matching models get `zdr: true`. **Stage 2**
provider-level fallback — models not tagged at endpoint level are checked against
`providers_meta[provider].retains_prompts === false` (from `MANUAL_PROVIDER_META`
or `/api/frontend/all-providers`). (Source: `AGENTS.md` §ZDR, lines 31-34.)

## Consequences

- **Enables:** ~65% of models ZDR-tagged with best-available granularity.
- **Costs:** provider-level fallback is coarser — a non-ZDR endpoint under a ZDR
  provider may be mis-tagged.
- **Forbids:** skipping Stage 1 (would lose endpoint precision) or treating
  provider-level as authoritative over endpoint-level.
