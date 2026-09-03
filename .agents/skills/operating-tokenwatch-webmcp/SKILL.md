---
name: operating-tokenwatch-webmcp
description: "Operates and interprets TokenWatch's WebMCP tools across text, image, and video catalog pages. Use when an agent must choose tools, synchronize page state, interpret rankings, or explain returned pricing results."
---

# Operating TokenWatch WebMCP

Use this skill when working with the TokenWatch pricing calculators through
WebMCP. The page is the live source of truth: tools read and change the table
in the browser tab the human is watching. Do not maintain a static list of
models here; catalogs and prices are dynamic.

<!-- about-brief:start -->
## Operating rules

1. Discover the current page with `get_view` before interpreting results unless
   the immediately preceding tool returned a complete fresh view.
2. Treat `{provider, id}` as offering identity. Never use a displayed rank as
   an identifier; ranks change after sorting or filtering.
3. For a request that names a ranking, call `set_sort` first, then `get_view`.
   `set_sort` already returns a fresh view, but an explicit `get_view` is useful
   when the requested result limit differs from its default.
4. Call `explain_ranking` only after the intended text-page sort is active. It
   is read-only and never changes sorting.
5. After any state-changing tool, use its returned view (or call `get_view`)
   before describing the table. Never describe a stale ranking from memory.
6. If the user asks for full details of selected rows, call `get_model` with
   each row's `{provider, id}` after `get_view`.
7. Do not call a speed *filter*: TokenWatch exposes speed as a sortable text
   page column (`speed`), not as a filter.
8. Do not compare image megapixel, image, and token prices as though they were
   one unit. Preserve the billing unit and state the workload basis.

## Page capability map

| Page | Registered tools | Sortable fields |
|---|---|---|
| Text `/` | `about_tokenwatch` plus the 19 tools below | `org`, `provider`, `model`, `input`, `output`, `cache_read`, `context`, `speed`, `blended`, `cost` |
| Image `/image` | `about_tokenwatch`, `get_view`, `get_catalog_info`, `set_sort` | `org`, `model`, `cost_per_unit`, `cost` |
| Video `/video` | `about_tokenwatch`, `get_view`, `get_catalog_info`, `set_sort` | `org`, `model`, `resolution`, `audio`, `cost_per_second`, `cost` |
| Benchmarks `/benchmarks` | none currently | — |

### Deferred media workload controls

`set_workload` is currently a text-page tool only. It does not carry over to
the image or video tabs, whose calculators use separate workload dimensions:
image count and video duration (or their respective budget modes). Image and
video agents must use the values reported by their page's `get_view`; they
must not assume that a text token mix, cache setting, or text total-token
value applies to media. Dedicated media workload tools are intentionally
backburnered until their contracts are designed and implemented.
<!-- about-brief:end -->

Every `set_sort` accepts `dir: "asc"` or `dir: "desc"`. Text fields sort
alphabetically; numeric fields sort low-to-high or high-to-low. `rank` is a
derived display value and is never a valid sort field.

## Proactive workflows

### Ranked results

Translate natural language to a field and direction, then execute:

```text
set_sort({ by: <field>, dir: <asc|desc> })
get_view({ limit: <requested count> })
```

Use these defaults unless the user specifies otherwise:

| User intent | Sort |
|---|---|
| cheapest, lowest cost | `cost`, `asc` |
| most expensive, highest cost | `cost`, `desc` |
| fastest, highest throughput | `speed`, `desc` (text only) |
| slowest, lowest throughput | `speed`, `asc` (text only) |
| lowest/highest price or context | the corresponding numeric field, `asc`/`desc` |
| alphabetical by provider/model/org | the corresponding text field, `asc` unless reversed |

For “top N by X and explain” on text:

```text
set_sort({ by: X, dir: D })
get_view({ limit: N })
explain_ranking()
```

Explain the returned `why` text using the returned `sort`, `winner`, and
`runnerUp`. Do not substitute total cost for the active metric. For image and
video pages, explain the table from `get_view.top`; `explain_ranking` is not
registered there.

### Workload and filters (text)

For a workload request, use `set_workload` and/or `set_filters`, then report the
returned view. If the user changes the mix, budget, monthly mode, or filters,
rerun the ranking workflow rather than reusing old rows.

For a comparison request:

```text
get_view()
compare_models({ action: "set", models: [{ provider, id }, ...], open: true })
```

Use `highlight_tradeoff` when the user asks for a cheapest/fastest/ZDR tradeoff
comparison without naming specific rows.

## Shared result conventions

Tool results are serialized JSON. Parse the JSON before interpreting it. Errors
are normally returned as an object with an `error` string rather than thrown.
`set_sort` errors name the valid fields; retry only with a valid field and
direction. A successful write normally returns a fresh `get_view`-shaped
object.

`get_view` always reports the active `sort: { by, dir }`, the full matching
`rowCount`, and a ranked `top` preview. Its optional `limit` defaults to 10 and
is clamped to 1–25; `rowCount` can therefore be much larger than the number of
returned preview rows. `generated_at` is the catalog snapshot time, not the
time of the tool call. `shareUrl` preserves the current hash state.

## Text-page contracts

### `about_tokenwatch()`

Read-only. Returns `{ brief, skillUrl }`. `brief` is the marked slice of this
skill (operating rules + page capability map). `skillUrl` is `/skill.md`.
Chrome lists tools alphabetically, so this name sorts before `apply_preset`.
Call it before ranking or comparing. Other tools point here with one sentence.


### `get_view({ limit? })`

Returns:

```json
{
  "page": "text",
  "generated_at": "<catalog timestamp|null>",
  "workload": {
    "computeBy": "tokens|budget",
    "costMode": "perRequest|monthly",
    "totalTokensM": 0,
    "mix": ["input_percent", "cache_percent", "output_percent"],
    "budget": 0,
    "cacheWrite": 0,
    "amortizeN": 100
  },
  "filters": {
    "provider": "",
    "model": "",
    "zdr": false,
    "sub": false,
    "promo": false,
    "groupBy": "none|org|provider",
    "minIntelligence": 0
  },
  "sort": { "by": "cost", "dir": "asc" },
  "compare": [{ "provider": "<slug>", "id": "<id>" }],
  "rowCount": 0,
  "top": ["text row objects"],
  "shareUrl": "<current URL>"
}
```

Each text row contains `rank`, `provider`, `id`, `name`, `org`, `cost`,
`blended`, `zdr`, and `speedP50`. `cost` is the calculated workload cost (or
the inverse affordability value in budget mode); `blended` is the mix-weighted
comparison rate in $/M and is not the same thing as session `cost`.

### `get_model({ provider, id })`

Requires the exact identity from `get_view`. On success it returns:

```text
provider, id, name, org,
pricing, context_length, max_completion_tokens, quantization,
zdr, subscription, discount, benchmarks, energy,
cost, blended, speedP50
```

`pricing` contains the offering's component rates. `benchmarks` and `energy`
may be `null`; absence is not evidence that the model has no capability or
energy measurement. If the offering exists but is filtered out, the result
reports `inView: false` and tells the agent to call `get_view`,
`clear_filters`, or `set_filters`.

### `set_sort({ by, dir })`

Valid `by` values are:

```text
org, provider, model, input, output, cache_read,
context, speed, blended, cost
```

Returns the same shape as `get_view`, with the requested active sort. The
visible table and URL hash are updated too.

### `explain_ranking()`

Returns:

```text
metric,
sort: { by, dir, label },
mix, costMode, computeBy,
winner: <text row + rankingValue + rankingValueFormatted + components>,
runnerUp: <text row + rankingValue + rankingValueFormatted + components>,
why,
excludedForUnsupportedMix,
excludedSample,
warning?
```

`components` contains `input`, `output`, `cacheRead`, `cacheWrite`,
`sessionTotal`, `displayed`, and `modeMultiplier`. `why` is the concise human
explanation. `rankingValue` follows the active sort: it may be a cost, price,
context length, throughput, or alphabetical value. With fewer than two rows,
the tool returns an error.

### Text workload, filter, and catalog tools

- `list_presets()` → `{ presets: [{ name, totalTokensM, mix: { input, cache, output } }], note }`.
- `get_share_url()` → `{ shareUrl, note }`. It updates the current hash first.
- `get_catalog_info()` → `{ page, generated_at, catalogSize, providerCount, note }`.
- `set_workload({ totalTokensM?, mix?, costMode?, computeBy?, budget? })` → a fresh `get_view`; mix values must sum to 100 ±0.5 and are not silently normalized. It is a partial update: omitted workload fields, including existing `cacheWrite` and `amortizeN`, are preserved.
- `apply_preset({ name })` → a fresh `get_view`; valid names are `agentic`, `balanced`, `heavy-output`, and `no-cache`.
- `set_cache_write({ tokens?, amortizeN? })` → a fresh `get_view`; tokens are millions and `amortizeN` must be at least 1. Cache-write cost is included only when an offering has a numeric `pricing.cache_write`; `null` means the component is treated as $0, so the ranking may remain unchanged.
- `set_filters({ provider?, model?, zdr?, sub?, promo?, groupBy?, minIntelligence? })` → a fresh `get_view` with its default 10-row `top` preview; this resets the large-row display state. `groupBy` organizes the visible table into provider/org sections but does not change the active ranking or the global `top` preview; explain section placement separately from rank. The `model` filter is a case-insensitive substring match against the display name or the raw trailing id segment; runs of spaces and hyphens are the same separator (`glm-5.3-flash` matches `GLM 5.3 Flash`). It does not collapse glued tokens (`GLM-5.3Flash` will miss) and it does not collapse every backend of that model into one row — compare/open-detail still need exact `{provider, id}`.
- `clear_filters()` → a fresh `get_view`; workload and sort are kept.

### Text comparison, detail, and export tools

- `compare_models({ action, models?, open? })` → a fresh view, with optional `missing` and `note`. Actions are `add`, `remove`, `clear`, and `set`; models use `{ provider, id }`; the tray maximum is six. `open: true` opens the modal and requires at least two selected models.
- `open_detail({ provider, id })` → `{ ok, opened: { provider, id }, note }`; opens the detail modal for an offering in the current view.
- `highlight_tradeoff({ kinds? })` → a fresh view after selecting and opening cheapest, fastest, and/or `zdr_cheapest` rows. If omitted, all three kinds are attempted. It errors when those kinds collapse to fewer than two distinct `{provider, id}` rows (for example a ZDR-only view where cheapest, fastest, and ZDR-cheapest are the same offering). Retry after `clear_filters` or on a mixed catalog.
- `export_csv()` → `{ ok, filename, rowCount, triggeredDownload, note }`; the download can be blocked by an in-app browser.
- `snapshot_compare()` → `{ ok, filename, triggeredDownload, note }`, or an error if fewer than two models are selected or PNG capture fails.
- `download_cost_card({ provider, id })` → `{ ok, filename, triggeredDownload, note }`, or an error if the row is not in view. `triggeredDownload: true` means the page started a download click. Chrome may still show a multiple-file download permission prompt; the file is not on disk until that is allowed.
- `switch_catalog({ page })` → `{ ok, navigatingTo, note }`; valid pages are `text`, `image`, `video`, and `benchmarks`, and navigation leaves the current page.

## Translating tool results into human-readable explanations

Tool output is the evidence; the agent's response should explain what changed
and what the returned fields mean. Use the following output-to-response rules:

- `get_view`: state the page, row count, active sort and direction, active
  filters, workload basis, and requested top rows. Preserve every row in the
  returned `top` array unless the human explicitly asks for a shorter summary;
  do not silently reduce a multi-row result to only the winner. Mention
  `warning` when present. Do not call the top rows “cheapest” or “fastest”
  unless `sort.by` and `sort.dir` support that wording.
- `get_model`: identify the offering by provider and id, report component
  pricing and calculated `cost`, and separately report `blended`, speed,
  context, ZDR/subscription, benchmarks, energy, and optional-field absence.
- `set_sort`: say that the live table was reranked, name the exact field and
  direction, and summarize the returned top rows. It is a state change, not a
  filter operation.
- `explain_ranking`: report `metric`, `sort`, winner and runner-up values,
  `why`, cost components, unsupported-mix exclusions, and warnings. Preserve
  the distinction between the ranking value and displayed workload cost.
- `list_presets`: present the returned preset names and input/cache/output
  percentages; do not apply a preset unless the user asks.
- `get_share_url`: provide the returned URL and say that it encodes the current
  hash state; do not imply it is a snapshot of future catalog data.
- `get_catalog_info`: report `generated_at`, catalog size, and provider count;
  describe freshness only relative to that timestamp.
- `set_workload`, `apply_preset`, and `set_cache_write`: state the accepted
  workload change, then report the returned live ranking and its new basis.
  If validation returns `error`, explain what must be corrected and do not
  claim that the page changed.
- `set_filters` and `clear_filters`: list the filter changes, report the new
  row count and ranking, and say that workload is preserved unless the tool
  contract says otherwise.
- `compare_models` and `highlight_tradeoff`: identify selected rows by
  `{provider, id}`, describe modal/tray state, and call out `missing`,
  `notInView`, or any inability to find two distinct tradeoffs.
- `open_detail`: say which provider/id detail modal opened. `export_csv`,
  `snapshot_compare`, and `download_cost_card`: report filename, row/model
  scope, and `triggeredDownload`; include the returned note because an
  in-app browser may block downloads.
- `switch_catalog`: report the destination page and explain that the current
  page is being left; after navigation, rediscover the destination's tools.

For image and video views, always include the billing unit or duration beside
prices. For every tool, preserve explicit `null`/missing values and distinguish
an error response from a successful result containing zero rows.

## Image-page contracts

`get_catalog_info()` is also available on this page and returns
`{ page: "image", generated_at, catalogSize, providerCount, note }`. Its
`providerCount` is the number of distinct provider slugs represented in the
image catalog.

### `get_view({ limit? })`

Returns:

```json
{
  "page": "image",
  "generated_at": "<catalog timestamp|null>",
  "workload": {
    "computeBy": "tokens|budget",
    "imageCount": 100,
    "budget": 0,
    "basis": "total cost for image count|affordable images per $ budget"
  },
  "filters": { "provider": "", "model": "", "variant": "", "flatOnly": false },
  "sort": { "by": "cost", "dir": "asc" },
  "rowCount": 0,
  "top": ["image row objects"],
  "shareUrl": "<current URL>"
}
```

Each image row contains `rank`, `provider`, `id`, `name`, `org`, `unit`,
`variant`, `cost_per_unit`, and calculated `cost`. `cost` means total cost for
the selected image count in normal mode, or affordable image count for the
selected budget in budget mode. `cost_per_unit` follows the displayed unit;
keep `unit` beside it when reporting a price.

### `set_sort({ by, dir })`

Valid fields are `org`, `model`, `cost_per_unit`, and `cost`. It updates the
image table and returns a fresh image `get_view` snapshot. `unit` and `rank`
are display fields, not sortable fields.

## Video-page contracts

`get_catalog_info()` is also available on this page and returns
`{ page: "video", generated_at, catalogSize, providerCount, note }`. Its
`providerCount` is the number of distinct provider slugs represented in the
video catalog.

### `get_view({ limit? })`

Returns:

```json
{
  "page": "video",
  "generated_at": "<catalog timestamp|null>",
  "workload": {
    "computeBy": "tokens|budget",
    "videoSeconds": 60,
    "budget": 0,
    "basis": "total cost for video duration|affordable seconds per $ budget"
  },
  "filters": { "provider": "", "model": "", "resolution": "", "audio": "" },
  "sort": { "by": "cost", "dir": "asc" },
  "rowCount": 0,
  "top": ["video row objects"],
  "shareUrl": "<current URL>"
}
```

Each video row contains `rank`, `provider`, `id`, `name`, `org`, `resolution`,
`audio`, `cost_per_second`, and calculated `cost`. `audio` can be `true`,
`false`, or `null`; `null` means the SKU has no audio dimension and is not the
same as explicitly “without audio”. `cost` means total cost for the selected
duration, or affordable seconds for the selected budget.

### `set_sort({ by, dir })`

Valid fields are `org`, `model`, `resolution`, `audio`, `cost_per_second`, and
`cost`. It updates the video table and returns a fresh video `get_view`
snapshot.

## Reporting results to the human

When the user asks for ranked results, report the active sort explicitly, for
example: “Sorted by speed, descending (throughput).” Include the requested
rows in a table with the relevant raw values and calculated cost, preserving
units. For text rankings, include `blended` separately from `cost` when
available. For a winner explanation, state the winner, runner-up, active
metric, values, direction, and any exclusions or warnings.

Do not claim that a tool filtered by speed when it sorted by speed. Do not claim
that a missing optional field is zero. Do not invent freshness, provider
policies, benchmarks, or model rows; use the live result or state that the
field is unavailable.

## Keeping this skill current

When WebMCP schemas, page registration, or façade return shapes change, update
this file together with `public/webmcp.js`, the relevant page app, and the
contract tests. The live tool schema and current tool result take precedence
over an outdated prose example. Keep this skill focused on WebMCP operation;
do not add general repository or pricing-pipeline instructions here.
