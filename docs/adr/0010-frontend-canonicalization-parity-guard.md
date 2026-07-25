# ADR 0010 — Frontend canonicalization parity guard

**Status:** Accepted

## Context

The static frontend (`public/app.js`) needs canonical model IDs for the datalist
typeahead. `shared/normalize.mjs` is pure ESM with no `node:` imports, but the
frontend has no bundler (zero-dependency constraint, ADR 0001), so it cannot
`import` the module without a build step. A prior API-local `normalizeId` was
retired after the `-preview-customtools` collision (ADR 0003) — a second copy of
canonicalization is precisely what broke before. [The no-bundler → duplication
chain is inferred from ADR 0001; the guard itself is verifiable fact.]

## Decision

Accept a *guarded* duplication: `public/app.js` re-implements `canonicalId()` as
`canonicalModelId()`. `shared/normalize.mjs` remains the single source of truth.
An automated parity guard exists at `test/parity.test.mjs:56-89`.

## Guard mechanism and limits

The guard works by **vendoring a verbatim copy** of `public/app.js`'s
`canonicalModelId` as an inline function `appCanonicalId` (test lines 57-70) and
asserting it equals `canonicalId()` (imported from `shared/normalize.mjs`) over a
**fixed 12-input case list** (test lines 71-84). It does **not** import or execute
`public/app.js`.

Two limits:

1. **No execution of `public/app.js`.** The test compares a *copy* against the
   shared module. If someone edits the live `public/app.js`'s `canonicalModelId`
   in a way that diverges from the test's embedded copy, the test still passes —
   CI sees only the embedded copy, not the live file.
2. **Fixed case list.** A rule that diverges only on an input *outside* the 12
   cases passes parity while drifting in production.

## Consequences

- **Enables:** zero-bundler static frontend (preserves ADR 0001) with a real, if
  bounded, drift alarm.
- **Costs — three-way sync, not two:** changing `canonicalId` requires updating
  `shared/normalize.mjs`, `public/app.js`, **and** the verbatim copy embedded at
  `test/parity.test.mjs:57-70` in the same commit. Updating only the first two
  leaves the test asserting against a stale reference. Updating the test's copy
  without updating `public/app.js` makes the test green while the live frontend
  drifts — the most dangerous failure mode, since CI reports success.
- **Forbids:** treating `public/app.js`'s copy, or the test's embedded copy, as
  authoritative — both are mirrors; `shared/normalize.mjs` is the source.
- **Documented limitation, not a proposal:** strengthening the guard (importing
  `public/app.js` dynamically, or expanding the corpus) is a code change, out of
  scope here; recorded so a future agent knows the boundary of existing protection.
