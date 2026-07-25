# ADR 0009 — Two-hour cron cadence

**Status:** Proposed

## Context

`.github/workflows/refresh-pricing.yml` runs a 2-hourly cron: fetch → commit →
deploy, plus a push-to-main deploy-only trigger. The cadence is *observable* in
the workflow file, but no source states the rationale for 2h versus 1h or 4h.

## Decision

[Inferred] Refresh every 2 hours. Balances catalog freshness against provider
API rate limits (OpenRouter `/endpoints` is ~317 calls per refresh) and commit
noise in the repo. (Source: `.github/workflows/refresh-pricing.yml` — cadence
factual; rationale inferred.)

## Consequences

- **Enables:** prices stay within ~2h of provider changes; ~12 deploys/day.
- **Costs:** short-lived provider outages (<2h) can miss a refresh window; commit
  history is dominated by automated fetch commits.
- **Rationale unverified:** the tradeoff against 1h/4h is not recorded. Promote
  to `Accepted` once the rationale is confirmed or recorded.
