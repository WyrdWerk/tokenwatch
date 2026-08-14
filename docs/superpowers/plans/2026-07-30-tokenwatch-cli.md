# TokenWatch CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency Node ESM CLI (`tokenwatch`) that fetches TokenWatch's published pricing snapshot once, caches it locally, and answers all filter/search/cost queries against the local cache with stable `--json`/`--jsonl` output for humans and headless coding agents.

**Architecture:** A separate repo `WyrdWerk/tokenwatch-cli` (required so `npm i -g github:WyrdWerk/tokenwatch-cli` installs from the repo root). Pure layered core (`core/`: normalize, cost, query, format, cache — no I/O, no TTY) consumed by a thin `cli/` dispatcher that handles arg parsing, TTY detection, exit codes, and output selection. The interactive TUI is a separate future package and is explicitly out of scope.

**Tech Stack:** Node ≥ 20 (global `fetch`, `node:util parseArgs`, `node:test`), zero runtime dependencies, plain ESM `.js` with JSDoc.

## Global Constraints

- **Zero runtime dependencies.** `package.json` `dependencies` is `{}`. Only Node built-ins (`node:util`, `node:path`, `node:os`, `node:fs/promises`, `node:test`, `node:assert`, `node:process`).
- **Pure Node ESM.** `"type": "module"` in `package.json`. All source files `.js`.
- **Install target:** `npm i -g github:WyrdWerk/tokenwatch-cli` must produce a working `tokenwatch` bin with no build step and no `prepare` script (plain JS, no transpile).
- **Repo location:** new sibling directory `../tokenwatch-cli` relative to the TokenWatch site repo. The site repo is NOT modified by any task in this plan.
- **Parity contract:** cost/canonicalization numbers MUST match the site's `public/app.js` and `shared/normalize.mjs` verbatim (ported in Tasks 2–3).
- **No network in tests.** `core/cache.js` takes an injectable `fetch` and `--data-url` accepts `file://`/local paths so tests are offline and deterministic.
- **Agent/headless contract:** non-TTY → no prompts, `--json` default, progress to stderr, data to stdout, stable exit codes.
- **Freshness:** cache default TTL = 120 minutes (matches site CI 2-hourly cron). Record both `generated_at` (upstream) and `fetchedAt` (local).
- **No color by default when not a TTY**; honor `NO_COLOR` and `--no-color`.

---

## File Structure

```
tokenwatch-cli/
  package.json              # zero deps, type: module, bin: tokenwatch
  README.md                 # usage
  .gitignore
  src/
    core/
      normalize.js          # canonicalId, orgLookupKey (ported verbatim)
      cost.js                # costFor, blendedCostFor, affordabilityFor (ported verbatim)
      query.js               # filter + sort over models[] (mirrors /api/v1/models)
      format.js              # json, jsonl, table, plain renderers + color/TTY
      cache.js               # snapshot fetch, cache dir, TTL, meta.json
    cli/
      index.js               # parseArgs, TTY detection, exit codes, dispatch
  test/
    normalize.test.js        # canonicalization parity (cases lifted from site)
    cost.test.js             # cost parity vs known fixtures
    query.test.js            # filter/sort parity vs /api/v1/models
    format.test.js           # renderer output shapes
    cache.test.js             # TTL + fetch injection (offline)
    cli.test.js              # end-to-end via spawned bin with fixture --data-url
  fixtures/
    pricing.sample.json      # small committed snapshot for tests
```

**Responsibilities:** `core/*` is pure (no `process.stdout`, no network except `cache.js`'s injectable fetch, no TTY) → unit-testable and reusable by the future TUI package. `cli/index.js` is the only place that touches `process.argv`, `process.stdout`, `process.stderr`, `process.exit`. `format.js` chooses output shape but writes nothing itself — `cli` writes its return value.

---

## Task 1: Repo scaffold

**Files:**
- Create: `../tokenwatch-cli/package.json`
- Create: `../tokenwatch-cli/.gitignore`
- Create: `../tokenwatch-cli/README.md`
- Create: `../tokenwatch-cli/src/cli/index.js` (placeholder that prints version)

**Interfaces:**
- Produces: a runnable `tokenwatch` bin via `package.json` `bin`. Later tasks import from `src/core/*`.

- [ ] **Step 1: Create the repo directory and init git**

Run:
```bash
mkdir -p ../tokenwatch-cli/src/core ../tokenwatch-cli/src/cli ../tokenwatch-cli/test ../tokenwatch-cli/fixtures
cd ../tokenwatch-cli && git init && git branch -m main
```
Expected: `Initialized empty Git repository` and branch renamed to `main`.

- [ ] **Step 2: Write `package.json`**

Create `../tokenwatch-cli/package.json`:
```json
{
  "name": "tokenwatch",
  "version": "0.1.0",
  "description": "Terminal CLI for TokenWatch pay-as-you-go LLM pricing data.",
  "type": "module",
  "bin": { "tokenwatch": "src/cli/index.js" },

  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test test/*.test.js" },
  "files": ["src", "README.md"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/WyrdWerk/tokenwatch-cli.git" }
}
```

- [ ] **Step 3: Write `.gitignore`**

Create `../tokenwatch-cli/.gitignore`:
```
node_modules/
*.log
.DS_Store
.cache/
```

- [ ] **Step 4: Write the placeholder `src/cli/index.js`**

Create `../tokenwatch-cli/src/cli/index.js`:
```js
#!/usr/bin/env node
// tokenwatch CLI entrypoint. Real dispatch lands in Task 7.
import pkg from '../../package.json' with { type: 'json' };
console.log(`tokenwatch v${pkg.version}`);
```

- [ ] **Step 5: Write `README.md` stub**

Create `../tokenwatch-cli/README.md`:
```markdown
# tokenwatch

Terminal CLI for TokenWatch pay-as-you-go LLM pricing data.

Install: `npm i -g github:WyrdWerk/tokenwatch-cli`

Usage: see `tokenwatch --help` (implemented in Task 7).
```

- [ ] **Step 6: Make the bin executable and verify it runs**

Run:
```bash
cd ../tokenwatch-cli
chmod +x src/cli/index.js
node src/cli/index.js
```
Expected: `tokenwatch v0.1.0`

- [ ] **Step 7: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add -A
git commit -m "scaffold: tokenwatch-cli repo, package.json, placeholder bin"
```
Expected: one commit created.

---

## Task 2: Port canonicalization (`core/normalize.js`)

**Files:**
- Create: `../tokenwatch-cli/src/core/normalize.js`
- Test: `../tokenwatch-cli/test/normalize.test.js`

**Interfaces:**
- Produces: `canonicalId(id: string): string` and `orgLookupKey(id: string): string` — byte-for-byte identical to the site's `shared/normalize.mjs`.

- [ ] **Step 1: Write the failing test**

Create `../tokenwatch-cli/test/normalize.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalId, orgLookupKey } from '../src/core/normalize.js';

test('canonicalId strips provider prefix and lowercases', () => {
  assert.equal(canonicalId('z-ai/glm-5.2'), 'glm-5.2');
  assert.equal(canonicalId('zai-org/GLM-5.2'), 'glm-5.2');
  assert.equal(canonicalId('GLM-5.2'), 'glm-5.2');
});

test('canonicalId strips :free, :thinking, and date suffixes', () => {
  assert.equal(canonicalId('meta-llama/llama-4:free'), 'llama-4');
  assert.equal(canonicalId('model-x:thinking'), 'model-x');
  assert.equal(canonicalId('m-2024-08-06'), 'm');
  assert.equal(canonicalId('m-20260420'), 'm');
  assert.equal(canonicalId('m-250712'), 'm');
});

test('canonicalId strips known -preview suffixes but preserves -preview-customtools', () => {
  assert.equal(canonicalId('gemini-3.1-pro-preview'), 'gemini-3.1-pro');
  assert.equal(canonicalId('gemini-3.1-pro-preview-09-2025'), 'gemini-3.1-pro');
  assert.equal(canonicalId('gemini-3.1-pro-preview-2024-08-06'), 'gemini-3.1-pro');
  assert.equal(canonicalId('gemini-3.1-pro-preview-05-06'), 'gemini-3.1-pro');
  assert.equal(canonicalId('gemini-3.1-pro-preview-customtools'), 'gemini-3.1-pro-preview-customtools');
});

test('canonicalId preserves quantization suffixes', () => {
  assert.equal(canonicalId('glm-5.2-fp8'), 'glm-5.2-fp8');
  assert.equal(canonicalId('glm-5.2-nvfp4'), 'glm-5.2-nvfp4');
});

test('orgLookupKey strips quant/tier suffixes that canonicalId keeps', () => {
  assert.equal(orgLookupKey('glm-5.2-fp8'), 'glm-5.2');
  assert.equal(orgLookupKey('glm-5.2-nvfp4'), 'glm-5.2');
  assert.equal(orgLookupKey('m-int4-mixed-ar'), 'm');
  assert.equal(orgLookupKey('m-long'), 'm');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../tokenwatch-cli && node --test test/normalize.test.js`
Expected: FAIL — `Cannot find module '../src/core/normalize.js'`.

- [ ] **Step 3: Write the implementation (verbatim port of `shared/normalize.mjs`)**

Create `../tokenwatch-cli/src/core/normalize.js`:
```js
// Ported verbatim from the TokenWatch site's shared/normalize.mjs.
// Pure string transforms — no node: imports, so it stays bundleable.

export function canonicalId(id) {
  let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
  k = k.replace(/:free$/, '')
       .replace(/:thinking$/, '')
       .replace(/-(\d{4})-(\d{2})-(\d{2})$/, '')
       .replace(/-preview-(\d{2})-(\d{4})$/, '')
       .replace(/-preview-(\d{4})-(\d{2})-(\d{2})$/, '')
       .replace(/-preview-(\d{2})-(\d{2})$/, '')
       .replace(/-preview$/, '')
       .replace(/-(\d{8})$/, '')
       .replace(/-(\d{6})$/, '')
       .toLowerCase().trim();
  return k;
}

export function orgLookupKey(id) {
  return canonicalId(id)
    .replace(/-(fp8|nvfp4|int4-mixed-ar|int4|bf16|fp16|fp6|mxfp4)$/, '')
    .replace(/-long$/, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../tokenwatch-cli && node --test test/normalize.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add src/core/normalize.js test/normalize.test.js
git commit -m "feat(core): port canonicalId and orgLookupKey from site"
```

---

## Task 3: Port cost math (`core/cost.js`)

**Files:**
- Create: `../tokenwatch-cli/src/core/cost.js`
- Test: `../tokenwatch-cli/test/cost.test.js`

**Interfaces:**
- Produces:
  - `costFor(pricing, tokens): number | null`
  - `blendedCostFor(pricing, tokens): number | null`
  - `affordabilityFor(pricing, tokens, budget): number | null`
- `pricing` shape: `{ input, output, cache_read, cache_write }` (all $/M, nullable).
- `tokens` shape: `{ input, output, cacheRead, cacheWrite, amortizeN, inputPct, outputPct, cacheReadPct }`.

- [ ] **Step 1: Write the failing test**

Create `../tokenwatch-cli/test/cost.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFor, blendedCostFor, affordabilityFor } from '../src/core/cost.js';

const pricing = { input: 1.25, output: 5, cache_read: 0.31, cache_write: 1.875 };
const tokens = {
  input: 700_000, output: 200_000, cacheRead: 100_000,
  cacheWrite: 0, amortizeN: 1,
  inputPct: 70, outputPct: 20, cacheReadPct: 10,
};

test('costFor sums components as (price * tok) / 1e6', () => {
  const got = costFor(pricing, tokens);
  // 1.25*700000/1e6 + 5*200000/1e6 + 0.31*100000/1e6
  assert.equal(got, 0.875 + 1.0 + 0.031);
});

test('costFor returns null when requested input price is missing', () => {
  assert.equal(costFor({ input: null, output: 5 }, { ...tokens, input: 100 }), null);
});

test('costFor treats cache_read null as input rate, cache_write null as $0', () => {
  const got = costFor({ input: 1.25, output: 5, cache_read: null, cache_write: null }, tokens);
  // cache_read falls back to input: 1.25*100000/1e6
  assert.equal(got, 0.875 + 1.0 + 0.125);
});

test('costFor amortizes cache_write over amortizeN requests', () => {
  const t = { ...tokens, cacheWrite: 500_000, amortizeN: 10 };
  const got = costFor(pricing, t);
  // base 1.906 + 1.875*500000/1e6/10 = 1.906 + 0.09375
  assert.equal(got, 1.906 + 0.09375);
});

test('blendedCostFor excludes cache_write and is a $/M rate', () => {
  const got = blendedCostFor(pricing, tokens);
  // 1.25*0.7 + 5*0.2 + 0.31*0.1
  assert.equal(got, 0.875 + 1.0 + 0.031);
});

test('blendedCostFor returns null when requested output pct has no price', () => {
  assert.equal(blendedCostFor({ input: 1, output: null }, { ...tokens, outputPct: 50 }), null);
});

test('affordabilityFor returns millions of tokens a budget buys', () => {
  // effectiveRate = 0.7*1.25 + 0.2*5 + 0.1*0.31 = 1.906 $/M, no cache_write fixed
  const m = affordabilityFor(pricing, tokens, 100);
  assert.equal(m, 100 / 1.906);
});

test('affordabilityFor free offering: Infinity when budget covers fixed charge, null otherwise', () => {
  const free = { input: 0, output: 0, cache_read: 0, cache_write: 1.875 };
  const t = { ...tokens, cacheWrite: 1_000_000, amortizeN: 1 };
  // cwFixed = 1.875 * 1e6 / 1e6 = 1.875
  assert.equal(affordabilityFor(free, t, 2), Infinity);     // budget 2 >= cwFixed 1.875
  assert.equal(affordabilityFor(free, t, 1), null);          // budget 1 < cwFixed 1.875
});

test('affordabilityFor returns null when budget cannot cover cache-write setup', () => {
  const t = { ...tokens, cacheWrite: 1_000_000, amortizeN: 1 };
  // cwFixed = 1.875, effectiveRate = 1.906
  assert.equal(affordabilityFor(pricing, t, 1.875), null);   // budget == cwFixed
  assert.equal(affordabilityFor(pricing, t, 1), null);        // budget < cwFixed
  assert.ok(affordabilityFor(pricing, t, 1.876) > 0);         // budget just over cwFixed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../tokenwatch-cli && node --test test/cost.test.js`
Expected: FAIL — `Cannot find module '../src/core/cost.js'`.

- [ ] **Step 3: Write the implementation (verbatim port of `public/app.js` cost functions)**

Create `../tokenwatch-cli/src/core/cost.js`:
```js
// Ported verbatim from the TokenWatch site's public/app.js cost functions.
// All prices are USD per million tokens ($/M).

export function costFor(pricing, tokens) {
  const c = (price, tok) => (price != null ? (price * tok) / 1e6 : null);
  const inputCost = c(pricing.input, tokens.input);
  const outputCost = c(pricing.output, tokens.output);
  const cacheReadCost = c(pricing.cache_read != null ? pricing.cache_read : pricing.input, tokens.cacheRead);
  const cacheWriteCost = tokens.cacheWrite > 0 && pricing.cache_write != null
    ? (pricing.cache_write * (tokens.cacheWrite / (tokens.amortizeN || 1))) / 1e6
    : 0;
  if (tokens.input > 0 && inputCost === null) return null;
  if (tokens.output > 0 && outputCost === null) return null;
  return (inputCost || 0) + (outputCost || 0) + (cacheReadCost || 0) + cacheWriteCost;
}

export function blendedCostFor(pricing, tokens) {
  const inRate  = pricing.input != null ? pricing.input * tokens.inputPct / 100 : null;
  const outRate = pricing.output != null ? pricing.output * tokens.outputPct / 100 : null;
  const crPrice = pricing.cache_read != null ? pricing.cache_read : pricing.input;
  const crRate  = crPrice != null ? crPrice * tokens.cacheReadPct / 100 : null;
  if (tokens.inputPct > 0 && inRate === null) return null;
  if (tokens.outputPct > 0 && outRate === null) return null;
  return (inRate || 0) + (outRate || 0) + (crRate || 0);
}

export function affordabilityFor(pricing, tokens, budget) {
  const rate = (price, pct) => (price != null ? price * pct / 100 : null);
  const inRate  = tokens.inputPct     > 0 ? rate(pricing.input,  tokens.inputPct)     : 0;
  const outRate = tokens.outputPct   > 0 ? rate(pricing.output, tokens.outputPct)    : 0;
  const crPrice = pricing.cache_read != null ? pricing.cache_read : pricing.input;
  const crRate  = tokens.cacheReadPct > 0 ? rate(crPrice, tokens.cacheReadPct)       : 0;
  if (tokens.inputPct > 0 && inRate === null) return null;
  if (tokens.outputPct > 0 && outRate === null) return null;
  let cwFixed = 0;
  if (tokens.cacheWrite > 0 && pricing.cache_write != null) {
    cwFixed = (pricing.cache_write * (tokens.cacheWrite / (tokens.amortizeN || 1))) / 1e6;
  }
  const effectiveRate = (inRate || 0) + (outRate || 0) + (crRate || 0);
  if (effectiveRate <= 0) {
    // Free per-token offering. Affordable iff the budget covers the fixed charge.
    return budget >= cwFixed ? Infinity : null;
  }
  if (budget <= cwFixed) return null; // can't even cover cache-write setup
  return (budget - cwFixed) / effectiveRate;
}
```

Expected: PASS (9 tests).

Run: `cd ../tokenwatch-cli && node --test test/cost.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add src/core/cost.js test/cost.test.js
git commit -m "feat(core): port costFor, blendedCostFor, affordabilityFor"
```

---

## Task 4: Query layer (`core/query.js`)

**Files:**
- Create: `../tokenwatch-cli/src/core/query.js`
- Test: `../tokenwatch-cli/test/query.test.js`
- Create: `../tokenwatch-cli/fixtures/pricing.sample.json`

**Interfaces:**
- Produces: `filterModels(models, opts): model[]` and `sortModels(models, sort, order): model[]` where `opts` mirrors the `/api/v1/models` query params (booleans as `true`/`false`/`undefined`).
- Consumes: `models` records shaped per the snapshot (fields: `id`, `name`, `org`, `provider`, `pricing`, `context_length`, `max_completion_tokens`, `quantization`, `zdr`, `subscription`, `discount`, `uptime_30m`, `benchmarks`).

- [ ] **Step 1: Create a small fixture**

Create `../tokenwatch-cli/fixtures/pricing.sample.json`:
```json
{
  "generated_at": "2026-07-30T14:23:11.156Z",
  "providers": [
    { "key": "deepinfra", "name": "DeepInfra", "model_count": 2, "status": "ok" }
  ],
  "models": [
    {
      "id": "z-ai/glm-5.2",
      "name": "GLM 5.2",
      "org": "z-ai",
      "provider": "deepinfra",
      "pricing": { "input": 1.25, "output": 5, "cache_read": 0.31, "cache_write": 1.875 },
      "context_length": 128000,
      "max_completion_tokens": 16384,
      "quantization": "fp8",
      "zdr": false,
      "subscription": false,
      "discount": 0,
      "uptime_30m": 99.9
    },
    {
      "id": "google/gemini-3.1-pro",
      "name": "Gemini 3.1 Pro",
      "org": "google",
      "provider": "deepinfra",
      "pricing": { "input": 0.10, "output": 7.00, "cache_read": 0.10, "cache_write": 0.625 },
      "context_length": 1000000,
      "max_completion_tokens": 65536,
      "quantization": null,
      "zdr": true,
      "subscription": false,
      "discount": 0.7,
      "uptime_30m": 99.5
    }
  ],
  "providers_meta": {}
}
```

- [ ] **Step 2: Write the failing test**

Create `../tokenwatch-cli/test/query.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterModels, sortModels } from '../src/core/query.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/pricing.sample.json', import.meta.url)));
const models = data.models;

test('filterModels by org', () => {
  assert.equal(filterModels(models, { org: 'z-ai' }).length, 1);
  assert.equal(filterModels(models, { org: 'z-ai' })[0].id, 'z-ai/glm-5.2');
});

test('filterModels by provider (case-insensitive)', () => {
  assert.equal(filterModels(models, { provider: 'DeepInfra' }).length, 2);
});

test('filterModels zdr/promo/sub flags', () => {
  assert.equal(filterModels(models, { zdr: true }).length, 1);
  assert.equal(filterModels(models, { promo: true }).length, 1);
  assert.equal(filterModels(models, { sub: true }).length, 0);
});

test('filterModels min_context and quantization', () => {
  assert.equal(filterModels(models, { minContext: 500000 }).length, 1);
  assert.equal(filterModels(models, { quantization: 'fp8' }).length, 1);
  assert.equal(filterModels(models, { quantization: 'unknown' }).length, 1);
});

test('filterModels search matches id, name, org, provider', () => {
  assert.equal(filterModels(models, { search: 'gemini' }).length, 1);
  assert.equal(filterModels(models, { search: 'deepinfra' }).length, 2);
});

test('sortModels ascending input', () => {
  const sorted = sortModels(models, 'input', 'asc');
  assert.equal(sorted[0].id, 'google/gemini-3.1-pro');
});

test('sortModels maps context/max_output/uptime/benchmark keys', () => {
  assert.equal(sortModels(models, 'context', 'desc')[0].id, 'google/gemini-3.1-pro');
  assert.equal(sortModels(models, 'max_output', 'desc')[0].id, 'google/gemini-3.1-pro');
  assert.equal(sortModels(models, 'uptime', 'asc')[0].id, 'google/gemini-3.1-pro');
});

test('sortModels nulls sort last', () => {
  // gemini has quantization null but we sort by pricing keys here; verify null-pricing last
  const withNull = [{ id: 'a', pricing: { input: null } }, { id: 'b', pricing: { input: 2 } }];
  assert.equal(sortModels(withNull, 'input', 'asc')[0].id, 'b');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ../tokenwatch-cli && node --test test/query.test.js`
Expected: FAIL — `Cannot find module '../src/core/query.js'`.

- [ ] **Step 4: Write the implementation (mirrors `functions/api/v1/[[route]].js` filters 239–300)**

Create `../tokenwatch-cli/src/core/query.js`:
```js
// Mirrors the /api/v1/models filter and sort semantics from the site's
// functions/api/v1/[[route]].js so CLI results match the API exactly.

const VALID_SORTS = ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'];

export function filterModels(models, opts = {}) {
  let out = models;

  if (opts.org) out = out.filter(m => m.org === opts.org.toLowerCase());
  if (opts.provider) out = out.filter(m => m.provider === opts.provider.toLowerCase());

  if (opts.minContext) out = out.filter(m => m.context_length && m.context_length >= opts.minContext);
  if (opts.minOutput) out = out.filter(m => m.max_completion_tokens && m.max_completion_tokens >= opts.minOutput);

  if (opts.quantization) out = out.filter(m => (m.quantization || 'unknown') === opts.quantization.toLowerCase());

  if (opts.cacheRead === true) out = out.filter(m => m.pricing?.cache_read != null);
  if (opts.cacheWrite === true) out = out.filter(m => m.pricing?.cache_write != null);

  if (opts.promo === true) out = out.filter(m => m.discount > 0);
  if (opts.zdr === true) out = out.filter(m => m.zdr === true);
  if (opts.sub === true) out = out.filter(m => m.subscription === true);
  if (opts.benchmarked === true) out = out.filter(m => !!m.benchmarks);

  if (opts.search) {
    const q = opts.search.toLowerCase();
    out = out.filter(m =>
      m.id.toLowerCase().includes(q) ||
      (m.name && m.name.toLowerCase().includes(q)) ||
      m.org.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q)
    );
  }

  return out;
}

export function sortModels(models, sort = 'id', order = 'asc') {
  const sortKey = VALID_SORTS.includes(sort) ? sort : 'id';
  const dir = order === 'desc' ? -1 : 1;
  return [...models].sort((a, b) => {
    let va, vb;
    if (sortKey === 'id') { va = a.id.toLowerCase(); vb = b.id.toLowerCase(); }
    else if (sortKey === 'context') { va = a.context_length; vb = b.context_length; }
    else if (sortKey === 'max_output') { va = a.max_completion_tokens; vb = b.max_completion_tokens; }
    else if (sortKey === 'uptime') { va = a.uptime_30m; vb = b.uptime_30m; }
    else if (sortKey === 'intelligence') { va = a.benchmarks?.intelligence_index; vb = b.benchmarks?.intelligence_index; }
    else if (sortKey === 'coding') { va = a.benchmarks?.coding_index; vb = b.benchmarks?.coding_index; }
    else if (sortKey === 'agentic') { va = a.benchmarks?.agentic_index; vb = b.benchmarks?.agentic_index; }
    else { va = a.pricing?.[sortKey]; vb = b.pricing?.[sortKey]; }
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ../tokenwatch-cli && node --test test/query.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add src/core/query.js test/query.test.js fixtures/pricing.sample.json
git commit -m "feat(core): query layer mirroring /api/v1/models filters and sort"
```


## Task 4.5: API adapter (`core/api.js`) — `--api-url` support

**Files:**
- Create: `../tokenwatch-cli/src/core/api.js`
- Test: `../tokenwatch-cli/test/api.test.js`

**Interfaces:**
- Produces: `fetchApiCatalog({ apiUrl, fetchImpl, kind }): Promise<{ generated_at, models, providers, providers_meta }>` — paginates `/api/v1/models` (or `/images`/`/videos`) with `limit=500`, following `offset` until `total` is reached, then assembles a snapshot-shaped object the CLI's query/cost layers can consume.
- Consumes: `fetchImpl` defaults to global `fetch`; tests inject a stub.
- The CLI's `getData()` checks `--api-url` first (uses this adapter), then falls back to `--data-url` (snapshot).

- [ ] **Step 1: Write the failing test**

Create `../tokenwatch-cli/test/api.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchApiCatalog } from '../src/core/api.js';

test('fetchApiCatalog paginates until total reached', async () => {
  let calls = 0;
  const pages = [
    { total: 3, offset: 0, limit: 2, models: [{ id: 'a' }, { id: 'b' }] },
    { total: 3, offset: 2, limit: 2, models: [{ id: 'c' }] },
  ];
  const fetchImpl = async (url) => {
    calls++;
    const page = pages[calls - 1];
    return { ok: true, json: async () => page, text: async () => JSON.stringify(page) };
  };
  const result = await fetchApiCatalog({ apiUrl: 'https://example.com/api/v1', fetchImpl, kind: 'text', pageSize: 2 });
  assert.equal(calls, 2);
  assert.equal(result.models.length, 3);
  assert.deepEqual(result.models.map(m => m.id), ['a', 'b', 'c']);
});

test('fetchApiCatalog uses kind to select the right endpoint', async () => {
  let lastUrl = '';
  const fetchImpl = async (url) => {
    lastUrl = url;
    return { ok: true, json: async () => ({ total: 0, models: [] }), text: async () => '{}' };
  };
  await fetchApiCatalog({ apiUrl: 'https://example.com/api/v1', fetchImpl, kind: 'images', pageSize: 500 });
  assert.match(lastUrl, /\/images/);
  assert.ok(!lastUrl.includes('models'));
});

test('fetchApiCatalog throws on non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(
    () => fetchApiCatalog({ apiUrl: 'https://example.com/api/v1', fetchImpl, kind: 'text' }),
    /500/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../tokenwatch-cli && node --test test/api.test.js`
Expected: FAIL — `Cannot find module '../src/core/api.js'`.

- [ ] **Step 3: Write the implementation**

Create `../tokenwatch-cli/src/core/api.js`:
```js
// Paginated adapter for the TokenWatch /api/v1 HTTP API.
// Assembles a full catalog by following offset until total is reached.
// The assembled object is snapshot-shaped so query/cost layers consume it identically.

const ENDPOINTS = {
  text: 'models',
  images: 'images',
  videos: 'videos',
};

export async function fetchApiCatalog({ apiUrl, fetchImpl = fetch, kind = 'text', pageSize = 500 }) {
  const endpoint = ENDPOINTS[kind] || 'models';
  const base = apiUrl.replace(/\/$/, '');
  const allModels = [];
  let offset = 0;
  let total = Infinity;
  let generatedAt = null;

  while (offset < total) {
    const url = `${base}/${endpoint}?limit=${pageSize}&offset=${offset}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const page = await res.json();
    total = page.total;
    if (page.generated_at) generatedAt = page.generated_at;
    allModels.push(...(page.models || []));
    offset += pageSize;
    // Safety: if the API returns no models in a page, break to avoid infinite loop.
    if (!page.models || page.models.length === 0) break;
  }

  return {
    generated_at: generatedAt,
    models: allModels,
    providers: [],
    providers_meta: {},
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../tokenwatch-cli && node --test test/api.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add src/core/api.js test/api.test.js
git commit -m "feat(core): paginated --api-url adapter for /api/v1/models"
```

---
---

## Task 5: Formatters (`core/format.js`)

**Files:**
- Create: `../tokenwatch-cli/src/core/format.js`
- Test: `../tokenwatch-cli/test/format.test.js`

**Interfaces:**
- Produces:
  - `renderJson(value): string` — `JSON.stringify(value, null, 2)`
  - `renderJsonl(array): string` — one JSON object per line
  - `renderTable(models, { fields }): string` — aligned columns, optional ANSI color
  - `supportsColor(opts): boolean` — false if `opts.noColor` or `NO_COLOR` env set
- `cli` is responsible for choosing which renderer and for writing to stdout.

- [ ] **Step 1: Write the failing test**

Create `../tokenwatch-cli/test/format.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderJson, renderJsonl, renderTable, supportsColor } from '../src/core/format.js';

test('renderJson pretty-prints', () => {
  assert.equal(renderJson({ a: 1 }), '{\n  "a": 1\n}');
});

test('renderJsonl emits one object per line', () => {
  assert.equal(renderJsonl([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}');
});

test('renderTable aligns columns with header', () => {
  const models = [
    { id: 'glm-5.2',   org: 'z-ai',   provider: 'deepinfra', pricing: { input: 1.25 } },
    { id: 'gemini-pro', org: 'google', provider: 'deepinfra', pricing: { input: 0.10 } },
  ];
  const out = renderTable(models, { fields: ['id', 'org', 'provider', 'input'] });
  const lines = out.split('\n');
  assert.match(lines[0], /ID\s+ORG\s+PROVIDER\s+INPUT/);
  assert.match(lines[1], /glm-5.2\s+z-ai\s+deepinfra\s+1\.25/);
  assert.match(lines[2], /gemini-pro\s+google\s+deepinfra\s+0\.1/);
});

test('supportsColor false when NO_COLOR set', () => {
  assert.equal(supportsColor({ noColor: true }), false);
  assert.equal(supportsColor({ env: { NO_COLOR: '1' } }), false);
});

test('renderTable with color disabled contains no ANSI codes', () => {
  const models = [{ id: 'x', org: 'y', provider: 'z', pricing: { input: 1 } }];
  const out = renderTable(models, { fields: ['id', 'org', 'provider', 'input'], noColor: true });
  assert.equal(out, out.replace(/\u001b\[[0-9;]*m/g, ''));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../tokenwatch-cli && node --test test/format.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `../tokenwatch-cli/src/core/format.js`:
```js
// Pure renderers: they return strings; the cli writes them. No process I/O here.

const HEADERS = {
  id: 'ID', org: 'ORG', provider: 'PROVIDER', name: 'NAME',
  input: 'INPUT', output: 'OUTPUT', cache_read: 'CACHE_R', cache_write: 'CACHE_W',
  context: 'CONTEXT', max_output: 'MAXOUT', quantization: 'QUANT',
  zdr: 'ZDR', subscription: 'SUB', discount: 'PROMO', uptime: 'UPTIME',
};

const ANSI = {
  reset: '\x1b[0m', dim: '\x1b[2m', accent: '\x1b[36m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};

export function supportsColor(opts = {}) {
  if (opts.noColor) return false;
  if (opts.env && opts.env.NO_COLOR) return false;
  return true;
}

export function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

export function renderJsonl(array) {
  return array.map(o => JSON.stringify(o)).join('\n');
}

function getField(model, field) {
  if (field === 'context') return model.context_length;
  if (field === 'max_output') return model.max_completion_tokens;
  if (field === 'uptime') return model.uptime_30m;
  if (['input', 'output', 'cache_read', 'cache_write'].includes(field)) return model.pricing?.[field];
  if (field === 'zdr') return model.zdr ? 'zdr' : '';
  if (field === 'subscription') return model.subscription ? 'sub' : '';
  if (field === 'discount') return model.discount > 0 ? `${Math.round(model.discount * 100)}%` : '';
  return model[field];
}

function fmtCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, '');
  return String(v);
}

export function renderTable(models, opts = {}) {
  const fields = opts.fields || ['id', 'org', 'provider', 'input', 'output'];
  const color = supportsColor(opts);
  const headers = fields.map(f => HEADERS[f] || f);
  const rows = models.map(m => fields.map(f => fmtCell(getField(m, f))));

  const widths = fields.map((f, i) =>
    Math.max(headers[i].length, ...rows.map(r => r[i].length)));

  const pad = (s, i) => s.padEnd(widths[i]) + (i < fields.length - 1 ? '  ' : '');

  const head = headers.map((h, i) => pad(color ? `${ANSI.dim}${h}${ANSI.reset}` : h, i)).join('').trimEnd();
  const sep = fields.map((_, i) => '-'.repeat(widths[i])).join('  ');
  const body = rows.map(r => r.map((c, i) => pad(c, i)).join('').trimEnd()).join('\n');

  return [head, sep, body].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../tokenwatch-cli && node --test test/format.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add src/core/format.js test/format.test.js
git commit -m "feat(core): json/jsonl/table renderers with color support"
```

---

## Task 6: Snapshot cache (`core/cache.js`)

**Files:**
- Create: `../tokenwatch-cli/src/core/cache.js`
- Test: `../tokenwatch-cli/test/cache.test.js`

**Interfaces:**
- Produces:
  - `cacheDir(opts?): string` — resolves `XDG_CACHE_HOME`/`LOCALAPPDATA`/`os.tmpdir()` + `tokenwatch`
  - `loadSnapshot({ dataUrl, ttlMinutes, fetchImpl, cachePath }): Promise<{ data, meta }>` — returns cached if fresh, else fetches and writes
  - `metaPath(cachePath): string` — `meta.json` next to the snapshot
- `fetchImpl` defaults to global `fetch`; tests inject a stub. `dataUrl` accepts `file://`/local paths or `http(s)://`.

- [ ] **Step 1: Write the failing test**

Create `../tokenwatch-cli/test/cache.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDir, loadSnapshot, metaPath } from '../src/core/cache.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'tw-cache-'));
}

test('cacheDir joins tokenwatch under a custom root', () => {
  const d = freshDir();
  assert.equal(cacheDir({ cacheRoot: d }), join(d, 'tokenwatch'));
});

test('loadSnapshot reads fresh local file without fetching', async () => {
  const root = freshDir();
  const snap = join(root, 'pricing.json');
  writeFileSync(snap, JSON.stringify({ generated_at: '2026-07-30T00:00:00Z', models: [{ id: 'x' }] }));
  const { data, meta } = await loadSnapshot({
    dataUrl: `file://${snap}`,
    cachePath: snap,
    ttlMinutes: 120,
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.equal(data.models[0].id, 'x');
  assert.equal(meta.generatedAt, '2026-07-30T00:00:00Z');
});

test('loadSnapshot refetches when stale', async () => {
  const root = freshDir();
  const snap = join(root, 'pricing.json');
  const stale = { generated_at: '2020-01-01T00:00:00Z', models: [] };
  writeFileSync(snap, JSON.stringify(stale));
  const fresh = { generated_at: '2026-07-30T00:00:00Z', models: [{ id: 'fresh' }] };
  let fetched = 0;
  const fetchImpl = async (url) => {
    fetched++;
    return { ok: true, text: async () => JSON.stringify(fresh) };
  };
  const { data, meta } = await loadSnapshot({
    dataUrl: 'https://example.com/pricing.json',
    cachePath: snap,
    ttlMinutes: 0,            // force stale
    fetchImpl,
  });
  assert.equal(fetched, 1);
  assert.equal(data.models[0].id, 'fresh');
  assert.equal(meta.generatedAt, '2026-07-30T00:00:00Z');
  assert.ok(meta.fetchedAt);
});

test('loadSnapshot writes meta.json next to cache', async () => {
  const root = freshDir();
  const snap = join(root, 'pricing.json');
  writeFileSync(snap, JSON.stringify({ generated_at: '2026-07-30T00:00:00Z', models: [] }));
  await loadSnapshot({ dataUrl: `file://${snap}`, cachePath: snap, ttlMinutes: 120, fetchImpl: async () => { throw new Error('nope'); } });
  const meta = JSON.parse(readFileSync(metaPath(snap), 'utf8'));
  assert.equal(meta.generatedAt, '2026-07-30T00:00:00Z');
  assert.ok(meta.fetchedAt);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../tokenwatch-cli && node --test test/cache.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `../tokenwatch-cli/src/core/cache.js`:
```js
import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function cacheDir(opts = {}) {
  if (opts.cacheRoot) return join(opts.cacheRoot, 'tokenwatch');
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'tokenwatch');
  if (platform() === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'tokenwatch');
  return join(homedir(), '.cache', 'tokenwatch');
}

export function metaPath(cachePath) {
  return cachePath + '.meta.json';
}
```

Note: meta lives at `<cachePath>.meta.json` (sibling to the cached snapshot).

Note: the above `metaPath` is overcomplicated. Simplify — meta lives at `<cachePath>.meta.json`:

```js
export function metaPath(cachePath) {
  return cachePath + '.meta.json';
}
```

Full file:
```js
import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function cacheDir(opts = {}) {
  if (opts.cacheRoot) return join(opts.cacheRoot, 'tokenwatch');
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'tokenwatch');
  if (platform() === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'tokenwatch');
  return join(homedir(), '.cache', 'tokenwatch');
}

export function metaPath(cachePath) {
  return cachePath + '.meta.json';
}

async function readMeta(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try { await fs.access(path); return true; } catch { return false; }
}

export async function loadSnapshot({ dataUrl, ttlMinutes = 120, fetchImpl = fetch, cachePath }) {
  const mp = metaPath(cachePath);
  const meta = await readMeta(mp);
  const now = Date.now();
  const fresh = meta && meta.fetchedAt && (now - meta.fetchedAt) < ttlMinutes * 60 * 1000;

  let data;
  if (fresh) {
    data = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } else {
    let text;
    if (dataUrl && dataUrl.startsWith('file://')) {
      text = await fs.readFile(new URL(dataUrl), 'utf8');
    } else if (dataUrl && /^https?:\/\//.test(dataUrl) === false) {
      // bare local path
      text = await fs.readFile(dataUrl, 'utf8');
    } else {
      const res = await fetchImpl(dataUrl);
      if (!res.ok) throw new Error(`fetch ${dataUrl} -> ${res.status}`);
      text = await res.text();
    }
    data = JSON.parse(text);
    await fs.mkdir(join(cachePath, '..'), { recursive: true });
    await fs.writeFile(cachePath, text);
    const newMeta = { generatedAt: data.generated_at || null, fetchedAt: now, dataUrl };
    await fs.writeFile(mp, JSON.stringify(newMeta));
    return { data, meta: newMeta };
  }
  return { data, meta };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../tokenwatch-cli && node --test test/cache.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add src/core/cache.js test/cache.test.js
git commit -m "feat(core): snapshot cache with TTL and injectable fetch"
```

---

## Task 7: CLI dispatcher (`cli/index.js`)

**Files:**
- Modify: `../tokenwatch-cli/src/cli/index.js` (replace placeholder)
- Test: `../tokenwatch-cli/test/cli.test.js`

**Interfaces:**
- Consumes: `core/cache.js loadSnapshot`, `core/query.js filterModels/sortModels`, `core/cost.js costFor/blendedCostFor`, `core/format.js render*`.
- Produces: the `tokenwatch` bin with subcommands `models`, `providers`, `stats`, `images`, `videos`, `refresh`, and a `--json`/`--jsonl`/`--no-color` global contract.

- [ ] **Step 1: Write the failing end-to-end test**

Create `../tokenwatch-cli/test/cli.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'src', 'cli', 'index.js');
const fixture = join(here, '..', 'fixtures', 'pricing.sample.json');
// Isolated temp cache root for the whole suite so tests never read a stale
// shared ~/.cache/tokenwatch. mkdtempSync is imported above.
const cacheRoot = mkdtempSync(join(tmpdir(), 'tw-test-cache-'));

function run(args, env = {}) {
  return execFileSync(process.execPath, [bin, ...args, '--cache-root', cacheRoot], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('models --json outputs JSON with generated_at and models', () => {
  const out = run(['models', '--json', '--data-url', `file://${fixture}`]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.models.length, 2);
  assert.equal(parsed.generated_at, '2026-07-30T14:23:11.156Z');
});

test('models with --org filter returns one match', () => {
  const out = run(['models', '--json', '--org', 'z-ai', '--data-url', `file://${fixture}`]);
  assert.equal(JSON.parse(out).total, 1);
});

test('non-TTY defaults to no color and table output', () => {
  const out = run(['models', '--data-url', `file://${fixture}`], { NO_COLOR: '1' });
  assert.match(out, /ID\s+ORG\s+PROVIDER/);
  assert.equal(out.includes('\x1b['), false);
});

test('providers <model> --json sorts by mix-aware cost', () => {
  const out = run(['providers', 'glm-5.2', '--json', '--tokens', '1', '--mix', '70,20,10', '--data-url', `file://${fixture}`]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.canonicalId, 'glm-5.2');
  assert.ok(Array.isArray(parsed.providers));
});

test('stats --json returns catalog summary', () => {
  const out = run(['stats', '--json', '--data-url', `file://${fixture}`]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.models, 2);
  assert.equal(parsed.providers, 1);
});

test('non-TTY defaults to json output (agent-friendly)', () => {
  const out = run(['models', '--data-url', `file://${fixture}`], { NO_COLOR: '1' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 2);
  assert.equal(out.includes('\x1b['), false);
});

test('exit code 4 on no results', () => {
  let code = 0;
  try {
    run(['models', '--org', 'nonexistent', '--json', '--data-url', `file://${fixture}`]);
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 4);
});

test('tui prints install hint when tokenwatch-tui missing', () => {
  const out = run(['tui', '--data-url', `file://${fixture}`], { PATH: '/usr/bin' });
  assert.match(out, /npm i -g tokenwatch-tui/);
});

test('tui spawns tokenwatch-tui with --data when present on PATH', () => {
  // Create a temp dir with a fake tokenwatch-tui that echoes its args and exits 0.
  // (mkdtempSync, writeFileSync, chmodSync, tmpdir, join are imported at top of file)
  const dir = mkdtempSync(join(tmpdir(), 'tw-tui-'));
  const exe = join(dir, 'tokenwatch-tui');
  writeFileSync(exe, '#!/bin/sh\necho "TUI invoked with: $@"\n');
  chmodSync(exe, 0o755);
  const out = run(['tui', '--data-url', `file://${fixture}`], { PATH: dir });
  assert.match(out, /TUI invoked with: --data/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../tokenwatch-cli && node --test test/cli.test.js`
Expected: FAIL — placeholder prints version, not JSON.

- [ ] **Step 3: Write the implementation**

Replace `../tokenwatch-cli/src/cli/index.js`:
```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { cacheDir, loadSnapshot } from '../core/cache.js';
import { filterModels, sortModels } from '../core/query.js';
import { costFor, blendedCostFor } from '../core/cost.js';
import { canonicalId } from '../core/normalize.js';
import { renderJson, renderJsonl, renderTable, supportsColor } from '../core/format.js';

const SNAPSHOT_NAMES = {
  text: 'pricing.json',
  images: 'image-pricing.json',
  videos: 'video-pricing.json',
};

function exit(code, msg) {
  if (msg) process.stderr.write(msg + '\n');
  process.exit(code);
}

function parseMix(mix) {
  // Default mix: 2.5% input, 97% cache-read, 0.5% output (site default, app.js:97-99).
  const [inputPct = 2.5, cacheReadPct = 97, outputPct = 0.5] = (mix || '2.5,97,0.5').split(',').map(Number);
  return { inputPct: inputPct || 0, cacheReadPct: cacheReadPct || 0, outputPct: outputPct || 0 };
}

async function getData(opts, kind = 'text') {
  // If --api-url is set, fetch the full catalog from the API (paginated).
  // Otherwise, use the snapshot asset via --data-url with local caching.
  if (opts.apiUrl) {
    try {
      const { fetchApiCatalog } = await import('../core/api.js');
      const data = await fetchApiCatalog({ apiUrl: opts.apiUrl, kind, fetchImpl: fetch });
      return { data, meta: { generatedAt: data.generated_at, fetchedAt: Date.now(), dataUrl: opts.apiUrl } };
    } catch (e) {
      exit(3, `error: ${e.message}`);
    }
  }
  const name = SNAPSHOT_NAMES[kind];
  const cdir = cacheDir({ cacheRoot: opts.cacheRoot });
  const cachePath = join(cdir, name);
  const ttl = opts.ttl != null ? Number(opts.ttl) : 120;
  try {
    return await loadSnapshot({
      dataUrl: opts.dataUrl || defaultDataUrl(name),
      ttlMinutes: ttl,
      cachePath,
      fetchImpl: fetch,
    });
  } catch (e) {
    exit(3, `error: ${e.message}`);
  }
}

function defaultDataUrl(name) {
  return `https://tokenwatch.wyrdwerk.com/${name}`;
}

function isTTY() {
  return process.stdout.isTTY === true;
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] || (isTTY() ? 'help' : 'help');
  const rest = argv.slice(sub === 'help' || sub === '--help' || sub === '-h' ? 0 : 1);

  const { values, positionals } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      jsonl: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      org: { type: 'string' },
      provider: { type: 'string' },
      search: { type: 'string' },
      sort: { type: 'string' },
      order: { type: 'string', default: 'asc' },
      limit: { type: 'string' },
      zdr: { type: 'boolean', default: false },
      promo: { type: 'boolean', default: false },
      sub: { type: 'boolean', default: false },
      'min-context': { type: 'string' },
      'min-output': { type: 'string' },
      quantization: { type: 'string' },
      'cache-read': { type: 'boolean', default: false },
      'cache-write': { type: 'boolean', default: false },
      tokens: { type: 'string' },
      mix: { type: 'string' },
      'api-url': { type: 'string' },
      'data-url': { type: 'string' },
      ttl: { type: 'string' },
      'cache-root': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    tokens: true,
    allowPositionals: true,
    args: rest,
  });

  const opts = {
    apiUrl: values['api-url'],
    dataUrl: values['data-url'],
    ttl: values.ttl,
    cacheRoot: values['cache-root'],
  };

  const noColor = values['no-color'] || !!process.env.NO_COLOR || !isTTY();
  const out = values.json ? 'json' : values.jsonl ? 'jsonl' : (isTTY() ? 'table' : 'json');
  const wantJson = out === 'json' || out === 'jsonl';

  if (sub === 'refresh') {
    const o = { ...opts, ttl: '0' };
    const { meta } = await getData(o, 'text');
    process.stdout.write(renderJson({ refreshed: true, generatedAt: meta.generatedAt, fetchedAt: meta.fetchedAt }) + '\n');
    return;
  }

  if (sub === 'tui') {
    // Ensure the text snapshot is fetched/cached before handing off, so the
    // TUI receives an existing cache file and never has to fetch itself.
    await getData(opts, 'text');
    const cdir = cacheDir({ cacheRoot: opts.cacheRoot });
    const cachePath = join(cdir, SNAPSHOT_NAMES.text);
    const exe = 'tokenwatch-tui';
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(exe, ['--data', cachePath, ...(values['data-url'] ? ['--data-url', values['data-url']] : [])], { stdio: 'inherit' });
    if (res.error && res.error.code === 'ENOENT') {
      process.stdout.write('tokenwatch-tui is not installed. Install it with:\n  npm i -g tokenwatch-tui\nor run ad-hoc with:\n  npx tokenwatch-tui\n');
      exit(0);
    }
    exit(res.status ?? 0);
  }

  if (sub === 'stats') {
    const { data } = await getData(opts, 'text');
    const summary = {
      generated_at: data.generated_at,
      models: data.models.length,
      providers: (data.providers || []).length,
      orgs: new Set(data.models.map(m => m.org)).size,
      zdr: data.models.filter(m => m.zdr).length,
      subscription: data.models.filter(m => m.subscription).length,
    };
    process.stdout.write((wantJson ? (out === 'jsonl' ? renderJsonl([summary]) : renderJson(summary)) : renderTable([summary], { fields: ['models','providers','orgs','zdr'], noColor })) + '\n');
    return;
  }

  if (sub === 'images' || sub === 'videos') {
    const { data } = await getData(opts, sub);
    let models = data.models;
    if (values.org) models = models.filter(m => m.org === values.org.toLowerCase());
    if (values.provider) models = models.filter(m => m.provider === values.provider.toLowerCase());
    if (values.search) {
      const q = values.search.toLowerCase();
      models = models.filter(m => m.id.toLowerCase().includes(q) || (m.org || '').toLowerCase().includes(q));
    }
    const total = models.length;
    if (total === 0) exit(4, 'no results');
    process.stdout.write((wantJson ? (out === 'jsonl' ? renderJsonl(models) : renderJson({ generated_at: data.generated_at, total, models })) : renderTable(models, { fields: ['id','org','provider'], noColor })) + '\n');
    return;
  }
  if (sub === 'providers') {
    const modelArg = positionals[0];
    if (!modelArg) exit(2, 'usage: tokenwatch providers <model> [--tokens N --mix in,cr,out]');
    const target = canonicalId(modelArg);
    const { data } = await getData(opts, 'text');
    const matches = data.models.filter(m => canonicalId(m.id) === target);
    if (matches.length === 0) exit(4, `no providers for ${target}`);
    const tokenCount = values.tokens ? Number(values.tokens) : 1_000_000;
    const mix = parseMix(values.mix);
    const totalTokens = tokenCount;
    const t = {
      input: totalTokens * mix.inputPct / 100,
      output: totalTokens * mix.outputPct / 100,
      cacheRead: totalTokens * mix.cacheReadPct / 100,
      cacheWrite: 0, amortizeN: 1,
      ...mix,
    };
    const ranked = matches.map(m => {
      const cost = costFor(m.pricing, t);
      const blended = blendedCostFor(m.pricing, t);
      return { provider: m.provider, id: m.id, zdr: !!m.zdr, subscription: !!m.subscription, cost, blended_cost: blended };
    }).filter(r => r.cost != null).sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
    process.stdout.write((wantJson ? (out === 'jsonl' ? renderJsonl(ranked) : renderJson({ canonicalId: target, generated_at: data.generated_at, providers: ranked })) : renderTable(ranked, { fields: ['provider','cost','blended_cost','zdr'], noColor })) + '\n');
    return;
  }

  // default: models
  const { data } = await getData(opts, 'text');
  let models = filterModels(data.models, {
    org: values.org, provider: values.provider, search: values.search,
    minContext: values['min-context'] ? Number(values['min-context']) : undefined,
    minOutput: values['min-output'] ? Number(values['min-output']) : undefined,
    quantization: values.quantization,
    cacheRead: values['cache-read'], cacheWrite: values['cache-write'],
    promo: values.promo, zdr: values.zdr, sub: values.sub,
  });
  models = sortModels(models, values.sort, values.order);
  const total = models.length;
  if (values.limit) models = models.slice(0, Number(values.limit));
  if (total === 0) exit(4, 'no results');
  if (wantJson) {
    process.stdout.write((out === 'jsonl' ? renderJsonl(models) : renderJson({ generated_at: data.generated_at, total, models })) + '\n');
  } else {
    process.stdout.write(renderTable(models, { fields: ['id','org','provider','input','output','cache_read','zdr'], noColor }) + '\n');
  }
}

const HELP_TEXT = `tokenwatch — TokenWatch pricing CLI

Usage: tokenwatch <command> [options]
  models [--org X --provider X --search X --sort K --order asc|desc --limit N --zdr --promo --sub]
  providers <model> [--tokens N --mix in,cr,out]
  stats
  images | videos [--org X --provider X --search X]
  refresh
  tui

Global: --json | --jsonl | --no-color | --data-url URL | --ttl MIN | --cache-root DIR
Exit codes: 0 ok, 1 error, 2 usage, 3 network/cache, 4 no results
`;

main().catch(e => exit(1, `error: ${e.message}`));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../tokenwatch-cli && node --test test/cli.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite**

Run: `cd ../tokenwatch-cli && node --test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add src/cli/index.js test/cli.test.js
git commit -m "feat(cli): dispatcher with models/providers/stats/images/videos/refresh/tui"
```

---

## Task 8: README and final verification

**Files:**
- Modify: `../tokenwatch-cli/README.md`

- [ ] **Step 1: Write the full README**

Replace `../tokenwatch-cli/README.md`:
```markdown
# tokenwatch

Terminal CLI for [TokenWatch](https://tokenwatch.wyrdwerk.com) pay-as-you-go LLM pricing data. Fetches the published pricing snapshot once, caches it locally (~2h TTL matching the site's CI cadence), and answers all filter/search/cost queries against the local cache — zero further network calls per query.

## Install

```sh
npm i -g github:WyrdWerk/tokenwatch-cli
```

Requires Node ≥ 20. Zero dependencies.

## Usage

```sh
tokenwatch models --org deepseek --sort input
tokenwatch models --zdr --json
tokenwatch providers glm-5.2 --tokens 1000000 --mix 70,20,10 --json
tokenwatch stats
tokenwatch images --search flux
tokenwatch refresh
```

## Headless / agent use

When stdout is not a TTY the CLI defaults to non-interactive behavior: no prompts, `--json` recommended, progress to stderr, data to stdout, stable exit codes (0 ok, 1 error, 2 usage, 3 network/cache, 4 no results). Honors `NO_COLOR` and `--no-color`.

## Data source

Default: `https://tokenwatch.wyrdwerk.com/pricing.json` (the published snapshot, regenerated every ~2h by CI). Override with `--data-url` (accepts `http(s)://`, `file://`, or a local path). The `/api/v1` HTTP API remains the supported query contract; the snapshot is the pragmatic bulk bootstrap.

## Cache

`~/.cache/tokenwatch/` (or `$XDG_CACHE_HOME`, `$LOCALAPPDATA` on Windows). Freshness records both the snapshot's `generated_at` and the local fetch time.
```

- [ ] **Step 2: Run the full test suite once more**

Run: `cd ../tokenwatch-cli && node --test`
Expected: all tests PASS.

- [ ] **Step 3: Smoke-test the bin directly**

Run:
```bash
cd ../tokenwatch-cli
node src/cli/index.js models --data-url file://$(pwd)/fixtures/pricing.sample.json --json | head -c 200
```
Expected: JSON beginning `{\n  "generated_at": ...`.

- [ ] **Step 4: Commit**

Run:
```bash
cd ../tokenwatch-cli
git add README.md
git commit -m "docs: full README with usage, headless contract, and data source"
```

---

## Self-Review (run by the plan author, not dispatched)

**1. Spec coverage:**
- Two-package split → Global Constraints + out-of-scope TUI ✓
- Fetch-once, query-locally → Task 6 cache + Task 7 single loadSnapshot per invocation ✓
- `--json`/`--jsonl` agent mode → Task 5 renderers + Task 7 wiring ✓
- TTY auto-detection, no prompts → Task 7 `isTTY()` + exit codes ✓
- Snapshot default + `--data-url` override → Task 7 `defaultDataUrl` + `--data-url` ✓
- 120-min TTL → Task 6 default + Task 7 ✓
- Cost/canonicalization parity → Tasks 2–3 verbatim ports ✓
- API filter/sort parity → Task 4 mirrors `[[route]].js` 239–300 ✓
- Image/video catalogs → Task 7 images/videos subcommands ✓
- Exit codes → Task 7 ✓
- Open Q5 (repo location) → resolved in Global Constraints (separate repo) ✓
- Open Q3 (text model field names) → fixture in Task 4 exercises the real fields; any field mismatch fails the parity tests ✓

**2. Placeholder scan:** no TBD/TODO; all code blocks are complete.

**3. Type consistency:** `filterModels(models, opts)` and `sortModels(models, sort, order)` signatures match between Task 4 (defines) and Task 7 (consumes). `costFor(pricing, tokens)` token shape matches between Task 3 and Task 7. `loadSnapshot({ dataUrl, ttlMinutes, fetchImpl, cachePath })` matches between Task 6 and Task 7. `renderJson/renderJsonl/renderTable` and `supportsColor` match between Task 5 and Task 7. ✓

No gaps found.
