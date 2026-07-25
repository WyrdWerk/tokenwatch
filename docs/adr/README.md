# Architecture Decision Records

Settled design choices for TokenWatch. Each ADR is ≤150 words: Context → Decision
→ Consequences. Numbers are permanent once assigned; superseded ADRs are marked
`Superseded by ADR 00NN`.

| ADR | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-zero-dependency-constraint.md) | Zero-dependency constraint | Proposed | No npm runtime deps; `node:test`; no `npm install` in CI. |
| [0002](0002-three-tier-precedence.md) | Three-tier precedence: direct > OpenRouter > CSV | Accepted | Direct providers authoritative; OpenRouter de-aggregated fallback; CSV/hardcoded last resort. |
| [0003](0003-canonicalid-single-source-of-truth.md) | `canonicalId` as single source of truth | Accepted | Pure `shared/normalize.mjs` imported by pipeline + Worker; retired API-local `normalizeId` after `-preview-customtools` collision. |
| [0004](0004-modelsdev-bounded-fuzzy-matching.md) | models.dev two-tier matcher: exact + bounded fuzzy | Accepted | Exact (Tier A) first; bounded-fuzzy (Tier B) fallback; never overwrites existing values. |
| [0005](0005-conservative-benchmark-matching.md) | Conservative benchmark variant matching | Accepted | Strip only quant + SKU; AA collision preference; coverage ~75% any / ~60% AA. |
| [0006](0006-zdr-two-stage-tagging.md) | ZDR two-stage tagging | Accepted | Endpoint-level first, provider-level fallback (`retains_prompts === false`). |
| [0007](0007-fal-ai-tier1-merge.md) | fal.ai Tier-1 precedence merge | Accepted | fal.ai authoritative for image/video; `falCanonicalId` preserves modality; non-fatal fetch. |
| [0008](0008-non-fatal-sidecar-enrichment.md) | Non-fatal sidecar enrichment | Accepted | Enrichments never block deploy; pipeline writes what it has. |
| [0009](0009-two-hour-cron-cadence.md) | Two-hour cron cadence | Proposed | Fetch → commit → deploy every 2h; rationale inferred, not stated in source. |
| [0010](0010-frontend-canonicalization-parity-guard.md) | Frontend canonicalization parity guard | Accepted | `public/app.js` `canonicalModelId` mirrors `canonicalId`; guarded by `test/parity.test.mjs` with documented limits. |
