# TokenWatch CLI — Design Spec

- **Status:** Draft (pending user review)
- **Date:** 2026-07-30
- **Scope:** This spec covers the headless CLI package (`tokenwatch`) only. The optional interactive TUI package (`tokenwatch-tui`) is described at contract level and gets its own spec before implementation.

---

## 1. Overview

A zero-dependency terminal CLI for TokenWatch that makes the same pricing data and cost math the website offers available to two audiences:

1. **Humans** — fast, readable tables in the terminal.
2. **Coding agents** — stable, machine-readable output driven headlessly with no TTY.

The CLI is a **separate package**, decoupled from this site repo. It consumes TokenWatch's **published JSON snapshots** as its primary data source, with the `/api/v1` HTTP API available as an override. The site repo itself is not modified by this work.

### Two-package split

- **`tokenwatch`** — the core CLI. Pure Node/TypeScript, zero runtime dependencies. Installs with nothing native in its tree. This is what agents and servers install.
- **`tokenwatch-tui`** (future, out of scope here) — optional interactive UI built on OpenTUI. Declares `@opentui/*` as real dependencies and imports the `tokenwatch` core for types/query/cost. Never bundled into a headless install.

The split is a packaging guarantee, not a lazy-import trick: headless machines never download a byte of native TUI code.

---

## 2. Goals & Non-Goals

### Goals

- One-command install from GitHub (`npm i -g github:WyrdWerk/tokenwatch-cli`).
- Works headlessly with zero interactive prompts when stdout is not a TTY.
- Fetches data **once** at first invocation, caches locally, and answers all subsequent queries against the local cache with **no further network calls** until the cache is stale.
- Every command exposes a stable `--json` / `--jsonl` output mode.
- Cost and normalization math in the CLI is **identical** to the website and API (same formulas, ported from the same source).

### Non-Goals (v1)

- The interactive TUI (separate spec, separate package).
- Live streaming / server-sent pricing updates.
- Writing data, mutating the site, or authenticated endpoints.
- Windows-native packaging beyond what stock Node provides.

---

## 3. Data Source — Evidence-Backed

The CLI's primary source is the **published snapshot** TokenWatch already serves, not a new endpoint.

### 3.1 Why the snapshot (not the API) is the default

**Evidence:** the site is a static catalog refreshed by CI. `.github/workflows/refresh-pricing.yml` runs on cron `'0 */2 * * *'` (verified on disk) — data does not change more often than every 2 hours. The website itself loads `pricing.json` client-side; using the same asset means the CLI is **definitionally as fresh as the website**.

The `/api/v1/models` route **paginates** (`functions/api/v1/[[route]].js:42-46`, verified): `limit = Math.min(parseInt(limit) || 100, 500)` — default 100, hard cap 500, paged response. A full ~940-model text catalog therefore cannot be loaded in one API call (it would take ≥2 pages). Fetching the snapshot asset directly is one request and avoids coupling the CLI to pagination behavior.

> **Proposed design choice (not a repo fact):** use the snapshot as the pragmatic bulk bootstrap via `--data-url` (accepts `http(s)://`, `file://`, or a local path). The `/api/v1` HTTP API is also supported via `--api-url` (paginated adapter in `core/api.js`, `limit=500`, follows `offset` until `total`). `--data-url` is the default; `--api-url` is the explicit live-API override.

### 3.2 Snapshot data contract (verified shapes)

`public/pricing.json` top-level keys (verified, `pricing.json:1-3`): `generated_at` (ISO 8601 string), `providers`, `models`, `providers_meta`.

- `providers[]`: `{ key, name, model_count, status }` (verified).
- `providers_meta[<slug>]`: policy fields including `privacy_policy_url`, `terms_of_service_url`, `status_page_url`, `headquarters`, `datacenters`, `retains_prompts`, `may_train`, `retention_days`, `source` (verified on `hyper` and `lilac` entries).
- `models[]`: field set **per AGENTS.md** — `id`, `org`, `provider`, `pricing{ input, output, cache_read, cache_write }` (USD per million tokens), `context_length`, `max_completion_tokens`, `quantization`, `zdr`, `subscription`, `discount`, `uptime_30m`, plus optional enrichment blocks (`modelsdev`, `benchmarks`, `energy`).
  - **Deferred verification:** exact per-record field names and nullability to be confirmed against a real model record at implementation time. AGENTS.md is the current authority; treat it as the contract until field-verified.

`public/image-pricing.json` and `public/video-pricing.json` share the `{ generated_at, models }` top level (verified). Image records carry a `pricing[]` array with `{ unit, variant, cost_per_unit, cost_per_million }`; video records carry per-second resolution/audio variants.

### 3.3 API override contract (verified)

All routes and filters from `functions/api/v1/[[route]].js` (verified):

- `GET /api/v1/` — directory info
- `GET /api/v1/stats` — summary counts
- `GET /api/v1/orgs` — `{ org, count }[]`
- `GET /api/v1/providers[?zdr=true]` — provider metadata
- `GET /api/v1/models` — filters: `org, provider, min_context, min_output, quantization, cache_read, cache_write, promo, zdr, sub, search, sort, order, limit, offset`
- `GET /api/v1/models/:id/providers[?tokens=N&mix=in,cr,out]` — mix-aware cost sort
- `GET /api/v1/images`, `/api/v1/images/:id`, `/api/v1/videos`, `/api/v1/videos/:id`
- CORS: `Access-Control-Allow-Origin: *` (verified, `[[route]].js:19-23`).
- **Note:** the `json()` helper does **not** set `Cache-Control: no-store` (verified — `CORS_HEADERS` has no Cache-Control entry). The CLI must therefore treat any API response as potentially edge-cached and append a cache-buster when freshness matters, or prefer the snapshot asset which carries `generated_at`.

---

## 4. Architecture

```
tokenwatch-cli/
  src/
    core/
      types.ts        # mirror of snapshot + API shapes
      cache.ts        # fetch snapshot, write/read cache dir, TTL
      query.ts        # filter / sort / search over models[] (pure)
      cost.ts         # port of costFor() + blendedCostFor() (pure)
      normalize.ts    # port of canonicalId() + orgLookupKey() (pure)
      format.ts       # table + plain + json renderers (pure)
    cli/
      index.ts        # arg parsing, TTY detection, dispatch
      commands/       # models, providers, stats, images, videos, refresh
  package.json        # zero deps, type: module
  README.md
```

**Invariants:**

- `core/*` is **pure** (no `process.stdout`, no network, no TTY). Unit-testable, and shared with the future TUI package.
- All network access is confined to `core/cache.ts`. The future TUI imports `core` only — it never fetches.
- Output formatting is chosen by `cli`, never by `core`.

### Layering rule (load-bearing)

> The CLI, the `--json` agent mode, and the future TUI all share **one** `core` (query / cost / normalize / format). A bug fix in cost math fixes all three surfaces.

---

## 5. Commands

| Command | Purpose | Mirrors |
|---|---|---|
| `tokenwatch models [--org --provider --zdr --promo --sub --search --sort --order --limit]` | List/filter text models | `/api/v1/models` |
| `tokenwatch providers <model> [--tokens N --mix 70,20,10]` | Per-provider cost comparison for one model | `/api/v1/models/:id/providers` |
| `tokenwatch stats` | Catalog summary | `/api/v1/stats` |
| `tokenwatch images` / `tokenwatch videos` | Image/video catalogs | `/api/v1/images`, `/videos` |
| `tokenwatch refresh` | Force re-fetch of snapshots | (CLI-local) |
| `tokenwatch tui` | Launch interactive UI (v2) — prints install hint if `tokenwatch-tui` not on PATH | spawns `tokenwatch-tui --data <cached>` |

Global flags: `--json`, `--jsonl`, `--no-color` (also honors `NO_COLOR`), `--data-url`, `--api-url`, `--ttl <minutes>`, `--cache-root`, `--help`.

---

## 6. Caching & Freshness

```
~/.cache/tokenwatch/
  pricing.json              # text snapshot
  pricing.json.meta.json    # { generatedAt, fetchedAt, dataUrl } for text
  image-pricing.json        # fetched lazily on first image query
  image-pricing.json.meta.json
  video-pricing.json        # fetched lazily on first video query
  video-pricing.json.meta.json
```

Per-snapshot metadata (not a single shared `meta.json`) so each catalog has an independent TTL and data URL.

**Behavior:**

- On any command, the CLI checks the cache for the relevant snapshot.
- If missing or older than `--ttl` (default **120 minutes**, matching the CI cadence), it re-fetches before running.
- `generated_at` (from the snapshot) records upstream data age; `fetchedAt` (local) records when the CLI last checked. Both are surfaced in `--json` output and a status line.
- `tokenwatch refresh` bypasses TTL and re-fetches.
- All subsequent filter/search/cost computation runs **locally** against the cached `models[]` — zero additional network calls within the cache window.

> **Proposed:** default TTL = 120 min to match the 2-hourly CI cron (evidence: `refresh-pricing.yml` schedule). This is a tunable, not a hard contract.

---

## 7. Agent / Headless Behavior

**Evidence-grounded conventions** (established industry patterns — to be re-verified against each cited tool's docs during implementation; marked [PATTERN] where not freshly sourced):

- **TTY auto-detection:** when `process.stdout.isTTY` is false, default to non-interactive: no prompts, `--json` unless overridden, no spinners.
- **`--json` everywhere:** every command supports it; output is stable, versioned JSON to stdout.
- **stderr vs stdout:** progress/logs → stderr; data → stdout only. Safe to pipe.
- **Exit codes:** `0` success, `1` generic error, `2` bad usage, `3` network/cache error, `4` no results.
- **`NO_COLOR` / `--no-color`:** respected unconditionally. [PATTERN]
- **No interactive prompts in non-TTY mode.** Any prompt requiring input errors out with a message instead of hanging.

---

## 8. Cost & Normalization Math (to port)

Ported verbatim from the website so numbers match. **Evidence:** formulas verified on disk.

### 8.1 `costFor(pricing, tokens)` — `public/app.js` (~L934-953)

```
c(price, tok) = price != null ? (price * tok) / 1e6 : null
total = c(input, inputTok) + c(output, outputTok)
      + c(cache_read ?? input, cacheReadTok)
      + c(cache_write, cacheWriteTok)      // cache_write null → treated as $0
```

Returns `null` only if input is requested and priced null (or output likewise). Mix-aware monthly mode multiplies by `modeMultiplier` at the call site, **not** inside `costFor`.

### 8.2 `blendedCostFor(pricing, tokens)` — `public/app.js` (~L954-974)

Pure comparison metric: mix-weighted $/M, **excluding** cache_write and monthly multiplier.

```
inRate  = (inputPct/100)  * input
outRate = (outputPct/100) * output
crPrice = cache_read != null ? cache_read : input
crRate  = (cacheReadPct/100) * crPrice
blended = inRate + outRate + crRate
```

### 8.3 Canonicalization — `shared/normalize.mjs`

Port `canonicalId(id)` (L48-70) and `orgLookupKey(id)` (L71-77) unchanged. Key behaviors: strip provider prefix (keep segment after `/`), strip `:free` / `:thinking`, lowercase, strip date suffixes (`-YYYY-MM-DD`, `-YYMMDD`, `-YYYYMMDD`) and `-preview[-date]` suffixes, strip bare `-preview`, **preserve** unknown `-preview-<foo>` (e.g. `-preview-customtools`), **preserve** quantization suffixes (`-fp8`, `-nvfp4`, `-int4`, …). `orgLookupKey` additionally strips quant/tier suffixes for coarse org matching only.

> The module is already pure ESM with zero `node:` imports (bundled into the Worker today) — direct reuse is viable; the CLI will vendor a copy to stay zero-dependency rather than depend on the site repo.

---

## 9. Distribution

**Proposed order:**

1. **GitHub install (v1):** `npm i -g github:WyrdWerk/tokenwatch-cli`. Zero infra. Caveat: a `prepare` script or committed `dist/` is required so the install produces a runnable binary; the zero-dep core makes this trivial.
2. **Compiled binaries (later):** `bun build --compile` per-platform binaries attached to GitHub Releases + a curl `install.sh`. No runtime needed on the user machine.
3. **npm publish (later):** once the interface stabilizes.

Runtime: **Node** (not Bun) as the assumed runtime for v1 — most dev and agent machines have Node; Bun is less universal. Bun compile is an output target, not a runtime requirement.

---

## 10. Testing

- `core/*` is pure → unit tests with `node --test`, mirroring the repo's existing zero-dep test style.
- **Parity tests** against `public/app.js`: assert `costFor` / `blendedCostFor` produce identical numbers to the website for a fixed fixture (same approach the repo already uses in `test/parity.test.mjs`).
- **Canonicalization parity:** reuse the repo's `test/canonicalization.test.mjs` cases as the CLI's contract.
- **Snapshot fixture:** a small committed fixture for offline deterministic tests; live fetch tested via a mocked `cache.fetch`.

---

## 11. Open Questions (resolve before plan)

1. **Snapshot URL base:** default `https://tokenwatch.wyrdwerk.com/pricing.json`? Confirm the production asset path is stable and served with a long-lived URL.
2. **`generated_at` parsing:** confirm format is always ISO 8601 (sample shows `2026-07-30T14:23:11.156Z`).
3. **Text model record field names:** field-verify `models[]` shape against a real record (deferred from this spec per §3.2) before implementing `types.ts`.
4. **Image/video default fetch:** lazy (only when those subcommands run) vs eager at first invocation. Proposed: lazy.
5. **Single repo or monorepo:** does `tokenwatch-cli` live in this repo (e.g. `cli/`) or a separate `WyrdWerk/tokenwatch-cli` repo? Affects the GitHub-install path and CI.
6. **Cache location on Windows:** `~/.cache` is Unix-y; use `os.tmpdir()` or an env-driven `XDG_CACHE_HOME`/`LOCALAPPDATA` split.

---

## 12. Evidence Index

| Claim | Source | Verified |
|---|---|---|
| CI refresh every 2h | `.github/workflows/refresh-pricing.yml` cron `'0 */2 * * *'` | ✅ |
| `pricing.json` top-level keys | `public/pricing.json:1-3` | ✅ |
| `providers[]` shape | `public/pricing.json:4-8` | ✅ |
| `providers_meta` fields | `public/pricing.json` (`hyper`, `lilac` entries) | ✅ |
| API routes & filters | `functions/api/v1/[[route]].js` | ✅ |
| Pagination default 100, cap 500 | `[[route]].js:43` | ✅ |
| CORS `*`, no `Cache-Control: no-store` | `[[route]].js:19-23` (`CORS_HEADERS`) | ✅ |
| `costFor` / `blendedCostFor` formulas | `public/app.js` ~L934-974 | ✅ |
| `canonicalId` / `orgLookupKey` | `shared/normalize.mjs` L48-77 | ✅ |
| Text model record field set | AGENTS.md | ⚠️ per-doc, not field-verified |
| OpenTUI = Zig core + TS bindings | opentui.com (read this session) | ✅ (TUI package only, out of scope) |
| Agent-CLI conventions (`--json`, TTY, exit codes) | industry patterns | [PATTERN] — re-verify at impl |

---

## 13. Explicitly Out of Scope for This Spec

- The `tokenwatch-tui` package design (OpenTUI, Grok-style visual language) — separate spec.
- Any change to the site repo, API, or CI.
- `--api-url` is IN scope: a paginated adapter (`core/api.js`) fetches the full catalog from `/api/v1/models` with `limit=500`, following `offset` until `total` is reached. `--data-url` (snapshot) remains the default; `--api-url` is the explicit override for users who want the live API.
