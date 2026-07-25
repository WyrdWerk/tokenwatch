# ADR 0001 — Zero-dependency constraint

**Status:** Proposed

## Context

TokenWatch's `package.json` declares zero runtime dependencies and uses only
Node built-ins (`node:test`, `fs`, `fetch`). CI runs `npm ci` with no install
phase beyond lockfile resolution. The constraint is *observable* in the repo,
but no source states the rationale for it.

## Decision

[Inferred] Ship with no npm runtime dependencies. All HTTP via global `fetch`,
all tests via `node:test`, all bundling avoided. `shared/normalize.mjs` is kept
pure (no `node:` imports) so it is Worker-bundleable and frontend-embeddable.

## Consequences

- **Enables:** fast CI (no install), no supply-chain surface, `shared/normalize.mjs`
  portable across Node pipeline and Cloudflare Worker.
- **Costs:** no remark/rehype or rich markdown ecosystem; the frontend cannot
  `import` ESM modules (no bundler), which forces the `canonicalModelId`
  duplication (ADR 0010).
- **Rationale unverified:** the *why* (supply-chain? speed? simplicity?) is not
  recorded in `AGENTS.md`, `README.md`, or the design specs. Promote to
  `Accepted` once the rationale is confirmed or recorded.
