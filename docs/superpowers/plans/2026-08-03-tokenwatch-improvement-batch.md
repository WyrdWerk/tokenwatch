# TokenWatch Improvement Batch — 2026-08-03

Evidence-backed improvement batch, reviewed by a Mixture-of-Agents pass
(3 reviewers: correctness/security, architecture/maintainability, ops/CI).
Status: **implemented** (all CS-1..CS-7 edits applied; suite green).

## Change sets

| CS | Scope | Key files |
|----|-------|-----------|
| CS-1 | API hardening: `decodeURIComponent` 400-guards on `/images/:id` + `/videos/:id` (was uncaught URIError → 500), pagination clamp (limit∈[1,500], offset≥0 — negative values silently returned wrong slices) | `functions/api/v1/[[route]].js`, `test/api.test.mjs` |
| CS-2 | CI overhaul: skip-write-when-unchanged in fetchers (`maybeWriteJson` in lib.mjs), deploy gates on `changed`/`inputs.force` (was 12 unconditional deploys/day), same gate on refresh-aa, `generate-seo` runs in every deploy, SEO integrity guard, `/h/*` content-type smoke after deploy, `timeout-minutes: 60`, dead PR branch removed | `scripts/lib.mjs`, 3 fetchers, 3 workflows |
| CS-3 | SEO correctness: shared `blendedRate` (cache_read null → input fallback; the old `generate-seo` dropped the 97% cached leg → null-cache models ranked ~97% too cheap), live model/provider counts via `{{modelCount}}`/`{{providerCount}}` placeholders, `id="cheapest"` + `id="faq"` anchors, main-guard + atomic writes, parity tests vs app.js `blendedCostFor` | `shared/cost.mjs`, `scripts/generate-seo.mjs`, `public/index.html`, `test/generate-seo.test.mjs` |
| CS-4 | Frontend: Rank `<th>` no longer `data-sort="cost"` (duplicate sort header on image/video) | `public/image.html`, `public/video.html` |
| CS-5 | Pipeline cleanup: false quant-in-dedup header comment, dead `parseUmans()`, unused `num` import, quantization fill from ID suffix (shared `QUANT_SUFFIX_RE` + `quantFromId`), reverse-map unify | `shared/normalize.mjs`, `scripts/fetch-pricing.mjs`, `scripts/lib.mjs`, `scripts/fetch-modelsdev.mjs`, `test/canonicalization.test.mjs` |
| CS-6 | Docs: AGENTS.md counts/citations/API surface/workflows/secrets/files-to-know; ADR + edge-cases citations converted to function names | `AGENTS.md`, `docs/adr/*`, `docs/canonicalization-edge-cases.md` |
| CS-7 | Hygiene: `.gitignore` investigation artifacts + `public/h/` do-NOT-ignore guard comment | `.gitignore` |

## Key derived decisions (from MOA)

- **Do NOT commit SEO files** (regenerated every deploy; committed tree stays the
  4-JSON commit convention). Deployed SEO ≡ f(committed `pricing.json`) in both
  job paths, so drift is impossible by construction. Guarded by CI integrity grep.
- **`inputs.force`** is the recovery lever for the gated-deploy failed-deploy gap:
  a commit+push that fails at deploy would otherwise stay stale until the next
  data change.
- **Quant fill runs after dedup, before org enrichment** — cannot change dedup
  outcomes (dedup key reads the ID string); never overwrites OpenRouter quants.
- **app.js stays a mirrored classic script** — no bundler can serve all surfaces;
  the parity suite (`test/generate-seo.test.mjs`) pins `blendedRate` to the
  frontend copy instead.

## Verification

- `npm test`: full suite green (20 files / 249+ tests; CS-1 adds 5 API tests,
  CS-3 adds 9 SEO tests, CS-5 adds 5 quant tests, CS-2 adds 2 write-if-changed tests).
- `npm run seo` run twice: idempotent, counts substituted (994 models / 81 providers),
  anchors present, no leftover placeholders.
- YAML for all four workflows parses.

## Deferred / out of scope

- tokenwatch-cli plan (explicitly excluded by user).
- P3.3 runtime change (exclude unpriceable cache legs) — all four price surfaces
  already agree; pinned by parity tests instead.
- SVG `og:image` → PNG (zero-dep constraint; verify real-world scraper behavior first).