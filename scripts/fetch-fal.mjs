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
 *
 * Cache contract (avoids double-fetching the fal catalog in CI):
 * - CI runs `node scripts/fetch-fal.mjs` as a prefetch step, writing
 *   /tmp/fal-image.json + /tmp/fal-video.json atomically.
 * - When FAL_CACHE_ONLY=1 (set in CI), callers read cached arrays or return []
 *   (never live-fetch). If fal is down, coverage guard aborts safely,
 *   preserving last-good data.
 * - Without FAL_CACHE_ONLY (local dev), callers live-fetch with module-level
 *   memoization — fetchFalModels() runs at most once per process even if both
 *   fetchFalImageModels() and fetchFalVideoModels() are called.
 */

import { falCanonicalId, FAL_ORG_MAP } from './lib.mjs';

const FAL_MODELS_URL = 'https://api.fal.ai/v1/models';
const FAL_PRICING_URL = 'https://api.fal.ai/v1/models/pricing';
const PRICING_BATCH_SIZE = 50; // fal accepts 1-50 endpoint_ids per call
const MAX_PAGES = 10; // safety cap on pagination

// Categories we care about — generation only (no editing/processing/upscale tools)
const IMAGE_CATEGORIES = new Set(['text-to-image']);
const VIDEO_CATEGORIES = new Set(['text-to-video', 'image-to-video']);

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
    if (!r.ok) throw new Error(`fal /v1/models HTTP ${r.status}: ${await r.text().catch(() => '')}`);
    const d = await r.json();
    if (!d.models || !d.models.length) break;
    all.push(...d.models);
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  return all;
}

/** Fetch pricing for a list of endpoint IDs (batched 50 per call). Returns Map<endpoint_id, price>.
 *  Retries on 429 honoring Retry-After header (up to 5 retries). Non-429 errors skip the batch. */
async function fetchPricingBatched(endpointIds, headers) {
  const priceMap = new Map();
  const MAX_RETRIES = 5;
  for (let i = 0; i < endpointIds.length; i += PRICING_BATCH_SIZE) {
    const batch = endpointIds.slice(i, i + PRICING_BATCH_SIZE);
    const url = FAL_PRICING_URL + '?endpoint_id=' + batch.map(encodeURIComponent).join(',');
    let r;
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      r = await fetch(url, { headers });
      if (r.ok) break;
      if (r.status === 429) {
        // Honor Retry-After header (seconds), fall back to exponential backoff
        const retryAfter = r.headers.get('Retry-After');
        const delayMs = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 30000) // cap at 30s
          : Math.min(1000 * Math.pow(2, attempt), 16000);    // 1s, 2s, 4s, 8s, 16s
        await new Promise(res => setTimeout(res, delayMs));
        continue;
      }
      lastErr = r.status;
      break; // non-429 errors: don't retry
    }
    if (!r || !r.ok) {
      console.warn(`⚠ fal pricing batch HTTP ${lastErr || r?.status} for ${batch.length} ids — skipping batch`);
      continue;
    }
    const d = await r.json();
    for (const p of (d.prices || [])) {
      priceMap.set(p.endpoint_id, p);
    }
    // Delay between batches to avoid 429s (fal's rate limit is unstated but aggressive)
    if (i + PRICING_BATCH_SIZE < endpointIds.length) {
      await new Promise(res => setTimeout(res, 500));
    }
  }
  return priceMap;
}

/** Extract org from endpoint_id via FAL_ORG_MAP, with 'fal' fallback. */
function orgFromFalEndpoint(endpointId) {
  let id = endpointId;
  if (id.startsWith('fal-ai/')) id = id.slice('fal-ai/'.length);
  const firstSeg = id.split('/')[0];
  // Try exact match first
  if (FAL_ORG_MAP[firstSeg]) return FAL_ORG_MAP[firstSeg];
  // Try compound families (e.g. 'nano-banana-pro' → 'nano-banana-pro' or 'nano-banana')
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
  if (unit === 'images') {
    // flat per-image
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

// ── module-level memoization + cache support ─────────────────────────────────

let _falPromise = null;

const FAL_IMAGE_CACHE = '/tmp/fal-image.json';
const FAL_VIDEO_CACHE = '/tmp/fal-video.json';

/** Core fetch+filter+map. Returns { imageModels, videoModels }. Memoized per-process. */
async function fetchFalModels() {
  if (!_falPromise) {
    _falPromise = _fetchFalModelsUncached();
  }
  return _falPromise;
}

async function _fetchFalModelsUncached() {
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

  // Build models — dedup intra-fal by canonical id (first-seen wins)
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
    if (!map.has(model.id)) map.set(model.id, model);
  }

  console.log(`✓ fal.ai: ${imageById.size} image + ${videoById.size} video models (${all.length} fetched, ${skippedNoPrice} no pricing, ${skippedUnit} excluded unit) in ${Date.now() - t0}ms`);
  return { imageModels: [...imageById.values()], videoModels: [...videoById.values()] };
}

/** Try to read a cache file. Returns parsed array or null. */
async function readCache(path) {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/** Write a cache file atomically (write to .tmp then rename). */
async function writeCache(path, data) {
  const { writeFile, rename } = await import('node:fs/promises');
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

/** Public: fetch fal image models. Returns [] on failure.
 *  When FAL_CACHE_ONLY=1, reads from /tmp/fal-image.json (never live-fetches). */
export async function fetchFalImageModels() {
  if (process.env.FAL_CACHE_ONLY === '1') {
    const cached = await readCache(FAL_IMAGE_CACHE);
    if (cached) {
      console.log(`  fal.ai: using cached image models (${cached.length}) from ${FAL_IMAGE_CACHE}`);
      return cached;
    }
    console.warn('⚠ fal.ai: FAL_CACHE_ONLY=1 but no image cache — returning []');
    return [];
  }
  try {
    const { imageModels } = await fetchFalModels();
    return imageModels;
  } catch (err) {
    console.warn(`⚠ fal.ai image fetch failed — continuing without fal image data: ${err.message}`);
    return [];
  }
}

/** Public: fetch fal video models. Returns [] on failure.
 *  When FAL_CACHE_ONLY=1, reads from /tmp/fal-video.json (never live-fetches). */
export async function fetchFalVideoModels() {
  if (process.env.FAL_CACHE_ONLY === '1') {
    const cached = await readCache(FAL_VIDEO_CACHE);
    if (cached) {
      console.log(`  fal.ai: using cached video models (${cached.length}) from ${FAL_VIDEO_CACHE}`);
      return cached;
    }
    console.warn('⚠ fal.ai: FAL_CACHE_ONLY=1 but no video cache — returning []');
    return [];
  }
  try {
    const { videoModels } = await fetchFalModels();
    return videoModels;
  } catch (err) {
    console.warn(`⚠ fal.ai video fetch failed — continuing without fal video data: ${err.message}`);
    return [];
  }
}

// Allow `node scripts/fetch-fal.mjs` to run standalone (CI prefetch step).
// Writes /tmp/fal-image.json + /tmp/fal-video.json atomically.
// Never crashes: on failure, writes empty arrays so callers (FAL_CACHE_ONLY=1)
// get a definitive "cache present but empty" signal.
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let imageModels = [];
  let videoModels = [];
  try {
    const result = await fetchFalModels();
    imageModels = result.imageModels;
    videoModels = result.videoModels;
  } catch (err) {
    console.error(`✗ fal.ai prefetch failed: ${err.message}`);
    console.error('  Writing empty cache files — image/video pipelines will continue without fal data.');
  }
  await writeCache(FAL_IMAGE_CACHE, imageModels);
  await writeCache(FAL_VIDEO_CACHE, videoModels);
  console.log(`  wrote ${FAL_IMAGE_CACHE} (${imageModels.length}) + ${FAL_VIDEO_CACHE} (${videoModels.length})`);
}
