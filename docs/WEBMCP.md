# WebMCP on TokenWatch

Site tools for the text, image, and video calculators so a human and an agent can share the same table. WebMCP is an in-page MCP server: tools run in the page the visitor is looking at, not against a headless API.

**Existing project.** TokenWatch predates the [WebMCP Challenge](https://openai.com/webmcp-challenge/) (deadline 3 Sep 2026, 1:00 PM PT). This document is the evidence trail of the WebMCP extension.

The agent operating contract is [`.agents/skills/operating-tokenwatch-webmcp/SKILL.md`](../.agents/skills/operating-tokenwatch-webmcp/SKILL.md). Keep it synchronized with the live WebMCP schemas and façade contracts; it documents result shapes and interpretation rules, not static model rows.

| What | Commit |
|---|---|
| Baseline (calculator + pipelines, no WebMCP) | `1c5b8dcca9349a93e15971a7930b7f421e9e283e` (2026-09-01 performance refresh on `main`) |
| MIT `LICENSE` (GitHub-detectable; `package.json` already said MIT) | `docs: add MIT LICENSE` |
| `window.TWCatalog` façade on the text calculator | `feat: expose TWCatalog façade on text calculator` |
| `public/webmcp.js` tool registration | `feat: register WebMCP tools on text page` |

The image and video pages now load the same registrar and expose page-specific `get_view` and `set_sort` tools. Their sort schemas exactly match their visible table columns. The benchmarks page remains out of scope.

## How it works

1. Each calculator loads its catalog. On success it assigns `window.TWCatalog` and dispatches `tw-catalog-ready`. On failure it never becomes ready — tools are not registered against an empty table.
2. `public/webmcp.js` (loaded after the page app) feature-detects `document.modelContext`, waits up to 15s for the façade, registers the page's tool set, and aborts the `AbortController` on `pagehide`.
3. Write tools call existing UI functions (`setCostMode`, `applyPreset`, `computeAndRender`, …) and return a fresh `get_view` snapshot so the agent cannot describe a stale ranking.
4. `get_view.top` and `explain_ranking` follow the table's active sort, returned as `sort: { by, dir }`. The default is total/session cost ascending (`by: "cost", dir: "asc"`); the human can change it with the table controls. `explain_ranking` uses that same metric rather than assuming cost. Row identity is `{ provider, id }`, never a DOM rank (`ROW_CAP = 250` would otherwise lie).

Without WebMCP support the site is unchanged (progressive enhancement).

## Media-page tool catalog

Image and video pages intentionally expose a smaller, page-specific set while their facades mature:

| Page | Tool | Sortable columns |
|---|---|---|
| Image | `get_view` | — |
| Image | `get_catalog_info` | — |
| Image | `set_sort` | `org`, `model`, `cost_per_unit`, `cost` |
| Video | `get_view` | — |
| Video | `get_catalog_info` | — |
| Video | `set_sort` | `org`, `model`, `resolution`, `audio`, `cost_per_second`, `cost` |

`set_sort` accepts `asc` and `desc` for every listed column and returns a fresh `get_view` snapshot. The `cost` field is the page's active calculated value: total cost in token/count mode or affordable units in budget mode.

## Tool catalog (text page)

Starred tools are the contest-demo minimum.

| Group | Tool | Side effect |
|---|---|---|
| See | `get_view` ★ | none (read) |
| See | `get_model` | none (read) |
| Sort | `set_sort` | re-renders the table |
| See | `explain_ranking` ★ | none (read) |
| See | `list_presets` | none (read) |
| See | `get_share_url` ★ | none (read; returns current hash URL) |
| See | `get_catalog_info` | none (read) |
| Workload | `set_workload` ★ | re-renders the table |
| Workload | `apply_preset` | re-renders the table |
| Workload | `set_cache_write` | re-renders the table |
| Filters | `set_filters` ★ | re-renders the table |
| Filters | `clear_filters` | re-renders the table (workload kept) |
| Decide | `compare_models` ★ | updates tray; optional modal |
| Decide | `open_detail` | opens detail modal |
| Decide | `highlight_tradeoff` | fills tray + opens modal |
| Leave | `export_csv` | triggers file download |
| Leave | `snapshot_compare` | PNG download of compare card |
| Leave | `download_cost_card` | PNG download of one cost card |
| Move | `switch_catalog` | navigates to `/`, `/image`, `/video`, or `/benchmarks` |

Downloads may be blocked inside ChatGPT's in-app browser. Tool results still report `triggeredDownload` + filename; `get_share_url` is the portable artifact.

## Demo walkthrough ("Priya")

Priya runs a ~40-person SaaS support bot, ~20M tokens/month, cache-heavy, needs ZDR.

1. Open https://tokenwatch.wyrdwerk.com in ChatGPT's in-app browser (GPT-5.6 Sol/Terra) or Chrome 149+ with `chrome://flags/#enable-webmcp-testing`.
2. Confirm **Site tools** in the address bar.
3. Prompt: *Support bot, ~20M tokens/month, mostly cache, ZDR only, monthly. Cheapest three and why the winner wins.*
4. Expected tool sequence: `set_workload` → `set_filters` → `get_view` → `compare_models` → `explain_ranking` → `get_share_url`.
5. She can grab the mouse ("cache is more like 80%") — the next `set_workload` moves the same table.
6. She leaves with the hash URL (works in any browser).

## Local testing

```bash
npm test                 # includes webmcp-schema + twcatalog-contract (no browser)
npm run serve            # public/ on :3000
```

Chrome: enable the WebMCP testing flag, open a catalog page, and run `await document.modelContext.getTools()` in DevTools. The text page exposes 19 tools; image and video expose `get_view`, `get_catalog_info`, and `set_sort`. Use `set_sort` to change any visible sortable column programmatically; `get_view` reports the resulting sort.

ChatGPT: desktop app, Settings → Browser → Permissions, open the live URL, Site tools in the address bar. Luna has WebMCP disabled; Enterprise/Edu are excluded.

## What we did not add

- Fake mouse tools (`click_row`, `sort_column`)
- Advisor-as-a-tool (the floating widget stays for humans; ignore it in the demo)
- Benchmarks tools (no WebMCP facade on that page yet)
- Declarative `<form toolname>` (this is a SPA)
- Cross-origin iframe companions (ChatGPT in-app support undocumented)
- Headless / unattended agent flows

## Deploy note

`webmcp.js` is in `scripts/bust-cache.mjs` `FINGERPRINT`. After deploy, the hashed `/h/webmcp.<hash>.js` URL must return `application/javascript`, not `text/html`.
