# ADR 0004 — models.dev two-tier matcher: exact + bounded fuzzy

**Status:** Accepted

## Context

models.dev provides capability metadata (base_url, context_length, cache fields)
for ~40% of the catalog. Provider-native model IDs don't always match models.dev
IDs, so exact matching alone leaves coverage too low. Open-ended fuzzy matching
risks false matches across model families.

## Decision

Two-tier matcher in `shared/modelsdev.mjs`: **Tier A** exact normalized match
(confidence `high`); **Tier B** bounded-fuzzy subset match (confidence `medium`,
surfaces a ⚠ pill in the UI). Never overwrites existing values; per-provider
bespoke normalizers for Cloudflare, Amazon Bedrock, Fireworks, Minimax. (Source:
`docs/superpowers/plans/2026-07-09-modelsdev-enrichment.md`.)

## Consequences

- **Enables:** ~40% coverage with controlled false-positive risk.
- **Costs:** the bound is a calibrated tradeoff — loosening raises coverage but
  increases wrong-enrichment risk; tightening drops coverage.
- **Forbids:** open-ended fuzzy matching (would cross-match model families).
