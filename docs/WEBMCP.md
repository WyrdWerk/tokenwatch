# WebMCP on TokenWatch

Site tools for the [text calculator](https://tokenwatch.wyrdwerk.com) so a human and an agent can share the same table. WebMCP is an in-page MCP server: tools run in the page the visitor is looking at, not against a headless API.

**Existing project.** TokenWatch predates the [WebMCP Challenge](https://openai.com/webmcp-challenge/) (deadline 3 Sep 2026, 1:00 PM PT). This document is the evidence trail of the WebMCP extension.

| What | Commit |
|---|---|
| Baseline (calculator + pipelines, no WebMCP) | `1c5b8dcca9349a93e15971a7930b7f421e9e283e` (2026-09-01 performance refresh on `main`) |
| MIT `LICENSE` (GitHub-detectable; `package.json` already said MIT) | `docs: add MIT LICENSE` |
| `window.TWCatalog` façade on the text calculator | `feat: expose TWCatalog façade on text calculator` |
| `public/webmcp.js` tool registration | `feat: register WebMCP tools on text page` |

Image, video, and benchmarks pages are **out of this drop**. They do not load `webmcp.js`. A later `TWCatalog` on those pages can reuse the same registrar.

## How it works

1. `public/app.js` loads `pricing.json`. On success it assigns `window.TWCatalog` and dispatches `tw-catalog-ready`. On failure it never becomes ready — tools are not registered against an empty table.
2. `public/webmcp.js` (loaded after `app.js`) feature-detects `document.modelContext`, waits up to 15s for the façade, registers the text-page tools, and aborts the `AbortController` on `pagehide`.
3. Write tools call existing UI functions (`setCostMode`, `applyPreset`, `computeAndRender`, …) and return a fresh `get_view` snapshot so the agent cannot describe a stale ranking.
4. Row identity is `{ provider, id }`, never a DOM rank (`ROW_CAP = 250` would otherwise lie).

Without WebMCP support the site is unchanged (progressive enhancement).

## Tool catalog (text page)

Starred tools are the contest-demo minimum.

| Group | Tool | Side effect |
|---|---|---|
| See | `get_view` ★ | none (read) |
| See | `get_model` | none (read) |
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

Chrome: enable the WebMCP testing flag, open the text page, DevTools → `await document.modelContext.getTools()`. You should see the 18 names above.

ChatGPT: desktop app, Settings → Browser → Permissions, open the live URL, Site tools in the address bar. Luna has WebMCP disabled; Enterprise/Edu are excluded.

## What we did not add

- Fake mouse tools (`click_row`, `sort_column`)
- Advisor-as-a-tool (the floating widget stays for humans; ignore it in the demo)
- Image/video/benchmarks tools (no CSV/detail on those calculators; clock)
- Declarative `<form toolname>` (this is a SPA)
- Cross-origin iframe companions (ChatGPT in-app support undocumented)
- Headless / unattended agent flows

## Deploy note

`webmcp.js` is in `scripts/bust-cache.mjs` `FINGERPRINT`. After deploy, the hashed `/h/webmcp.<hash>.js` URL must return `application/javascript`, not `text/html`.
