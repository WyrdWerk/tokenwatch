# TokenWatch — models.dev Enrichment Layer (Public Conversation Record)

**Date**: 2026-07-09
**Repo**: [WyrdWerk/tokenwatch](https://github.com/WyrdWerk/tokenwatch)
**Live site**: https://tokenwatch.wyrdwerk.com
**Commits**: `2119940`..`657596e` on `main` (17 commits, 2 feature-branch merges)

> This is a sanitized, publicly-shareable record of the full working session. It covers the feasibility analysis, design, implementation, and deployment of a models.dev enrichment layer for TokenWatch. No sensitive information is included.

---

## What TokenWatch is

[TokenWatch](https://tokenwatch.wyrdwerk.com) is a zero-dependency, pure-Node-ESM static site that compares pay-as-you-go LLM inference pricing across ~75 providers, plus separate image (34 models) and video (13 models) generation catalogs. Deployed to Cloudflare Pages with daily CI/CD refresh. The core innovation: OpenRouter's `/endpoints` API is de-aggregated so each backend (Fireworks, Together, Novita, SiliconFlow…) becomes its own row with its own pricing, rather than one generic "OpenRouter" row.

The pipeline has three tiers: (1) direct provider fetches (DeepInfra, Crof, EmberCloud, Wafer, Synthetic, Lilac, SambaNova), (2) OpenRouter de-aggregation, (3) CSV/hardcoded (Hyper, Makora, Xiaomimimo, OpenCode Go). Precedence is direct > OpenRouter > CSV. All prices normalized to USD per million tokens.

---

## Phase 0: The question — can models.dev replace OpenRouter?

[models.dev](https://models.dev) is a community-maintained, open-source database of AI model specifications, pricing, and capabilities, exposed via a single unauthenticated JSON endpoint (`https://models.dev/api.json`). It covers 152 providers and 5,379 models, and is used internally by [opencode](https://opencode.ai).

The session began with a targeted question: **could models.dev serve as a primary pricing source, potentially replacing OpenRouter?** This would require (a) comparable model coverage, (b) per-provider pricing at the same granularity as OpenRouter's de-aggregated `/endpoints`, and (c) a way to reconcile models.dev's native model ID format with OpenRouter's `org/model` convention.

### Deep data analysis

The full `api.json` (3MB) was fetched and compared against TokenWatch's real `pricing.json` (920 text models, 75 providers). Key findings:

| Metric | Finding |
|---|---|
| **Model coverage** | 97.3% of TokenWatch's catalog exists on models.dev under *some* provider. Only 25 models are truly absent — and most of those are explainable artifacts (DeepInfra `-Turbo` variants, `syn:large:text` routing aliases, quant-suffixed CSV entries). |
| **Provider coverage** | 48 of TokenWatch's 75 providers have a corresponding entry on models.dev. The other 27 are OpenRouter-exclusive backends (Hyper, Makora, EmberCloud, and 24 smaller ones). |
| **Same-provider model match** | Only 340/920 (37%) — limited not by provider absence but by **model ID format mismatch** (see below). |
| **Cache pricing availability** | models.dev carries `cost.cache_read` (2,250 models) and `cost.cache_write` (756 models) at the per-(provider, model) granularity — exactly what TokenWatch needs. |
| **DeepInfra gap** | models.dev lists DeepInfra as a provider but carries **zero model records** — a provider shell entry. Unfixable from TokenWatch's side. |

### The model ID format problem

The decisive discovery: models.dev uses each provider's **native model ID convention**, which differs radically from OpenRouter's `org/model` convention:

| Provider | OpenRouter / TokenWatch format | models.dev format |
|---|---|---|
| Fireworks | `deepseek/deepseek-v4-flash` | `accounts/fireworks/models/deepseek-v4-flash` |
| Amazon Bedrock | `amazon/nova-lite-v1` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| Cloudflare | `moonshotai/kimi-k2.7-code` | `@cf/moonshotai/kimi-k2.7-code` |
| Minimax | `minimax/minimax-m2.5` | `MiniMax-M2.5-highspeed` |

These refer to the same underlying models, but reconciling them requires **per-provider ID normalization functions** — one regex/transform per provider that converts between conventions.

### The verdict

**models.dev cannot replace OpenRouter** — full replacement would lose 63% of the catalog (DeepInfra's 112 models, plus 26 OR-exclusive providers). But models.dev **can** serve as a powerful **sidecar enrichment source**: it carries three things OpenRouter doesn't — provider base URLs, native model IDs, and capability metadata (reasoning, tool call, modalities, knowledge cutoff). The session pivoted to designing exactly that.

---

## Phase 1: Designing the enrichment layer

A structured brainstorm produced a five-section design, each reviewed and approved before moving on.

### Architecture decision: sidecar, not a 4th tier

models.dev runs *after* the existing 3-tier fetch + dedup, decorating rows produced by Tier 1/2/3. It does not compete in dedup precedence. The key contract: **never overwrite** — models.dev only fills `null` values in existing fields. Existing pricing, context length, and cache fields are never replaced. If both sources have a value and they disagree, the TokenWatch value (from the live provider API or OpenRouter endpoints) wins, and the disagreement is logged.

```
EXISTING (unchanged):  Tier 1/2/3 → dedupModels → tieredModels (920 rows)
NEW SIDECAR:           fetch models.dev/api.json → index by (provider, normalizedId)
                       → applyEnrichment (never-overwrite) → pricing.json with modelsdev block
```

### Per-provider ID normalizers

Five distinct ID-format patterns were identified across providers, handled by a normalizer registry:

| Pattern | Providers | Example transform |
|---|---|---|
| Org-prefix only (`canonicalId` handles it) | ~28 of 48 matched providers | `moonshotai/kimi-k2.7-code` ↔ `kimi-k2.7-code` |
| Vendor path prefix | Cloudflare | `@cf/moonshotai/kimi-k2.7-code` → strip `^@cf/` |
| Dot-separated namespacing | Amazon Bedrock | `global.anthropic.claude-haiku-4-5-v1:0` → strip region + `:N` + `-vN` |
| Brand prefix duplicated | Minimax | `MiniMax-M2.5-highspeed` → strip `MiniMax-` brand |
| Deep namespacing + version encoding | Fireworks | `accounts/fireworks/routers/kimi-k2p6-turbo` → strip prefix + `p`→`.` |

A critical design rule: **SKU preservation**. Suffixes like `-turbo`, `-fast`, `-highspeed`, `-nvfp4` represent genuine pricing/throughput differences and must be preserved as distinct entries. The Fireworks normalizer only strips the path prefix and decodes version punctuation (`k2p6` → `k2.6`); it never touches the SKU suffix.

### Two-tier matcher

The matcher tries an exact normalized match first, then falls back to a bounded fuzzy match:

- **Tier A (exact normalized, confidence `'high'`)**: both IDs pass through the same `normalizeForMatch()` function; if the outputs are equal, it's a match.
- **Tier B (bounded fuzzy, confidence `'medium'`)**: if no exact match, try a constrained fuzzy search against *only the same provider's* models. The constraints:
  - **Same-provider only** — structural: a Fireworks row only fuzzy-matches against `fireworks-ai` models on models.dev, never borrows from another provider. This prevents surfacing a wrong base URL.
  - **2-token floor** — refuse to fuzzy-match if either side has fewer than 2 tokens (prevents `o3` matching `o3-mini`).
  - **Directional subset** — the needle's (TokenWatch's) token set must be a strict subset of the candidate's (models.dev's). Captures the intended case (`kimi-k2.7-code` → `kimi-k2.7-code-fast`) but rejects the wrong-direction case (`o4-mini-high` → `o4-mini`). *(The directional constraint was added during the final review — the original design used symmetric subset, which produced wrong-SKU matches.)*
  - **Single-candidate requirement** — if the fuzzy match produces more than one candidate, refuse. Ambiguity means no match.

### Enrichment schema

A new optional `modelsdev` block on each model object, present only when enrichment succeeds:

```json
{
  "modelsdev": {
    "base_url": "https://api.fireworks.ai/inference/v1",
    "model_id": "accounts/fireworks/routers/kimi-k2p7-code-fast",
    "doc_url": "https://docs.fireworks.ai/quickstarts",
    "confidence": "high",
    "source": "models.dev",
    "release_date": "2026-06-12",
    "knowledge_cutoff": "2025-01",
    "description": "Coding-focused Kimi model, stronger on long-horizon repo work",
    "capabilities": { "reasoning": true, "tool_call": true, "structured_output": true, "attachment": true, "temperature": true },
    "modalities": { "input": ["text", "image"], "output": ["text"] },
    "open_weights": true
  }
}
```

The cache fields (`cost.cache_read`, `cost.cache_write`) and context limits (`limit.context`, `limit.output`) are **not** in this block — they're merged into the existing `pricing` and top-level fields via the never-overwrite rule, so existing API consumers and cost-computation code don't need to know whether a value came from OpenRouter or models.dev.

### Frontend card UX

A new **detail modal** opens when any model row is clicked, displaying the enrichment data alongside the existing pricing. Design decisions:

- **Whole row clickable** (event delegation on `<tbody>`, compare checkbox isolated via a `.closest('.compare-check')` guard).
- **Four conditional sections**: Connect (base URL + model ID + docs, with copy-to-clipboard), Pricing (always shown, from existing fields), Capabilities (badges + modalities, only if enrichment exists), About (description + release date + knowledge cutoff, only if enrichment exists).
- **⚠ approx pill** on Tier B (medium-confidence) matches, with hover text explaining the match was fuzzy and should be verified before configuring.
- **Escape-to-close** for both the detail modal and the existing compare modal (the latter was a pre-existing accessibility gap, fixed as a bonus).
- **Text-tab only at launch** — image and video tabs unchanged (models.dev has no image/video pricing).
- **Accessibility**: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on both modals.

The design was written to a spec document (`docs/superpowers/specs/2026-07-09-modelsdev-enrichment-design.md`, 404 lines) and reviewed.

---

## Phase 2: Implementation plan

An 11-task implementation plan was written (`docs/superpowers/plans/2026-07-09-modelsdev-enrichment.md`, 1,691 lines), TDD-shaped (test-first, verify failure, implement, verify pass, commit) with exact code in every step:

1. Provider map + default normalizer
2. Four bespoke normalizers (Cloudflare, Amazon Bedrock, Fireworks, Minimax)
3. Two-tier matcher (exact + bounded fuzzy)
4. Enrichment merge logic (never-overwrite)
5. Re-export public API from `scripts/lib.mjs`
6. models.dev fixture + fetcher script
7. Wire enrichment into `fetch-pricing.mjs`
8. Fetch live data + parity regression tests
9. Frontend detail modal markup + CSS
10. Frontend detail modal logic + row click + Escape + clipboard
11. Final verification + docs update

---

## Phase 3: Subagent-driven implementation

The 11 tasks were executed via subagent-driven development: a fresh implementer subagent per task, followed by a task-reviewer subagent checking spec compliance and code quality, with the controller (this session) coordinating and adjudicating.

### Brief bugs caught during implementation

Three of the eleven tasks had bugs in the plan's own verbatim code, caught by implementers and confirmed by reviewers:

- **Amazon Bedrock normalizer** (Task 2): the plan's code didn't strip the `-v1` version suffix that follows the date stamp, so `canonicalId`'s date-strip regex never fired. The implementer added `.replace(/-v\d+$/, '')`, documented inline. Verified necessary by tracing the test input through both code paths.
- **Fuzzy tokenizer** (Task 3): the plan's `split(/[./\-_]/)` would have failed the plan's own "refuses on non-subset" test — splitting on `.` makes `gpt-5` (`[gpt, 5]`) a spurious subset of `gpt-5.5` (`[gpt, 5, 5]`). The implementer dropped `.` from the delimiter class so version numbers (`5.5`, `k2.7`) stay single tokens. Verified by tracing both tokenizers against the test cases.
- **Pipeline import** (Task 7): the plan said to import `applyEnrichment` from the fetcher module, but it's actually exported from `shared/modelsdev.mjs` (re-exported via `lib.mjs`). The implementer split the imports correctly.

### Frontend bugs caught in Task 10

The detail modal logic task surfaced three integration issues:

- The plan accessed `state.currentRows[idx]` directly, but row objects are `{ model, cost }` — the model is nested under `.model`. The existing compare-checkbox handler uses `state.currentRows?.[idx]?.model`; the implementer matched that pattern.
- The plan's group-collapse replacement would have broken the existing collapse behavior (which hides child rows via `style.display`, not just a CSS class). The implementer preserved the original logic.
- The `<tr>` elements didn't have `data-idx` attributes (only the inner checkbox did), so the delegation selector `tr[data-idx]` matched nothing. The implementer added the attribute to the row.

### Parity floor adjustment

The plan projected 60-76% enrichment coverage. The real measured yield was **42%** (385/920), because the projection didn't account for structural absences: DeepInfra has 0 models on models.dev (112 TokenWatch models), and ~26 smaller OpenRouter-exclusive providers are absent entirely. The parity regression test floor was lowered from 60% to 35% — still catches a catastrophic normalizer regression, without failing on known-unfixable absences.

A second data reality surfaced: 141 of 385 enriched models legitimately have `base_url: null` because models.dev's `api` field is optional for providers that use their own SDK packages (Anthropic `@ai-sdk/anthropic`, Google, Azure, etc.). The parity test was relaxed to accept `null` OR a valid `https://` URL.

### Final whole-branch review

After all 11 tasks, a final code review (on the most capable model) caught two more issues:

1. **Cloudflare templated base URLs**: 11 Cloudflare-enriched models carried `base_url: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1"` with a literal `${CLOUDFLARE_ACCOUNT_ID}` placeholder. A user pasting that into an SDK config would get a broken URL. Fix: the fetcher now sets `base_url` to `null` when the `api` field contains a template variable.
2. **Tier B wrong-direction SKU matches**: 19 of 54 Tier B matches were TokenWatch-suffixed models (`o4-mini-high`, `gpt-3.5-turbo-16k`) matching models.dev base models — surfacing the wrong model ID. Fix: the fuzzy matcher was tightened to directional subset (needle ⊂ candidate only), dropping Tier B from 54 to 35 matches.

---

## Phase 4: User feedback and the model-level fallback

After local testing on `localhost:3000`, five issues were flagged and fixed:

### Fix 1: Decimal precision

Many prices displayed 10+ decimal places (`0.030000000000000002`, `0.024999999999999998`) — IEEE 754 floating-point artifacts from arithmetic, not real extra precision. A `round3()` helper was added to the frontend display layer (`fmtPrice`, `fmtCost`, and the detail-card pricing cells), rounding to 3 decimals. The raw `pricing.json` keeps full float precision, which is needed for accurate cost computation on large token volumes.

### Fix 2: Removed the "Open in OpenRouter" link

The detail card's footer had an "Open in OpenRouter ↗" link, but `encodeURIComponent` encoded the `/` in model IDs as `%2F`, producing URLs like `https://openrouter.ai/model/deepseek%2Fdeepseek-v4-flash`. OpenRouter's server returns HTTP 200 for that encoded form (a SPA catch-all), but renders nothing real. The correct URL pattern isn't reliably automatable for 919 models, so the link was removed entirely rather than ship something broken.

### Fix 3: Docs links open in the same tab

The docs links used `target="_blank"`, which popup blockers on `localhost` were silently eating. Removed `target="_blank"` so the links navigate in the same tab. On the production HTTPS site, cmd-click/ctrl-click still works for a new tab.

### Fix 4: Model-level fallback (the big one)

For models hosted on providers with no models.dev match (e.g., DeepSeek V4 Flash on Hyper), the detail card was nearly empty — just "Direct configuration not available." This affected 10+ providers hosting the same popular models.

The fix: a **second enrichment index**, keyed by canonical model ID (ignoring provider). When a provider-specific match doesn't exist, the pipeline attaches a `modelsdev_model` block carrying model-level metadata (description, capabilities, modalities, knowledge cutoff) from *any* provider hosting the same model. The block never carries `base_url` or `model_id` — those are provider-specific and can't be safely borrowed.

The frontend renders the fallback metadata with a clear yellow disclaimer:

> ⚠ Model details sourced from models.dev (different provider). Configuration above is not available for this provider — verify on the provider's site.

**Coverage impact**: enrichment jumped from 366 provider-specific matches to 741 total (366 + 375 model-level fallback) — **81% of the catalog**, up from 40%. DeepInfra's unmatched count dropped from 112 to 34 (its models now get metadata from other providers hosting them).

### Fix 5: "No base URL" explanation

When a provider like OpenAI has `base_url: null` (because they use the `@ai-sdk/openai` package rather than a generic OpenAI-compatible endpoint), the card now shows "Provider uses its own SDK package — no generic base URL" instead of a bare dash.

### Cache pricing verification

Before deploying, the cache_write count increase was verified to be legitimate:
- 99 cache_write values non-null (up from 65 pre-models.dev)
- +34 filled by models.dev provider-specific matches
- **0 disagreements** (the never-overwrite rule held — every models.dev value either matched or filled a null)
- 22 `cache_write: 0` values correctly treated as real (Z.AI's "free cache write"), distinct from `null`

---

## Phase 5: Deployment

The branch was merged to `main` locally, verified on `localhost:3000`, then pushed. The push hit a conflict with the daily cron's pricing.json refresh; a rebase resolved it (taking the enriched version), and the push succeeded.

The push triggered the Cloudflare Pages deploy job in `.github/workflows/refresh-pricing.yml`:
1. **`test`** job: `npm test` — 94/94 passing (was 61 baseline, +33 new)
2. **`deploy`** job: `bust-cache` (rewrites `?v=` tokens to fresh content hashes) → deploy to Cloudflare Pages

Total push-to-live time: ~4-5 minutes (most of which was GitHub Actions queue latency).

The live site was verified serving:
- `detailModal` markup in the HTML
- Fresh cache-bust tokens: `app.js?v=1e314529`, `styles.css?v=fc2bf220`
- All new functions present in the live `app.js` (`showDetailModal`, `round3`, `mdModel`, `detail-disclaimer`)
- 741/919 text models enriched in the live `pricing.json` (366 provider-specific + 375 model-level fallback)

---

## What shipped

### New files

| File | Purpose |
|---|---|
| `shared/modelsdev.mjs` | Pure reconciliation module: 48-entry provider map, 4 per-provider ID normalizers (Cloudflare, Amazon Bedrock, Fireworks, Minimax), two-tier matcher (exact + bounded fuzzy), never-overwrite `applyEnrichment` with model-level fallback. No `node:` imports (Cloudflare Worker bundling constraint). |
| `scripts/fetch-modelsdev.mjs` | Sidecar fetcher: pulls `https://models.dev/api.json` (single call, non-fatal on failure), builds the enrichment index. |
| `test/modelsdev-normalizers.test.mjs` | 30 unit tests for the provider map, normalizers, and matcher, including SKU-preservation regression guards. |
| `test/modelsdev-enrichment.test.mjs` | 10 integration tests for the merge rule and model-level fallback. |
| `test/fixtures/modelsdev-api.json` | Miniature models.dev API fixture (5 providers, 6 models) covering all 5 normalizer patterns. |
| `docs/superpowers/specs/2026-07-09-modelsdev-enrichment-design.md` | 404-line design spec. |
| `docs/superpowers/plans/2026-07-09-modelsdev-enrichment.md` | 1,691-line, 11-task implementation plan. |

### Modified files

- `scripts/lib.mjs` — re-exports the models.dev public API.
- `scripts/fetch-pricing.mjs` — calls the fetcher + `applyEnrichment` after subscription tagging; logs Tier A/B counts, disagreements, and unmatched-by-provider breakdown.
- `public/app.js` — `showDetailModal()`, row-click delegation, Escape handler, copy-to-clipboard, `round3()` decimal helper, model-level fallback rendering, ⚠ pill.
- `public/index.html` — detail modal markup with accessibility attributes.
- `public/styles.css` — detail modal styles, `.approx-badge`, `.copy-btn`, `.detail-disclaimer`, `.detail-no-url`, row hover affordance.
- `test/parity.test.mjs` — 3 regression guards (coverage floor, confidence values, no template variables in base URLs).
- `AGENTS.md`, `TODO.md` — documentation updated.

### Final state

- **94/94 tests passing** (was 61, +33 new)
- **741/919 text models enriched** (81%): 366 provider-specific + 375 model-level fallback
- **99 cache_write values** (up from 65), all verified legitimate
- **Zero new runtime dependencies** (project hard constraint maintained)
- **Live at** https://tokenwatch.wyrdwerk.com

---

## Known accepted limitations

1. **DeepInfra (34 models still unmatched)** — models.dev lists DeepInfra as a provider but carries zero model records. Unfixable from TokenWatch's side; would require upstream contribution to models.dev.
2. **~35 Tier B fuzzy matches have quant-suffix noise** (e.g., `glm-5.2` matching `GLM-5.2-FP8`) — mitigated by the ⚠ approx pill. The directional subset fix eliminated wrong-direction matches; quant-suffix collisions are a harder problem accepted as a design tradeoff.
3. **Image/video tabs unchanged** — models.dev has no image/video pricing; the detail card is text-tab only at launch. The card structure is reusable if a future source covers those catalogs.
4. **CSS class name typo** (`detail-modalality-line`, should be `detail-modality-line`) — preserved consistently across CSS and JS; cosmetic only.
5. **Focus management not implemented** — the design spec mentioned focusing the ✕ button on open and restoring focus on close; this was deferred as a minor accessibility gap.

---

## Lessons

### Run live-data yield checks before setting thresholds

The plan projected 60-76% enrichment coverage based on provider-overlap optimism. The real yield was 42%, limited by structural absences (DeepInfra, OR-exclusive providers) that the projection didn't account for. A parity floor set at 60% would have failed immediately. Always measure against real data before committing to thresholds.

### Bounded fuzzy matchers must be directional

A symmetric subset rule (either side can be the subset) produces wrong-direction SKU matches: `o4-mini-high` matches `o4-mini` because `[o4, mini]` ⊂ `[o4, mini, high]`. The fix is a directional rule: the needle (the thing being searched) must be the subset of the candidate (the thing being searched against). This captures the intended case (`kimi-k2.7-code` → `kimi-k2.7-code-fast`) while rejecting the wrong case.

### `encodeURIComponent` breaks URL paths

`encodeURIComponent('deepseek/deepseek-v4-flash')` produces `deepseek%2Fdeepseek-v4-flash` — the `/` is encoded as `%2F`. For URL paths that contain slashes, either encode segments individually or verify the target route actually resolves the encoded form.

### IEEE 754 float noise belongs at the display layer

Values like `0.030000000000000002` are floating-point arithmetic artifacts, not real precision. Round them at the display layer (a `round3()` helper); keep full precision in the data layer, which is needed for accurate cost computation on large token volumes (1M tokens × a 0.0005 rounding error = $0.50 drift).

### When a plan's prose and its tests contradict, trust the tests

The plan's tokenizer regex (`split(/[./\-_]/)`) would have failed the plan's own "refuses on non-subset" test. When the verbatim code and the test intent conflict, resolve in favor of the test and the underlying safety intent, and document the deviation inline so it isn't "corrected" back.

### Subagent-driven development catches brief bugs

Three of eleven tasks had errors in the plan's own verbatim code, caught by implementer subagents and confirmed by reviewer subagents. A fresh-context implementer reading the brief literally is an effective check on the plan author's assumptions.
