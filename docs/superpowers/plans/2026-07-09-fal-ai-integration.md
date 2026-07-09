# fal.ai Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fal.ai as a Tier-1 direct provider for image and video catalogs — ~310 new models (167 image + 143 video) with clean per-output-unit pricing, merged into the existing image/video pipelines with Tier-1 precedence over OpenRouter.

**Architecture:** A new sidecar fetcher `scripts/fetch-fal.mjs` (mirroring `fetch-modelsdev.mjs`'s export-a-function pattern) fetches fal's paginated `/v1/models` + batched `/v1/models/pricing`, filters to active image/video endpoints with includable pricing units, maps to our schema, and exposes `fetchFalImageModels()` / `fetchFalVideoModels()`. The existing `fetch-images.mjs` / `fetch-videos.mjs` call these, prepend fal rows to their OpenRouter arrays, and run `dedupModels` (new for these files — first model-level dedup here). A new `falCanonicalId()` in `scripts/lib.mjs` handles fal's deeply-nested endpoint IDs.

**Tech Stack:** Pure Node ESM, zero dependencies. `node:test` for tests. fal API: `Authorization: Key <FAL_API_KEY>` header (stored in GitHub secrets).

## Global Constraints

- **Auth:** `Authorization: Key ${process.env.FAL_API_KEY}` header. Fetch locally in `fetch-fal.mjs` (lib.mjs's `fetchJson` doesn't support custom headers — don't modify the shared helper).
- **Non-fatal:** if fal fetch fails, log warning, return `[]` — image/video pipelines continue without fal data (mirror `fetch-modelsdev.mjs` pattern).
- **Only active + priced models:** filter `metadata.status === 'active'`, require a paid pricing entry in an includable unit. Exclude the 770 free/unpriced endpoints and all non-active.
- **Pricing units included:** `images`, `megapixels`, `processed megapixels` (image); `seconds`, `5 seconds` (÷5), `minutes` (÷60) (video). **Exclude:** `compute seconds`, `units`, `credits`, `videos` (flat per-video, no duration), `generations`, token-based, empty.
- **`falCanonicalId` preserves model identity** from nested paths — never collapse `kling-video/v3/pro/image-to-video` to just `image-to-video`. Drop only pure modality suffixes (`image-to-video`, `text-to-video`, `reference-to-video`, `edit`, `upscale`) when they're the LAST segment.
- **Org fallback:** `FAL_ORG_MAP` for top ~20 families (flux→black-forest-labs, kling-video→kuaishou, etc.); `fal` for the long tail.
- **Omit `supported_durations`/`supported_resolutions`** for fal video models — fal doesn't expose them; UI handles null.
- **Tier-1 precedence:** fal rows prepended to model arrays → first-seen-wins in `dedupModels`.
- **Commit convention:** `feat(fal):` / `test(fal):` / `docs(fal):` / `chore(fal):` prefixes.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `scripts/fetch-fal.mjs` | Sidecar fetcher: paginated `/v1/models`, batched `/v1/models/pricing`, filter, map to image/video schema. Exports `fetchFalImageModels()`, `fetchFalVideoModels()`. | NEW |
| `scripts/lib.mjs` | Add `falCanonicalId(endpointId)` + `FAL_ORG_MAP` constant. | MODIFY |
| `scripts/fetch-images.mjs` | Call `fetchFalImageModels()`, prepend to models array, run `dedupModels`. | MODIFY |
| `scripts/fetch-videos.mjs` | Call `fetchFalVideoModels()`, prepend to models array, run `dedupModels`. | MODIFY |
| `.github/workflows/refresh-pricing.yml` | Add `fetch:fal` step (before fetch:images/fetch:videos) with `FAL_API_KEY` env. | MODIFY |
| `package.json` | Add `"fetch:fal"` script; update `fetch:all` + `build:prod`. | MODIFY |
| `test/fal-canonicalization.test.mjs` | Unit tests for `falCanonicalId`. | NEW |
| `test/parity.test.mjs` | Add fal coverage floor (≥200 fal image+video models). | MODIFY |
| `AGENTS.md` | Document fal as Tier-1 image/video provider. | MODIFY |

---

### Task 1: `falCanonicalId` + `FAL_ORG_MAP` in lib.mjs

**Files:**
- Modify: `scripts/lib.mjs` (add after the `dedupModels` function, ~line 176)
- Test: `test/fal-canonicalization.test.mjs`

**Interfaces:**
- Consumes: `canonicalId` from `shared/normalize.mjs` (already imported)
- Produces:
  - `falCanonicalId(endpointId: string): string` — preserves model identity from nested paths
  - `FAL_ORG_MAP: Object` — endpoint-prefix → org slug mapping

- [ ] **Step 1: Write the failing tests**

Create `test/fal-canonicalization.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { falCanonicalId, FAL_ORG_MAP } from '../scripts/lib.mjs';

// ── Model identity preserved from nested paths ──

test('falCanonicalId preserves kling-video version+tier, drops modality', () => {
  assert.equal(falCanonicalId('fal-ai/kling-video/v3/pro/image-to-video'), 'kling-video-v3-pro');
});

test('falCanonicalId preserves kling-video standard tier', () => {
  assert.equal(falCanonicalId('fal-ai/kling-video/v3/standard/image-to-video'), 'kling-video-v3-standard');
});

test('falCanonicalId preserves flux version', () => {
  assert.equal(falCanonicalId('fal-ai/flux-pro/v1.1-ultra'), 'flux-pro-v1.1-ultra');
});

test('falCanonicalId handles simple flat endpoint', () => {
  assert.equal(falCanonicalId('fal-ai/flux/schnell'), 'flux-schnell');
});

test('falCanonicalId keeps org prefix for non-fal-ai namespaces', () => {
  assert.equal(falCanonicalId('bytedance/seedance-2.0/image-to-video'), 'bytedance-seedance-2.0');
});

test('falCanonicalId drops trailing edit suffix', () => {
  assert.equal(falCanonicalId('fal-ai/nano-banana-pro/edit'), 'nano-banana-pro');
});

test('falCanonicalId drops trailing upscale suffix', () => {
  assert.equal(falCanonicalId('fal-ai/seedvr/upscale/image'), 'seedvr');
});

test('falCanonicalId drops text-to-video modality', () => {
  assert.equal(falCanonicalId('fal-ai/kling-video/v3/pro/text-to-video'), 'kling-video-v3-pro');
});

test('falCanonicalId does NOT drop non-modality last segments', () => {
  // 'turbo' is a variant, not a modality — must be preserved
  assert.equal(falCanonicalId('fal-ai/wan/v2.2-a14b/image-to-video/turbo'), 'wan-v2.2-a14b-turbo');
});

// ── FAL_ORG_MAP ──

test('FAL_ORG_MAP maps flux to black-forest-labs', () => {
  assert.equal(FAL_ORG_MAP['flux'], 'black-forest-labs');
});

test('FAL_ORG_MAP maps kling-video to kuaishou', () => {
  assert.equal(FAL_ORG_MAP['kling-video'], 'kuaishou');
});

test('FAL_ORG_MAP has entries for top families', () => {
  // At least 15 families mapped
  assert.ok(Object.keys(FAL_ORG_MAP).length >= 15, `only ${Object.keys(FAL_ORG_MAP).length} entries`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/fal-canonicalization.test.mjs`
Expected: FAIL — `falCanonicalId` and `FAL_ORG_MAP` not exported from lib.mjs.

- [ ] **Step 3: Add `falCanonicalId` and `FAL_ORG_MAP` to `scripts/lib.mjs`**

After the `dedupModels` function (line ~176), add:

```js

// ── fal.ai helpers ──
// fal's endpoint IDs are deeply nested (e.g. 'fal-ai/kling-video/v3/pro/image-to-video')
// and carry model identity in every path segment. The shared canonicalId (built for
// text models) keeps only the last segment, which would collapse all kling variants
// to 'image-to-video'. falCanonicalId preserves the model+version+tier and drops
// only pure modality suffixes (image-to-video, text-to-video, edit, upscale, etc.).

const FAL_MODALITY_SUFFIXES = ['image-to-video', 'text-to-video', 'reference-to-video', 'video-to-video', 'audio-to-video', 'edit', 'upscale', 'image', 'video'];

/**
 * Compute a canonical ID for a fal.ai endpoint, preserving model identity.
 *
 * Strips the 'fal-ai/' namespace prefix (but keeps other org prefixes like
 * 'bytedance/', 'openai/', 'xai/'). Drops trailing pure-modality segments.
 * Joins remaining segments with '-'.
 *
 * Examples:
 *   'fal-ai/kling-video/v3/pro/image-to-video' → 'kling-video-v3-pro'
 *   'fal-ai/flux-pro/v1.1-ultra'               → 'flux-pro-v1.1-ultra'
 *   'bytedance/seedance-2.0/image-to-video'    → 'bytedance-seedance-2.0'
 *   'fal-ai/nano-banana-pro/edit'              → 'nano-banana-pro'
 *   'fal-ai/wan/v2.2-a14b/image-to-video/turbo'→ 'wan-v2.2-a14b-turbo' (turbo kept)
 */
export function falCanonicalId(endpointId) {
  let id = endpointId;
  // Strip 'fal-ai/' namespace prefix only (keep bytedance/, openai/, xai/, etc.)
  if (id.startsWith('fal-ai/')) id = id.slice('fal-ai/'.length);
  // Split into segments, drop trailing modality segments
  const segments = id.split('/');
  while (segments.length > 1 && FAL_MODALITY_SUFFIXES.includes(segments[segments.length - 1])) {
    segments.pop();
  }
  return segments.join('-').toLowerCase();
}

/**
 * Map from fal model family (first segment after fal-ai/) to the real model org.
 * Built from the top ~20 families by endpoint count. Long-tail families fall back
 * to 'fal' as org (set in fetch-fal.mjs).
 */
export const FAL_ORG_MAP = {
  'flux': 'black-forest-labs',
  'flux-pro': 'black-forest-labs',
  'flux-2': 'black-forest-labs',
  'kling-video': 'kuaishou',
  'kling': 'kuaishou',
  'nano-banana': 'google',
  'nano-banana-2': 'google',
  'nano-banana-pro': 'google',
  'ideogram': 'ideogram',
  'pixverse': 'pixsocial',
  'minimax': 'minimax',
  'wan': 'alibaba',
  'wan-i2v': 'alibaba',
  'wan-t2v': 'alibaba',
  'ltx-video': 'lightricks',
  'seedance': 'bytedance',
  'veo': 'google',
  'veo3': 'google',
  'veo3.1': 'google',
  'recraft': 'recraft',
  'vidu': 'shengshu',
  'pika': 'pika',
  'hunyuan-video': 'tencent',
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/fal-canonicalization.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.mjs test/fal-canonicalization.test.mjs
git commit -m "feat(fal): add falCanonicalId + FAL_ORG_MAP to scripts/lib.mjs

falCanonicalId preserves model identity from fal's deeply-nested endpoint
IDs (fal-ai/kling-video/v3/pro/image-to-video → kling-video-v3-pro),
dropping only pure-modality suffixes. The shared canonicalId would have
collapsed all variants to 'image-to-video'. FAL_ORG_MAP covers top ~23
families; long tail falls back to 'fal'. 12 unit tests."
```

---

### Task 2: `scripts/fetch-fal.mjs` — sidecar fetcher

**Files:**
- Create: `scripts/fetch-fal.mjs`

**Interfaces:**
- Consumes: `falCanonicalId`, `FAL_ORG_MAP` from `./lib.mjs`
- Produces:
  - `fetchFalImageModels(): Promise<Array>` — returns image-schema model objects
  - `fetchFalVideoModels(): Promise<Array>` — returns video-schema model objects
  - Both return `[]` on failure (non-fatal)

- [ ] **Step 1: Write `scripts/fetch-fal.mjs`**

```js
/**
 * scripts/fetch-fal.mjs — sidecar fetcher for fal.ai image + video pricing.
 *
 * Fetches fal's /v1/models (paginated) + /v1/models/pricing (batched), filters
 * to active image/video endpoints with includable per-output-unit pricing, and
 * maps to our image/video schema. Exports fetchFalImageModels() and
 * fetchFalVideoModels(), consumed by fetch-images.mjs / fetch-videos.mjs.
 *
 * Non-fatal: on any failure, logs a warning and returns [] (image/video
 * pipelines continue without fal data). Mirrors fetch-modelsdev.mjs pattern.
 *
 * Auth: Authorization: Key ${FAL_API_KEY} header. Key from env (GitHub secret
 * in CI; set FAL_API_KEY locally to test).
 */

import { falCanonicalId, FAL_ORG_MAP } from './lib.mjs';

const FAL_MODELS_URL = 'https://api.fal.ai/v1/models';
const FAL_PRICING_URL = 'https://api.fal.ai/v1/models/pricing';
const PRICING_BATCH_SIZE = 50; // fal accepts 1-50 endpoint_ids per call
const MAX_PAGES = 10; // safety cap on pagination

// Categories we care about
const IMAGE_CATEGORIES = new Set(['text-to-image', 'image-to-image']);
const VIDEO_CATEGORIES = new Set(['text-to-video', 'image-to-video', 'video-to-video', 'audio-to-video']);

// Pricing units we include (per spec DD-2)
const IMAGE_UNITS = new Set(['images', 'megapixels', 'processed megapixels']);
const VIDEO_UNITS_PER_SECOND = new Set(['seconds', '5 seconds', 'minutes']); // need conversion

/** Fetch all fal models with pagination. Returns [] on failure. */
async function fetchAllFalModels() {
  const key = process.env.FAL_API_KEY;
  if (!key) {
    console.warn('⚠ fal.ai: FAL_API_KEY not set — skipping fal fetch');
    return [];
  }
  const headers = { Authorization: 'Key ' + key, Accept: 'application/json' };
  const all = [];
  let cursor = '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = FAL_MODELS_URL + '?limit=500' + (cursor ? '&cursor=' + cursor : '');
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`fal /v1/models HTTP ${r.status}: ${await r.text().catch(()=>'')}`);
    const d = await r.json();
    if (!d.models || !d.models.length) break;
    all.push(...d.models);
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  return all;
}

/** Fetch pricing for a list of endpoint IDs (batched 50 per call). Returns Map<endpoint_id, price>. */
async function fetchPricingBatched(endpointIds, headers) {
  const priceMap = new Map();
  for (let i = 0; i < endpointIds.length; i += PRICING_BATCH_SIZE) {
    const batch = endpointIds.slice(i, i + PRICING_BATCH_SIZE);
    const url = FAL_PRICING_URL + '?endpoint_id=' + batch.map(encodeURIComponent).join(',');
    const r = await fetch(url, { headers });
    if (!r.ok) {
      console.warn(`⚠ fal pricing batch HTTP ${r.status} for ${batch.length} ids — skipping batch`);
      continue;
    }
    const d = await r.json();
    for (const p of (d.prices || [])) {
      priceMap.set(p.endpoint_id, p);
    }
  }
  return priceMap;
}

/** Extract org from endpoint_id via FAL_ORG_MAP, with 'fal' fallback. */
function orgFromFalEndpoint(endpointId) {
  let id = endpointId;
  if (id.startsWith('fal-ai/')) id = id.slice('fal-ai/'.length);
  const firstSeg = id.split('/')[0];
  // Try exact, then the family prefix (e.g. 'kling-video/v3/...' → 'kling-video')
  if (FAL_ORG_MAP[firstSeg]) return FAL_ORG_MAP[firstSeg];
  // Try progressively shorter prefixes for compound families
  for (const fam of Object.keys(FAL_ORG_MAP)) {
    if (firstSeg === fam || firstSeg.startsWith(fam + '-')) return FAL_ORG_MAP[fam];
  }
  // Non-fal-ai namespaces (bytedance/, openai/, xai/) → org from prefix
  if (endpointId.includes('/') && !endpointId.startsWith('fal-ai/')) {
    return endpointId.split('/')[0].toLowerCase();
  }
  return 'fal';
}

/** Convert a display_name to a clean name. fal display_names are already clean. */
function cleanName(displayName) {
  return (displayName || '').trim();
}

/** Build an image-schema model from a fal endpoint + price. Returns null if not includable. */
function buildImageModel(m, price) {
  const unit = price.unit;
  if (!IMAGE_UNITS.has(unit)) return null;
  const id = falCanonicalId(m.endpoint_id);
  const org = orgFromFalEndpoint(m.endpoint_id);
  let pricing;
  if (unit === 'images' || unit === 'processed megapixels' && false) {
    // 'images' = flat per-image
    pricing = [{ unit: 'image', variant: null, cost_per_unit: price.unit_price, cost_per_million: null }];
  } else {
    // 'megapixels' or 'processed megapixels' = per-MP
    pricing = [{ unit: 'megapixel', variant: null, cost_per_unit: price.unit_price, cost_per_million: price.unit_price }];
  }
  return {
    id,
    name: cleanName(m.metadata?.display_name) || id,
    org,
    provider: 'fal',
    output_modalities: ['image'],
    supported_parameters: null,
    pricing,
  };
}

/** Build a video-schema model from a fal endpoint + price. Returns null if not includable. */
function buildVideoModel(m, price) {
  const unit = price.unit;
  if (!VIDEO_UNITS_PER_SECOND.has(unit)) return null;
  let costPerSecond = price.unit_price;
  if (unit === '5 seconds') costPerSecond = price.unit_price / 5;
  else if (unit === 'minutes') costPerSecond = price.unit_price / 60;
  const id = falCanonicalId(m.endpoint_id);
  const org = orgFromFalEndpoint(m.endpoint_id);
  return {
    id,
    name: cleanName(m.metadata?.display_name) || id,
    org,
    provider: 'fal',
    supported_durations: [],
    supported_resolutions: [],
    pricing: [{ resolution: null, audio: null, cost_per_second: costPerSecond }],
  };
}

/** Core fetch+filter+map. Returns { imageModels, videoModels }. */
async function fetchFalModels() {
  const t0 = Date.now();
  const all = await fetchAllFalModels();
  if (!all.length) return { imageModels: [], videoModels: [] };

  const headers = { Authorization: 'Key ' + process.env.FAL_API_KEY, Accept: 'application/json' };

  // Filter to active image/video endpoints
  const candidates = all.filter(m =>
    m.metadata?.status === 'active' &&
    (IMAGE_CATEGORIES.has(m.metadata?.category) || VIDEO_CATEGORIES.has(m.metadata?.category))
  );

  // Fetch pricing for all candidates in batches
  const endpointIds = candidates.map(m => m.endpoint_id);
  const priceMap = await fetchPricingBatched(endpointIds, headers);

  // Build models — one model per (canonical id, pricing-unit) — dedup intra-fal by canonical id
  const imageById = new Map();
  const videoById = new Map();
  let skippedNoPrice = 0, skippedUnit = 0;
  for (const m of candidates) {
    const price = priceMap.get(m.endpoint_id);
    if (!price) { skippedNoPrice++; continue; }
    const isImage = IMAGE_CATEGORIES.has(m.metadata.category);
    const model = isImage ? buildImageModel(m, price) : buildVideoModel(m, price);
    if (!model) { skippedUnit++; continue; }
    const map = isImage ? imageById : videoById;
    // First-seen wins for intra-fal dedup (canonical id collision = same model, different endpoint)
    if (!map.has(model.id)) map.set(model.id, model);
  }

  console.log(`✓ fal.ai: ${imageById.size} image + ${videoById.size} video models (${all.length} fetched, ${skippedNoPrice} no pricing, ${skippedUnit} excluded unit) in ${Date.now() - t0}ms`);
  return { imageModels: [...imageById.values()], videoModels: [...videoById.values()] };
}

/** Public: fetch fal image models. Returns [] on failure. */
export async function fetchFalImageModels() {
  try {
    const { imageModels } = await fetchFalModels();
    return imageModels;
  } catch (err) {
    console.warn(`⚠ fal.ai image fetch failed — continuing without fal image data: ${err.message}`);
    return [];
  }
}

/** Public: fetch fal video models. Returns [] on failure. */
export async function fetchFalVideoModels() {
  try {
    const { videoModels } = await fetchFalModels();
    return videoModels;
  } catch (err) {
    console.warn(`⚠ fal.ai video fetch failed — continuing without fal video data: ${err.message}`);
    return [];
  }
}

// Allow `node scripts/fetch-fal.mjs` to run standalone for testing.
// Writes a sidecar /tmp/fal-image.json + /tmp/fal-video.json for inspection.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { imageModels, videoModels } = await fetchFalModels();
  const { writeFile } = await import('node:fs/promises');
  await writeFile('/tmp/fal-image.json', JSON.stringify(imageModels, null, 2));
  await writeFile('/tmp/fal-video.json', JSON.stringify(videoModels, null, 2));
  console.log(`  wrote /tmp/fal-image.json (${imageModels.length}) + /tmp/fal-video.json (${videoModels.length})`);
}
```

- [ ] **Step 2: Run standalone to verify it fetches and maps correctly**

Run: `FAL_API_KEY=467147ff-5624-4b16-b39c-0aa9b8ef8161:dcbf63031151f5b96f6a7b368f9fe4dc node scripts/fetch-fal.mjs`
Expected: console output like `✓ fal.ai: ~160 image + ~140 video models (... fetched, ... no pricing, ... excluded unit) in Xms` and writes the two /tmp JSON files.

- [ ] **Step 3: Verify the output schema matches our existing format**

Run:
```bash
node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/fal-image.json','utf8')); console.log('image count:', d.length); console.log('sample:', JSON.stringify(d[0], null, 2));"
node -e "const d=JSON.parse(require('fs').readFileSync('/tmp/fal-video.json','utf8')); console.log('video count:', d.length); console.log('sample:', JSON.stringify(d[0], null, 2));"
```
Expected: image count ~160, video count ~140. Sample schemas match our image/video-pricing.json shapes (verify `pricing` array keys).

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-fal.mjs
git commit -m "feat(fal): sidecar fetcher for fal.ai image + video pricing

Paginated /v1/models + batched /v1/models/pricing (50 ids/call). Filters
to active image/video endpoints with includable units (images/megapixels/
processed-megapixels for image; seconds/5-seconds/minutes for video).
compute-seconds/units/credits/videos/generations excluded per spec.

Exports fetchFalImageModels() + fetchFalVideoModels(), consumed by the
existing fetch-images/fetch-videos. Non-fatal: returns [] on failure."
```

---

### Task 3: Merge fal into `fetch-images.mjs` + add dedup

**Files:**
- Modify: `scripts/fetch-images.mjs`

**Interfaces:**
- Consumes: `fetchFalImageModels` from `./fetch-fal.mjs`, `dedupModels` from `./lib.mjs`
- Produces: `public/image-pricing.json` now includes fal image models (Tier-1 precedence)

- [ ] **Step 1: Add imports for fal + dedupModels**

At lines 24-27, the current import block:
```js
import {
  orgFromId, orgFromName, canonicalId, orgLookupKey, ORG_ALIASES,
  num, fetchJsonWithRetry, checkCoverageDrop, parseArgs,
} from './lib.mjs';
```
Change to add `dedupModels`:
```js
import {
  orgFromId, orgFromName, canonicalId, orgLookupKey, ORG_ALIASES,
  num, fetchJsonWithRetry, checkCoverageDrop, parseArgs, dedupModels,
} from './lib.mjs';
import { fetchFalImageModels } from './fetch-fal.mjs';
```

- [ ] **Step 2: Merge fal models + run dedup before the final assembly**

Find the section where `models` is built (after the OpenRouter fetch loop, before org enrichment at line 143). Read lines 135-165 to find the exact spot. Insert the fal merge + dedup right after the OpenRouter models array is fully built and BEFORE the org-enrichment pass:

```js
  // ── Merge fal.ai image models (Tier 1 — first-seen wins over OpenRouter) ──
  const falImageModels = await fetchFalImageModels();
  // Prepend fal rows so dedupModels gives them Tier-1 precedence
  const tieredModels = [...falImageModels, ...models];

  // Org enrichment (existing code at lines 143-158 — operates on tieredModels now)
```

Then, where `out` is assembled (line 161), change `models` to the deduped result:

```js
  const dedupedModels = dedupModels(tieredModels);
  console.log(`  Image models: ${models.length} OpenRouter + ${falImageModels.length} fal → ${dedupedModels.length} after dedup`);

  const out = {
    generated_at: new Date().toISOString(),
    models: dedupedModels,
  };
```

**Important:** the existing org-enrichment loop (lines 143-158) iterates over `models`. It should now iterate over `tieredModels` (or `dedupedModels` — either works since enrichment is idempotent). Read the actual loop and update the array reference.

- [ ] **Step 3: Run the fetcher and verify fal models appear**

Run: `FAL_API_KEY=467147ff-5624-4b16-b39c-0aa9b8ef8161:dcbf63031151f5b96f6a7b368f9fe4dc npm run fetch:images`
Expected: console shows the fal fetch line + the merge log line. Verify `public/image-pricing.json` has fal models:

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('public/image-pricing.json','utf8')); const fal=d.models.filter(m=>m.provider==='fal'); console.log('fal image models:', fal.length, 'of', d.models.length, 'total'); console.log('sample:', JSON.stringify(fal[0], null, 2));"
```
Expected: ~160 fal image models, sample schema correct.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-images.mjs public/image-pricing.json
git commit -m "feat(fal): merge fal image models with Tier-1 precedence

Prepends fal rows before OpenRouter models, runs dedupModels (first model-
level dedup in this file). fal models win on canonical-id collision."
```

---

### Task 4: Merge fal into `fetch-videos.mjs` + add dedup

**Files:**
- Modify: `scripts/fetch-videos.mjs`

**Interfaces:**
- Consumes: `fetchFalVideoModels` from `./fetch-fal.mjs`, `dedupModels` from `./lib.mjs`
- Produces: `public/video-pricing.json` now includes fal video models (Tier-1 precedence)

- [ ] **Step 1: Add imports for fal + dedupModels**

At lines 24-27, add `dedupModels` to the lib.mjs import and add the fal import:
```js
import {
  orgFromId, orgFromName, canonicalId, orgLookupKey, ORG_ALIASES,
  num, fetchJsonWithRetry, checkCoverageDrop, parseArgs, dedupModels,
} from './lib.mjs';
import { fetchFalVideoModels } from './fetch-fal.mjs';
```

- [ ] **Step 2: Merge fal models + run dedup before final assembly**

Read lines 136-165 to find where `models` is built and `out` is assembled. Insert the fal merge (mirroring Task 3 Step 2):

```js
  // ── Merge fal.ai video models (Tier 1 — first-seen wins over OpenRouter) ──
  const falVideoModels = await fetchFalVideoModels();
  const tieredModels = [...falVideoModels, ...models];
```

Update the org-enrichment loop to iterate `tieredModels`. At the `out` assembly:

```js
  const dedupedModels = dedupModels(tieredModels);
  console.log(`  Video models: ${models.length} OpenRouter + ${falVideoModels.length} fal → ${dedupedModels.length} after dedup`);

  const out = {
    generated_at: new Date().toISOString(),
    models: dedupedModels,
  };
```

- [ ] **Step 3: Run the fetcher and verify fal models appear**

Run: `FAL_API_KEY=467147ff-5624-4b16-b39c-0aa9b8ef8161:dcbf63031151f5b96f6a7b368f9fe4dc npm run fetch:videos`
Expected: console shows fal fetch + merge log. Verify:

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('public/video-pricing.json','utf8')); const fal=d.models.filter(m=>m.provider==='fal'); console.log('fal video models:', fal.length, 'of', d.models.length, 'total'); console.log('sample:', JSON.stringify(fal[0], null, 2));"
```
Expected: ~140 fal video models, sample schema correct.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-videos.mjs public/video-pricing.json
git commit -m "feat(fal): merge fal video models with Tier-1 precedence

Prepends fal rows before OpenRouter models, runs dedupModels (first model-
level dedup in this file). fal models win on canonical-id collision."
```

---

### Task 5: CI workflow + package.json

**Files:**
- Modify: `.github/workflows/refresh-pricing.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: `FAL_API_KEY` GitHub secret
- Produces: CI `refresh` job fetches fal before images/videos; `npm run fetch:fal` available locally

- [ ] **Step 1: Add `fetch:fal` to package.json scripts**

At lines 5-14, add the new script and update `fetch:all` + `build:prod`:
```json
  "scripts": {
    "fetch": "node scripts/fetch-pricing.mjs",
    "fetch:fal": "node scripts/fetch-fal.mjs",
    "fetch:images": "node scripts/fetch-images.mjs",
    "fetch:videos": "node scripts/fetch-videos.mjs",
    "fetch:all": "node scripts/fetch-pricing.mjs && node scripts/fetch-fal.mjs && node scripts/fetch-images.mjs && node scripts/fetch-videos.mjs",
    "serve": "npx --yes serve public -l 3000",
    "build:prod": "node scripts/fetch-pricing.mjs && node scripts/fetch-fal.mjs && node scripts/fetch-images.mjs && node scripts/fetch-videos.mjs && echo 'Static site in ./public'",
    "test": "node --test test/*.test.mjs",
    "bust:cache": "node scripts/bust-cache.mjs"
  },
```

Note: `fetch:fal` is standalone (writes /tmp files for inspection), but in the `fetch:all`/`build:prod` chains it runs before images/videos. The image/video fetchers call `fetchFalImageModels()`/`fetchFalVideoModels()` internally, which re-fetch — this is slightly redundant for the standalone `fetch:fal` but harmless (fal fetch is ~3s). The standalone script is mainly for local debugging.

**Important refinement:** Actually, `fetch:images` and `fetch:videos` each independently call `fetchFalModels()` internally (which fetches the full catalog once). To avoid double-fetching fal when running `fetch:all`, consider having `fetch-fal.mjs` cache to `/tmp/fal-cache.json` on first fetch and read from cache on subsequent calls within the same process chain. BUT — since `fetch:images` and `fetch:videos` are separate Node processes, the cache won't persist. **Accept the double-fetch** (6s total vs 3s) for simplicity — it's still fast. Document this in the commit.

- [ ] **Step 2: Add `fetch:fal` step + `FAL_API_KEY` env to CI workflow**

In `.github/workflows/refresh-pricing.yml`, find the `refresh` job's fetch sequence (lines 42-49). Insert a new fal step BEFORE the image/video fetch steps. The current sequence:
```yml
      - name: Fetch & normalize text pricing
        run: node scripts/fetch-pricing.mjs

      - name: Fetch & normalize image pricing
        run: node scripts/fetch-images.mjs

      - name: Fetch & normalize video pricing
        run: node scripts/fetch-videos.mjs
```

Note: fal is fetched automatically inside fetch-images/fetch-videos (they call the exported functions), so a separate `fetch:fal` CI step is NOT needed for data freshness. BUT the env var must be available to those steps. Add `FAL_API_KEY` as an env var on the image + video fetch steps:
```yml
      - name: Fetch & normalize image pricing
        env:
          FAL_API_KEY: ${{ secrets.FAL_API_KEY }}
        run: node scripts/fetch-images.mjs

      - name: Fetch & normalize video pricing
        env:
          FAL_API_KEY: ${{ secrets.FAL_API_KEY }}
        run: node scripts/fetch-videos.mjs
```

This is the minimal change — no new step, just env injection on the two steps that need it.

- [ ] **Step 3: Verify locally**

Run: `npm test` (confirm no test breakage from package.json change — tests don't run fetchers)
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json .github/workflows/refresh-pricing.yml
git commit -m "chore(fal): add fetch:fal script + FAL_API_KEY env to CI

fetch:images and fetch:videos call fetchFalModels() internally, so no
separate CI step needed — just inject FAL_API_KEY env into those two
steps. fetch:fal script available locally for standalone debugging."
```

---

### Task 6: Parity guard + docs

**Files:**
- Modify: `test/parity.test.mjs`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `image-pricing.json` + `video-pricing.json` with fal models
- Produces: regression guards + docs

- [ ] **Step 1: Add fal coverage floor to `test/parity.test.mjs`**

After the benchmark guards (end of file), add:

```js

// ── fal.ai integration regression guards ──────────────────────────────────────

test('fal.ai image models present in image-pricing.json (≥100)', async () => {
  const data = JSON.parse(await readFile(join(__dirname, '..', 'public', 'image-pricing.json'), 'utf-8'));
  const fal = data.models.filter((m) => m.provider === 'fal');
  assert.ok(fal.length >= 100,
    `fal image models ${fal.length} below 100 floor — fal fetch may have regressed`);
});

test('fal.ai video models present in video-pricing.json (≥100)', async () => {
  const data = JSON.parse(await readFile(join(__dirname, '..', 'public', 'video-pricing.json'), 'utf-8'));
  const fal = data.models.filter((m) => m.provider === 'fal');
  assert.ok(fal.length >= 100,
    `fal video models ${fal.length} below 100 floor — fal fetch may have regressed`);
});

test('fal image models have valid pricing schema', async () => {
  const data = JSON.parse(await readFile(join(__dirname, '..', 'public', 'image-pricing.json'), 'utf-8'));
  const fal = data.models.filter((m) => m.provider === 'fal');
  for (const m of fal.slice(0, 30)) {
    assert.ok(Array.isArray(m.pricing) && m.pricing.length > 0, `${m.id} has no pricing array`);
    for (const p of m.pricing) {
      assert.ok(['image', 'megapixel'].includes(p.unit), `${m.id} invalid unit ${p.unit}`);
      assert.equal(typeof p.cost_per_unit, 'number', `${m.id} cost_per_unit not a number`);
    }
  }
});

test('fal video models have valid per-second pricing', async () => {
  const data = JSON.parse(await readFile(join(__dirname, '..', 'public', 'video-pricing.json'), 'utf-8'));
  const fal = data.models.filter((m) => m.provider === 'fal');
  for (const m of fal.slice(0, 30)) {
    assert.ok(Array.isArray(m.pricing) && m.pricing.length > 0, `${m.id} has no pricing array`);
    for (const p of m.pricing) {
      assert.equal(typeof p.cost_per_second, 'number', `${m.id} cost_per_second not a number`);
    }
  }
});
```

- [ ] **Step 2: Run parity tests**

Run: `node --test test/parity.test.mjs`
Expected: all tests pass including the 4 new fal guards.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Update AGENTS.md**

In the `## Image & Video Generation` section, after the `### Video pipeline` subsection, add a new subsection:

```markdown
### fal.ai pipeline (`scripts/fetch-fal.mjs`)
- Source: `GET /v1/models` (paginated, 500/page) + `GET /v1/models/pricing?endpoint_id=...` (batched 50/call)
- Auth: `Authorization: Key ${FAL_API_KEY}` (GitHub secret `FAL_API_KEY`)
- Filters: `metadata.status === 'active'`, category in image/video sets, paid pricing in includable unit
- Includable units: `images`/`megapixels`/`processed megapixels` (image); `seconds`/`5 seconds`(÷5)/`minutes`(÷60) (video)
- Excluded: `compute seconds` (GPU-time), `videos` (flat per-video, no duration data), `generations`, `units`/`credits`/token-based, 770 free/unpriced endpoints
- Canonicalization: `falCanonicalId()` preserves model identity from nested paths (`fal-ai/kling-video/v3/pro/image-to-video` → `kling-video-v3-pro`); drops only pure-modality suffixes
- Org extraction: `FAL_ORG_MAP` for top ~23 families; `fal` fallback for long tail
- Non-fatal: returns `[]` on failure; image/video pipelines continue without fal data
- Merge: fal rows prepended → `dedupModels` gives Tier-1 precedence (first-seen wins over OpenRouter)
- Coverage: ~167 image + ~143 video models (~310 total before dedup)
```

Also update the `## Development` section to add `npm run fetch:fal` and the `## Files to know` table to add `scripts/fetch-fal.mjs`:

```markdown
| `scripts/fetch-fal.mjs` | Sidecar fetcher for fal.ai image + video pricing — paginated `/v1/models` + batched `/v1/models/pricing`, filters to active priced endpoints, maps to schema. Exports `fetchFalImageModels()` / `fetchFalVideoModels()`. |
```

- [ ] **Step 5: Commit**

```bash
git add test/parity.test.mjs AGENTS.md
git commit -m "test(fal): add coverage-floor parity guards + AGENTS.md docs

Four regression guards: ≥100 fal image models, ≥100 fal video models,
valid image pricing schema (unit in image/megapixel), valid video
per-second pricing. Documents fal pipeline, canonicalization, and
Tier-1 merge in AGENTS.md."
```

---

### Task 7: Local verification + review prep

**Files:**
- None (verification only)

- [ ] **Step 1: Run full fetch + test**

Run:
```bash
FAL_API_KEY=467147ff-5624-4b16-b39c-0aa9b8ef8161:dcbf63031151f5b96f6a7b368f9fe4dc npm run fetch:images
FAL_API_KEY=467147ff-5624-4b16-b39c-0aa9b8ef8161:dcbf63031151f5b96f6a7b368f9fe4dc npm run fetch:videos
npm test
npm run bust:cache
npm run serve
```
Expected: all fetchers succeed, all tests pass, server running on localhost:3000.

- [ ] **Step 2: Manual verification checklist**

Open `http://localhost:3000/image.html` and verify:
- [ ] fal models appear in the table (filter by provider "fal")
- [ ] fal image models have correct pricing (per-image or per-megapixel)
- [ ] cost computation works on fal rows (enter image count, see cost)
- [ ] mobile card layout intact
- [ ] existing OpenRouter image models still present

Open `http://localhost:3000/video.html` and verify:
- [ ] fal models appear (filter by provider "fal")
- [ ] fal video models have per-second pricing
- [ ] cost computation works (enter seconds, see cost)
- [ ] existing OpenRouter video models still present
- [ ] mobile layout intact

- [ ] **Step 3: Report to user for review**

Tell the user: "fal.ai integration complete locally. Server running on http://localhost:3000. ~167 image + ~143 video fal models merged. Please review the image and video tabs. Once approved, I'll push to GitHub."

**Wait for user approval before pushing.** Do NOT push in this task.

---

## Self-Review Notes (completed)

**Spec coverage check:**
- ✅ falCanonicalId (DD-1) — Task 1
- ✅ Pricing-unit handling (DD-2) — Task 2 (filter logic)
- ✅ Endpoint filtering (DD-3) — Task 2 (active + category + priced)
- ✅ Schema mapping (DD-4) — Task 2 (buildImageModel/buildVideoModel)
- ✅ Dedup precedence (DD-5) — Tasks 3+4 (prepend + dedupModels)
- ✅ Org extraction (DD-6) — Task 1 (FAL_ORG_MAP) + Task 2 (orgFromFalEndpoint)
- ✅ Resilience (DD-7) — Task 2 (non-fatal, try/catch, empty returns)
- ✅ Exclude compute-seconds — Task 2 (unit filter)
- ✅ Exclude per-video/generations — Task 2 (unit filter)
- ✅ Tests — Tasks 1, 6
- ✅ Docs — Task 6
- ✅ CI integration — Task 5

**Type consistency check:**
- `falCanonicalId` name consistent across Tasks 1, 2. ✅
- `fetchFalImageModels` / `fetchFalVideoModels` names consistent across Tasks 2, 3, 4. ✅
- Image pricing entry keys (`unit`, `variant`, `cost_per_unit`, `cost_per_million`) match existing schema. ✅
- Video pricing entry keys (`resolution`, `audio`, `cost_per_second`) match existing schema. ✅
- `FAL_ORG_MAP` consistent across Tasks 1, 2. ✅

**Placeholder scan:** None — every step has complete code.

**Coverage floors:** Set at ≥100 each for image/video (measured ~167/~143, leaving headroom for catalog drift).

**Known redundancy:** `fetch:all` runs `fetch:fal` standalone AND `fetch:images`/`fetch:videos` each fetch fal internally. This is a 6s vs 3s redundancy — acceptable for simplicity. Documented in Task 5 Step 1.
