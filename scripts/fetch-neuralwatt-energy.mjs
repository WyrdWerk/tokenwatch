/**
 * scripts/fetch-neuralwatt-energy.mjs — sidecar fetcher for Neuralwatt's
 * per-model energy-per-request pricing page.
 *
 * Fetches https://portal.neuralwatt.com/energy-pricing (SSR HTML), parses the
 * per-bucket table and per-model summary cards using zero-dep regex/string ops,
 * and returns a Map<catalogId, energyBlock>.
 *
 * On fetch/parse failure, logs a warning and returns an empty Map — the
 * pipeline continues without energy data.
 *
 * License note: monotykamary/neuralwatt-energy-status is MIT-licensed but we
 * write this parser from scratch to match our exact energyBlock output shape
 * and avoid coupling to their more elaborate schema (cards, sparklines, etc.).
 */

// ── Config (DO NOT derive from the page — these are authoritative) ────────────

const NEURALWATT_ENERGY = Object.freeze({
  rate_usd_per_kwh: 10.0,
  effective_from: '2026-07',
  legacy_rate_usd_per_kwh: 5.0,
  source_note: 'User-verified PAYG rate change $5→$10 (2026-07). Page rate is observation-only; disagreement logs a warning and the configured rate wins.',
});

const SOURCE_URL = 'https://portal.neuralwatt.com/energy-pricing';
const ESTIMATOR_URL = 'https://portal.neuralwatt.com/pricing';

// ── Name → catalog-id map (verified display name → /v1/models id) ─────────────

const DISPLAY_TO_ID = new Map([
  ['GLM-5.2', 'glm-5.2'],
  ['GLM-5.2 (fast)', 'glm-5.2-fast'],
  ['GLM-5.2 (short)', 'glm-5.2-short'],
  ['GLM-5.2 (short, fast)', 'glm-5.2-short-fast'],
  ['Kimi K2.6', 'kimi-k2.6'],
  ['Kimi K2.6 Fast', 'kimi-k2.6-fast'],
  ['Kimi K2.7 Code', 'kimi-k2.7-code'],
  ['Kimi K2.7 Code Fast', 'kimi-k2.7-code-fast'],
  ['Kimi K3', 'kimi-k3'],
  ['Kimi K3 Fast', 'kimi-k3-fast'],
  ['Qwen3.5 397B', 'qwen3.5-397b'],
  ['Qwen3.5 397B Fast', 'qwen3.5-397b-fast'],
  ['Qwen3.6 35B', 'qwen3.6-35b'],
  ['Qwen3.6 35B Fast', 'qwen3.6-35b-fast'],
  ['DeepSeek V4 Flash', 'deepseek-v4-flash'],
  ['Gemma 4 31B', 'gemma-4-31b'],
]);

// The 7 band keys in display order (en-dash, not dash)
const BAND_KEYS = [
  '0–256', '256–1k', '1k–4k', '4k–16k',
  '16k–64k', '64k–256k', '256k–1M',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Decode HTML entities used in the page (—, –, & etc). */
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Convert energy display string to Wh (canonical). Returns null for null-like. */
function parseEnergyToWh(raw) {
  const s = (raw || '').trim();
  if (!s || s === '—' || s === '-' || s === '–' || s === 'null') return null;
  // Match first energy value in the string (e.g. "175.07 mWh 39.9% of reqs")
  const m = s.match(/(\d+\.?\d*)\s*(m?Wh)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] === 'mWh' ? v / 1000 : v;
}

/** Extract share percentage from text like '39.9% of reqs'. Returns 0-100 number or null. */
function parseSharePercent(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const m = s.match(/([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}


// ── HTML parsing ──────────────────────────────────────────────────────────────

/**
 * Parse Neuralwatt energy-pricing HTML into a Map<catalogId, energyBlock>.
 *
 * Pure function — takes raw HTML string, returns structured data.
 * Exported for testability (tests pass fixture data instead of fetching).
 */
export function parseNeuralwattEnergyHtml(html) {
  const result = new Map();

  // ── Extract the band table ───────────────────────────────────────────────
  // The page has TWO tables: a per-model summary (Model | Right now | 7-day
  // typical | vs 7-day | 48h trend) followed by the per-size band grid we need
  // (Model | 0–256 | 256–1k | …). Identify the band table by its headers —
  // never assume it's the first <table> in the document.
  const allTables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const tableHtml = allTables.find((tb) => {
    const thead = tb.match(/<thead[\s\S]*?<\/thead>/i);
    return thead && thead[0].includes('0–256');
  });
  if (!tableHtml) return result; // no band table = nothing to parse

  // Parse headers — first <th> is "Model", the rest are band keys
  const theadMatch = tableHtml.match(/<thead[\s\S]*?<\/thead>/i);
  if (!theadMatch) return result;
  const headers = [];
  const thRe = /<th[\s\S]*?<\/th>/gi;
  let m;
  while ((m = thRe.exec(theadMatch[0]))) {
    const inner = m[0].replace(/<[^>]+>/g, ' ');
    headers.push(decodeEntities(inner).trim());
  }
  // Skip first header (model name column), keep the rest as band keys
  const bandHeaders = headers.slice(1);

  // Parse body rows
  const tbodyMatch = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!tbodyMatch) return result;

  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  while ((m = trRe.exec(tbodyMatch[0]))) {
    const trHtml = m[0];

    // Extract cells
    const tdRe = /<td[\s\S]*?<\/td>/gi;
    const cells = [];
    let tm;
    while ((tm = tdRe.exec(trHtml))) {
      const raw = tm[0];
      // Band cells carry energy + share only — no per-band cache-hit in the table
      // (cache-hit is a model-level figure from the summary cards). Strip tags for text.
      const text = decodeEntities(raw.replace(/<[^>]+>/g, ' ')).trim();
      cells.push({ text });
    }

    if (cells.length < 2) continue;

    // First cell = model display name. Scope extraction to the FIRST <td> block
    // only: its title="<name>" attribute when present, else its first text run.
    // (The visible cell may bundle the size-band subtitle, and later cells carry
    // tooltip title attrs that must not be mistaken for the model name.)
    const firstTd = trHtml.match(/<td[\s\S]*?<\/td>/i);
    let modelName = '';
    if (firstTd) {
      const nameTitle = firstTd[0].match(/title="([^"]+)"/);
      if (nameTitle) {
        modelName = decodeEntities(nameTitle[1]).trim();
      } else {
        // First innermost <div> text = the name line (subtitle lives in a sibling div)
        const nameDiv = firstTd[0].match(/<div[^>]*>([^<]*)<\/div>/);
        modelName = nameDiv ? decodeEntities(nameDiv[1]).trim() : cells[0].text;
      }
    }
    if (!modelName) continue;

    // Map display name → catalog id; skip unknown
    const catalogId = DISPLAY_TO_ID.get(modelName);
    if (!catalogId) {
      console.warn(`⚠ Neuralwatt: unknown model "${modelName}" — skipping`);
      continue;
    }

    // Build band data
    const bands = {};
    for (let i = 0; i < BAND_KEYS.length; i++) {
      const cellIdx = i + 1; // +1 because cell 0 is model name
      if (cellIdx >= cells.length) {
        bands[BAND_KEYS[i]] = null;
        continue;
      }
      const cell = cells[cellIdx];

      // Check for null indicators
      if (!cell.text || /Gathering data|—|-|–|null/i.test(cell.text)) {
        bands[BAND_KEYS[i]] = { wh: null, share: null };
        continue;
      }

      const wh = parseEnergyToWh(cell.text);
      const share = parseSharePercent(cell.text);

      bands[BAND_KEYS[i]] = { wh, share };
    }

    result.set(catalogId, { bands });
  }
  // ── Extract summary card data (cache-hit %, trend, updated) ─────────────
  // Cards contain headline energy, trend chip (▲/▼ X% above/below 7-day avg),
  // and cache-hit % ("measured at a X% avg cache-hit rate").
  // We walk each card container and attach the summary to the matching model.

  // Anchor each card on its model-name div (title="<DisplayName>") and parse a
  // bounded segment from there. Avoids fragile div-nest bounding: the non-greedy
  // `</div>` approach truncates at the first inner close, missing the cache-hit
  // and trend text that live deeper in the card.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anchors = [];
  for (const name of DISPLAY_TO_ID.keys()) {
    const re = new RegExp(`title="${escapeRe(name)}"`, 'g');
    let am;
    while ((am = re.exec(html))) anchors.push({ idx: am.index, name });
  }
  anchors.sort((a, b) => a.idx - b.idx);
  // Process only the FIRST occurrence per name (the summary card appears before
  // the band table; later occurrences are table rows with no card summary).
  const seenName = new Set();
  for (const a of anchors) {
    if (seenName.has(a.name)) continue;
    seenName.add(a.name);
    const catalogId = DISPLAY_TO_ID.get(a.name);
    const existing = result.get(catalogId);
    if (!existing) continue;
    // Bounded slice — card content sits within a few KB of the title anchor.
    const seg = html.slice(a.idx, a.idx + 4000);
    // Cache-hit wording varies by page generation: "measured at a X% avg
    // cache-hit rate" (cards) vs "ran at a X% cache-hit rate" (summary table).
    const cacheM = seg.match(/(\d+(?:\.\d+)?)%\s*(?:avg\s+)?cache-hit/i);
    existing.avg_cache_hit_pct = cacheM ? parseFloat(cacheM[1]) : null;
    const trendM = seg.match(/(\d+)%\s*(above|below)\s*7-day\s*avg/i);
    if (trendM) {
      const pct = parseInt(trendM[1], 10);
      existing.trend_48h_vs_7d_pct = trendM[2].toLowerCase() === 'below' ? -pct : pct;
    } else {
      // "in line with 7-day avg" or absent → no trend.
      existing.trend_48h_vs_7d_pct = null;
    }
  }

  // ── Extract "updated Xm ago" ─────────────────────────────────────────────
  const updatedM = html.match(/updated\s+(\d+\s*[hm]\s*ago|just now)/i);
  const updatedAgo = updatedM ? updatedM[1].replace(/\s+/g, ' ').trim() : null;

  // ── Extract observed rate (for comparison with config) ───────────────────
  // Pattern: "$X.XX/kWh" possibly wrapped in HTML tags, then "on pay-as-you-go"
  const rateM = html.match(/\$([\d.]+)\/kWh[\s\S]*?on\s+pay-as-you-go/i);
  const observedRate = rateM ? parseFloat(rateM[1]) : null;

  // ── Build final energyBlock per model ────────────────────────────────────
  const finalMap = new Map();
  for (const [catalogId, data] of result) {
    finalMap.set(catalogId, {
      source: SOURCE_URL,
      rate_usd_per_kwh: NEURALWATT_ENERGY.rate_usd_per_kwh,
      measured_window: '7d',
      workload_dependent: true,
      updated_ago: updatedAgo,
      avg_cache_hit_pct: data.avg_cache_hit_pct,
      trend_48h_vs_7d_pct: data.trend_48h_vs_7d_pct,
      bands: data.bands,
    });
  }

  // ── Rate observation & disagreement warning ──────────────────────────────
  if (observedRate !== null && observedRate !== NEURALWATT_ENERGY.rate_usd_per_kwh) {
    console.warn(
      `⚠ Neuralwatt page states $${observedRate.toFixed(2)}/kWh but config says $${NEURALWATT_ENERGY.rate_usd_per_kwh.toFixed(2)}/kWh — using configured rate.`
    );
  }

  return finalMap;
}

// ── Estimator parser (wh_per_mtok from /pricing inline JS) ───────────────────
// The public /pricing page embeds a billEstimator() Alpine component with a
// JSON model array containing wh_per_mtok + measured mix shares. No auth, no
// API call — just an inline <script>. This is the only source of true Wh/Mtok.
// Formula (from the Alpine component's result() method, verified 2026-07-30):
//   energy_ksh = (tokens / 1e6) × wh_per_mtok × energyScale / 1000
//   energyScale = userEff / measuredEff   (at measured mix, scale = 1)
//   $/Mtok_energy = wh_per_mtok × rate_usd_per_kwh / 1000
// The wh_per_mtok already reflects the model's real traffic mix (cached +
// output shares), so at the measured mix it's directly comparable to $/Mtok
// token pricing.

export function parseNeuralwattEstimator(html) {
  const m = html.match(/models:\s*(\[.*?\])\s*,\s*\/\/ Fleet-wide/s);
  if (!m) return new Map();
  let models;
  try {
    models = JSON.parse(m[1]);
  } catch {
    return new Map();
  }
  const estMap = new Map();
  for (const x of models) {
    if (!x.id || typeof x.wh_per_mtok !== 'number') continue;
    estMap.set(x.id, {
      wh_per_mtok: x.wh_per_mtok,
      wh_per_mtok_overridden: x.wh_per_mtok_overridden === true,
      measured_cached_input_share: x.measured_cached_input_share ?? null,
      measured_output_share: x.measured_output_share ?? null,
      cached_energy_fraction: x.cached_energy_fraction ?? null,
    });
  }
  return estMap;
}

// ── Public async fetcher ──────────────────────────────────────────────────────

/**
 * Fetch Neuralwatt's energy-pricing page + pricing estimator, parse into
 * energyBlock Map. Non-fatal: returns empty Map on any failure.
 *
 * The estimator (wh_per_mtok) is cached daily via data/neuralwatt-estimator-cache.json.
 * If the estimator fetch fails but a cache <24h old exists, the cached values
 * are reused (with a "stale-cache" flag). If no cache exists, wh_per_mtok is
 * omitted from the energy block — the per-request bands still work.
 */
import { readFile as _readFile, writeFile as _writeFile, mkdir as _mkdir } from 'node:fs/promises';
import { dirname as _dirname, join as _join } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';

const _dirname_ = _dirname(_fileURLToPath(import.meta.url));
const ESTIMATOR_CACHE = _join(_dirname_, '..', 'data', 'neuralwatt-estimator-cache.json');
const ESTIMATOR_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function loadEstimatorCache() {
  try {
    const raw = await _readFile(ESTIMATOR_CACHE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveEstimatorCache(data) {
  try {
    await _mkdir(_dirname(ESTIMATOR_CACHE), { recursive: true });
    await _writeFile(ESTIMATOR_CACHE, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal — cache is an optimization, not a requirement.
  }
}

export async function fetchNeuralwattEnergy(log = console) {
  try {
    // ── 1. Energy-pricing page (per-request bands, cache-hit, trend) ──
    const t0 = Date.now();
    const resp = await fetch(SOURCE_URL, { redirect: 'follow' });
    const ms = Date.now() - t0;
    if (!resp.ok) {
      log.warn(`⚠ Neuralwatt energy fetch failed — HTTP ${resp.status}: ${resp.statusText}`);
      return new Map();
    }
    const html = await resp.text();
    const result = parseNeuralwattEnergyHtml(html);
    log.log(`✓ Neuralwatt energy: ${result.size} models parsed (${ms}ms)`);

    // ── 2. Estimator (wh_per_mtok) — daily cache with stale fallback ──
    let estMap = null;
    let estimatorSource = 'fresh';
    let estimatorFetchedAt = null;
    const cache = await loadEstimatorCache();
    const cacheFresh = cache && cache.fetched_at && (Date.now() - new Date(cache.fetched_at).getTime() < ESTIMATOR_TTL_MS);

    if (cacheFresh) {
      // Cache is fresh — skip network, use cached data directly.
      estMap = new Map(Object.entries(cache.models || {}));
      estimatorSource = 'cache';
      estimatorFetchedAt = cache.fetched_at;
      if (estMap.size > 0) {
        log.log(`✓ Neuralwatt estimator: ${estMap.size} models (cache, fetched ${cache.fetched_at})`);
      }
    } else {
      // Cache stale or missing — try fresh fetch.
      try {
        const estResp = await fetch(ESTIMATOR_URL, { redirect: 'follow' });
        if (estResp.ok) {
          const estHtml = await estResp.text();
          estMap = parseNeuralwattEstimator(estHtml);
          if (estMap.size > 0) {
            estimatorFetchedAt = new Date().toISOString();
            await saveEstimatorCache({ fetched_at: estimatorFetchedAt, models: Object.fromEntries(estMap) });
            log.log(`✓ Neuralwatt estimator: ${estMap.size} models (fresh)`);
          }
        }
      } catch (err) {
        log.warn(`⚠ Neuralwatt estimator fetch failed — ${err.message}`);
      }

      // Stale-cache fallback: if fresh fetch failed, reuse old cache.
      if (!estMap && cache) {
        estMap = new Map(Object.entries(cache.models || {}));
        estimatorSource = 'stale-cache';
        estimatorFetchedAt = cache.fetched_at;
        if (estMap.size > 0) {
          log.log(`✓ Neuralwatt estimator: ${estMap.size} models (stale-cache, fetched ${cache.fetched_at})`);
        }
      }
    }

    // ── 3. Merge estimator data into energy blocks ──
    if (estMap && estMap.size > 0) {
      let merged = 0;
      for (const [id, block] of result) {
        const est = estMap.get(id);
        if (!est) continue;
        block.wh_per_mtok = est.wh_per_mtok;
        block.wh_per_mtok_overridden = est.wh_per_mtok_overridden;
        block.measured_cached_input_share = est.measured_cached_input_share;
        block.measured_output_share = est.measured_output_share;
        block.cached_energy_fraction = est.cached_energy_fraction;
        block.estimator_fetched_at = estimatorFetchedAt;
        block.estimator_source = estimatorSource;
        merged++;
      }
      log.log(`  Neuralwatt estimator: ${merged}/${estMap.size} models merged`);
    }

    return result;
  } catch (err) {
    log.warn(`⚠ Neuralwatt energy fetch failed — ${err.message}`);
    return new Map();
  }
}

// Allow `node scripts/fetch-neuralwatt-energy.mjs` to run standalone.
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  (async () => {
    const map = await fetchNeuralwattEnergy();
    if (map.size === 0) {
      console.error('✗ No energy data fetched — check network or page structure.');
      process.exit(1);
    }
    // Pretty-print the map for CLI inspection
    const out = {};
    for (const [id, block] of map) {
      out[id] = block;
    }
    console.log(JSON.stringify(out, null, 2));
  })().catch((err) => {
    console.error(`✗ Fatal: ${err.message}`);
    process.exit(1);
  });
}
