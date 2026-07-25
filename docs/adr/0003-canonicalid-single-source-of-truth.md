# ADR 0003 — `canonicalId` as single source of truth

**Status:** Accepted

## Context

Model IDs arrive in many forms across providers (`anthropic/claude-sonnet-5`,
`zai-org/GLM-5.2`, `GLM-5.2` from Wafer). Cross-provider matching and dedup need
one canonical form. An earlier API-local `normalizeId` in
`functions/api/v1/[[route]].js` used a greedy `-preview-.*$` catch-all that
over-stripped `-preview-customtools`, collapsing
`google/gemini-3.1-pro-preview-customtools` onto `google/gemini-3.1-pro-preview`
— two distinct models became one in `/models/:id/providers`.

## Decision

Retire API-local `normalizeId`. `canonicalId()` and `orgLookupKey()` live in
`shared/normalize.mjs` — pure ESM, no `node:` imports — imported by both the Node
pipeline (via `scripts/lib.mjs`) and the Cloudflare Pages Function. Unknown
`-preview-<foo>` suffixes are preserved as distinct entries. (Source: `AGENTS.md`
§Canonical model ID, line 105; `shared/normalize.mjs` docstring.)

## Consequences

- **Enables:** one canonical form shared across pipeline and API; Worker-bundleable.
- **Costs:** the frontend re-implements it as `canonicalModelId` (ADR 0010) since
  it can't import the module.
- **Forbids:** re-introducing a second canonicalization implementation in the API
  or anywhere else — the `-preview-customtools` collision is the precedent.
