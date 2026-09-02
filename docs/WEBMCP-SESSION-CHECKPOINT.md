# TokenWatch WebMCP session checkpoint

**Created:** 2026-09-02
**Repository:** `WyrdWerk/tokenwatch`
**PR:** [#11](https://github.com/WyrdWerk/tokenwatch/pull/11)
**Purpose:** Resume the interactive WebMCP testing session in a later,
session-oriented Amp thread without re-discovering the project from scratch.

## What this work is

TokenWatch is a static pricing comparison site. WebMCP is an in-page MCP
surface: tools execute in the exact browser tab hosting the calculator and
operate the same UI state a human sees. It is not a separate headless API.

The project-specific operating contract is
[`.agents/skills/operating-tokenwatch-webmcp/SKILL.md`](../.agents/skills/operating-tokenwatch-webmcp/SKILL.md).
Keep that skill synchronized with `public/webmcp.js`, the three calculator
facades, and the contract tests. It documents tool contracts, result shapes,
result-surface behavior, and human-readable interpretation rules; it must not
contain a static model inventory.

## Repository and PR state

- PR worktree used for this session: `/tmp/tokenwatch-pr11-portal`
- The WebMCP/media extension, Singularity classification fix, skill, tests,
  docs, and this checkpoint belong in PR #11.
- The benchmarks page remains out of WebMCP scope.
- `open-webmcp-desktop.sh` is a local browser-launch helper tied to an
  ephemeral portal and should not be treated as portable project state.

## Implemented changes

### Catalog correction

- Singularity text parsing accepts only `/v1/chat/completions` and
  `/v1/responses` capabilities.
- Image-only entries (`flux-1-schnell`, `flux-pro-1.1`, `gpt-image-1.5`, and
  `gpt-image-2`) were removed from the text catalog and remain in the image
  catalog.
- Parser and regression tests cover this boundary.

### Text WebMCP

- The text page registers 19 tools after `pricing.json` and `TWCatalog` are
  ready.
- `get_view` returns the active `sort: { by, dir }`, full `rowCount`, and a
  ranked `top` preview. `top` defaults to 10 rows; `limit` supports 1–25.
- `set_sort` supports every text table field: `org`, `provider`, `model`,
  `input`, `output`, `cache_read`, `context`, `speed`, `blended`, and `cost`.
- `explain_ranking` follows the active sort field and direction instead of
  assuming cost.
- State-changing tools call the existing UI functions and return a fresh view.

### Image and video WebMCP

- Image and video pages load the shared registrar after their page app.
- Each registers exactly three tools: `get_view`, `get_catalog_info`, and
  `set_sort`.
- Image sorting: `org`, `model`, `cost_per_unit`, `cost`.
- Video sorting: `org`, `model`, `resolution`, `audio`, `cost_per_second`,
  `cost`.
- Image/video workload controls are intentionally backburnered. Text
  `set_workload` does not affect those tabs; image uses image count and video
  uses duration (or their budget modes).

### Skill and documentation

- The skill covers all registered tools, result shapes, interpretation rules,
  dynamic catalog behavior, grouping versus ranking, cache-write semantics,
  human-readable reporting, media billing units, and deferred media workload
  controls.
- The skill explicitly says not to silently reduce a returned multi-row
  `top` preview to one winner.
- `docs/WEBMCP.md` and the README describe text/image/video coverage.

## Live portal/Desktop setup

The last live session used:

- Portal: `https://t-03gsjxvuuty0unbtyk0jkfwb8-p25505.onamp.dev/`
- Visible Desktop Chrome session: `tokenwatch-webmcp-desktop`
- CDP port: `9222`
- Chrome WebMCP testing flag enabled.

Portal URLs and CDP sessions are ephemeral. A later session must verify that
the portal is still alive and rediscover tools with
`await document.modelContext.getTools()` rather than assuming this URL or
browser session still exists.

## Tools tested directly in the live browser

The counts below are **unique tool names/page registrations directly invoked
or verified live**, not merely covered by static contract tests.

### Text: 13 of 19 unique tools exercised

1. `get_view`
2. `get_model`
3. `set_sort`
4. `explain_ranking`
5. `list_presets`
6. `get_share_url`
7. `get_catalog_info`
8. `set_workload`
9. `apply_preset`
10. `set_cache_write`
11. `set_filters`
12. `clear_filters`
13. `compare_models`

Remaining text tools:

- `open_detail`
- `highlight_tradeoff`
- `export_csv`
- `snapshot_compare`
- `download_cost_card`
- `switch_catalog`

### Media: 4 of 6 page registrations exercised

- Image: `get_view`, `get_catalog_info` tested; `set_sort` remains.
- Video: `get_view`, `get_catalog_info` tested; `set_sort` remains.

Thus the current page-registration count is **17 of 25**: 13 text tools plus
four media registrations. There are 19 unique tool names overall because the
three media pages reuse the names `get_view`, `get_catalog_info`, and
`set_sort`.

Static schema/contract tests cover all 19 text registrations and the image and
video schemas, but static tests do not replace live browser verification.

## Exact stopping point

The last live tool was `set_filters` with:

- `model: "glm-5.3-flash"`
- `zdr: true`
- `totalTokensM: 1000`
- `costMode: "perRequest"`
- `computeBy: "tokens"`
- mix: **4.5% input / 95% cache-read / 0.5% output**
- active sort: `cost`, ascending
- matching offerings: **23**
- default preview: 10 rows

The previous cache-write state was still present because `set_workload` is a
partial update: **100M cache-write tokens amortized over 10 requests**. Do not
silently remove or assume this state; use `set_cache_write` explicitly if a
clean zero-cache-write scenario is required.

The stale comparison modal from an earlier `compare_models` test was closed,
so the filtered pricing table is visible in Desktop Chrome. Earlier comparison
selection may still be present in the tray; inspect `get_view.compare` or set
the comparison explicitly before the next comparison.

## User's pending request and exact next action

The user wants the first five matching GLM-5.3-Flash offerings ranked by
**blended cost ascending**, with the current ZDR and workload constraints, and
then a comparison table.

The next WebMCP tool is exactly:

```json
{
  "name": "set_sort",
  "arguments": { "by": "blended", "dir": "asc" }
}
```

Execute **one WebMCP tool per turn**. After `set_sort`, show every row in its
returned preview (the default is 10), report the active sort and 23-row
population, and stop. Do not immediately run `get_view` or `compare_models`.
After the user authorizes the next step, use the first five returned
`{provider, id}` identities for `compare_models` with `action: "set"` and
`open: true`. Do not identify rows by rank alone. Preserve all returned fields
and distinguish `blended` ($/M) from calculated session `cost`.

## Operating rules for the next session

1. Read this checkpoint and the linked prior Amp thread before acting.
2. Inspect the current checkout; conversation history does not transfer
   uncommitted files automatically.
3. Execute exactly one WebMCP tool, show its complete returned preview, and
   wait for the user's next instruction.
4. Keep the skill updated whenever schemas, result shapes, or interpretation
   behavior changes.
5. For UI changes, verify the visible Desktop/portal state, not only JSON.
6. Never call a speed filter: speed is a sortable text field.
7. Preserve explicit `null` values and report download/modal outcomes rather
   than assuming they succeeded.

## Copy/paste prompt for a new Amp session

Copy the following prompt into a new thread. Replace `THREAD_URL` with this
thread's URL if it is not already included automatically:

```text
Resume the TokenWatch WebMCP testing session from THREAD_URL. First read the
prior thread and the repository checkpoint at
docs/WEBMCP-SESSION-CHECKPOINT.md, then inspect the current checkout. Do not
assume that uncommitted files or the old browser/portal session transferred.

This is a session-wise, one-tool-at-a-time workflow. Execute exactly one
WebMCP tool per turn, show the complete returned result—including every row in
the returned top preview—then stop and wait for my instruction. Do not rush to
the next tool. Keep
.agents/skills/operating-tokenwatch-webmcp/SKILL.md synchronized with any
contract or interpretation discovery.

The project is WyrdWerk/tokenwatch, PR #11. The text page has 19 tools; image
and video each have get_view, get_catalog_info, and set_sort. The benchmarks
page is out of scope. WebMCP runs in the exact visible browser tab the human
is watching, not in a separate headless API. Rediscover the current portal and
browser tools instead of assuming an old ephemeral URL or CDP session.

Current pending user request: on the text page, compare the first five
matching offerings for model GLM 5.3 Flash with ZDR enabled, using 1,000M
session tokens and a mix of 4.5% input / 95% cache-read / 0.5% output. Rank by
blended cost ascending. The last known state already has the model and ZDR
filters and workload applied, but current browser state must be verified.

The exact next WebMCP action is:
set_sort({ by: "blended", dir: "asc" })

After that one tool, report all returned preview rows and wait. Only after I
authorize the next step should you use the first five returned {provider, id}
identities with compare_models(action="set", open=true). Never use rank as a
model identity, never silently summarize a multi-row result to one winner, and
distinguish blended $/M from calculated session cost.
```
