/**
 * scripts/fetch-arena.mjs — Arena AI (Chatbot Arena) text leaderboard sidecar.
 *
 * LOCAL-DEVELOPMENT-ONLY enrichment. The Arena AI leaderboard is a human
 * preference signal ("which assistant do real people prefer") — orthogonal to
 * coding-metric benches. It is deliberately EXCLUDED from the CI/deploy
 * pipeline:
 *   - GitHub Actions sets GITHUB_ACTIONS=true in every job. All live fetches AND
 *     cache reads are skipped when that flag is set, so no wulong.com/arena.ai
 *     network call and no Arena score ever reach a deploy. (CI=true is NOT a
 *     reliable gate — some local dev shells set it for unrelated reasons.)
 *   - data/arena-benchmarks.json is gitignored (like the neuralwatt estimator
 *     cache) — Arena data is produced only on a developer's machine.
 *
 * Data: https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text
 *   Free, no auth. Daily snapshots of arena.ai (formerly LMSYS Chatbot Arena).
 *   Backing repo: https://github.com/oolong-tea-2026/arena-ai-leaderboards
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, '..', 'data', 'arena-benchmarks.json');
const ARENA_URL = 'https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text';

// Effort/stage qualifiers Arena appends to a base model name. Stripped so
// claude-opus-4-6-high and claude-opus-4-6 collapse onto one model family.
const EFFORT_TOKENS = ['xhigh', 'high', 'max', 'preview'];

/**
 * Alphanumeric join key of an Arena model name. Parenthetical qualifiers
 * (e.g. `muse-spark-1.2 (xHigh)`) are dropped; effort suffixes are KEPT.
 * `qwen3.8-max` → `qwen38max` (NOT `qwen38`) because here "max" is part of the
 * SKU name, not an effort qualifier — indexing it raw prevents a wrong join to
 * a shorter base model.
 */
export function plainKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Arena family key: plainKey, then strip ONE trailing effort qualifier.
 * `claude-opus-4-6-high` → `claudeopus46`; `claude-opus-5-max` → `claudeopus5`.
 */
export function arenaKey(name) {
  let k = plainKey(name);
  for (const tok of EFFORT_TOKENS) {
    if (k.endsWith(tok)) { k = k.slice(0, -tok.length); break; }
  }
  return k;
}

/** True if the arena name carries an effort/stage qualifier token. */
function isEffortVariant(name) {
  return new RegExp(`\\b(?:${EFFORT_TOKENS.join('|')})\\b`).test(String(name).toLowerCase());
}

/**
 * Build a join index from raw Arena model records.
 *
 * Each record is indexed under BOTH its plainKey and arenaKey, so a catalog
 * model can be looked up by its own catalogKey() (alphanumeric) in one get():
 *   - a base entry resolves via plainKey  (claude-opus-4.6  → claudeopus46)
 *   - an effort variant resolves via arenaKey (claude-opus-5 → claudeopus5)
 *
 * Collision resolution per key: a base (non-variant) entry beats an effort
 * variant; between two variants, higher Elo wins (tie → more votes).
 */
export function buildArenaIndex(models) {
  const idx = new Map();
  const insert = (key, rec) => {
    const cur = idx.get(key);
    if (!cur) { idx.set(key, rec); return; }
    const recVar = isEffortVariant(rec.arena_name);
    const curVar = isEffortVariant(cur.arena_name);
    let keep = cur;
    if (recVar === curVar) {
      if (rec.arena_elo > cur.arena_elo) keep = rec;
      else if (rec.arena_elo === cur.arena_elo && (rec.arena_votes ?? 0) > (cur.arena_votes ?? 0)) keep = rec;
    } else if (!recVar && curVar) {
      keep = rec; // base beats variant
    }
    idx.set(key, keep);
  };

  for (const m of models) {
    if (typeof m.score !== 'number') continue;
    const rec = { arena_elo: m.score, arena_ci: m.ci ?? null, arena_votes: m.votes ?? null, arena_name: m.model };
    insert(plainKey(m.model), rec);
    insert(arenaKey(m.model), rec);
  }
  return idx;
}

/**
 * Read the local Arena cache and build a join index, or null when unavailable
 * OR when running under CI (Arena is local-only). Non-fatal by design.
 */
export async function readArenaIndex() {
  if (process.env.GITHUB_ACTIONS) return null;
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.models) || raw.models.length === 0) return null;
    return buildArenaIndex(raw.models);
  } catch {
    return null; // no cache yet — skip Arena (never fatal)
  }
}

/** Fetch the live Arena text leaderboard. */
async function fetchLive() {
  const resp = await fetch(ARENA_URL, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || !Array.isArray(data.models)) throw new Error('unexpected Arena payload (missing models array)');
  return data;
}

async function main() {
  if (process.env.GITHUB_ACTIONS) {
    console.log('GitHub Actions detected — skipping Arena fetch (local-only enrichment).');
    return;
  }
  try {
    const data = await fetchLive();
    const payload = {
      _meta: { fetched_at: new Date().toISOString(), source: ARENA_URL, count: data.models.length },
      models: data.models,
    };
    await writeFile(CACHE_PATH, JSON.stringify(payload, null, 2));
    console.log(`✓ Arena AI: cached ${data.models.length} models → data/arena-benchmarks.json`);
  } catch (err) {
    console.error(`✗ Arena fetch failed: ${err.message} — benchmarks.json will omit Arena Elo`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) { main(); }