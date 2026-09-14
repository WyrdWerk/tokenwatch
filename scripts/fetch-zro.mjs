#!/usr/bin/env node
/**
 * fetch-zro.mjs
 *
 * Daily public Zro Tier-3 API-pricing ingestion.
 *
 * Source: https://zro.moonmath.ai/pricing (public, no key). The page is a
 * Next.js app; `parseZroPricingHtml()` in scripts/lib.mjs reconstructs the API
 * pricing panel from its React Flight payload.
 *
 * Durability model:
 *   - data/zro-pricing.json is the committed LAST-GOOD source snapshot.
 *   - A snapshot younger than 24h is reused without a network call, so the
 *     2-hourly refresh workflow only hits the live page once per day.
 *   - On fetch/parse/validation failure, the last-good snapshot is used.
 *   - `validateZroSnapshot()` is fail-closed: a partial parse, duplicate ids,
 *     non-positive prices, a sub-floor row count, or a >20% row-count drop
 *     versus last-good all reject the fresh data.
 *
 * `getZroCatalogRows()` always returns either newly validated rows or validated
 * fallback rows, mapped to ordinary TokenWatch catalog records
 * (provider: "zro"). It never returns a partial slice and never publishes a
 * zero-priced model as free.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  parseZroPricingHtml,
  validateZroSnapshot,
  zroSnapshotFresh,
  zroRowsFromSnapshot,
  ZRO_PRICING_URL,
} from './lib.mjs';

export const ZRO_SNAPSHOT_PATH = 'data/zro-pricing.json';

/**
 * Read the committed last-good snapshot, or null when absent/invalid.
 *
 * The on-disk copy is validated with the same fail-closed rules as a fresh
 * fetch, so a corrupted or hand-truncated `data/zro-pricing.json` can never be
 * reused via the TTL path or published as fallback rows — the "never partial"
 * invariant applies to the last-good copy too.
 */
export async function readZroSnapshot(path = ZRO_SNAPSHOT_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    validateZroSnapshot(parsed, { previous: null });
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a validated snapshot (fetch timestamp recorded for the TTL).
 * Fails fast rather than writing a snapshot that `readZroSnapshot()` would
 * reject — keeps the committed last-good copy always consumable.
 */
export async function writeZroSnapshot(snapshot, path = ZRO_SNAPSHOT_PATH) {
  validateZroSnapshot(snapshot, { previous: null });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/**
 * Fetch + validate the live Zro API panel.
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date }} [options]
 * @returns {Promise<{ok: true, snapshot: object} | {ok: false, reason: string}>}
 */
export async function fetchZroSnapshot({ fetchImpl = fetch, now = () => new Date() } = {}) {
  let html;
  try {
    const resp = await fetchImpl(ZRO_PRICING_URL, { redirect: 'follow' });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    html = await resp.text();
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const rows = parseZroPricingHtml(html);
  const snapshot = {
    source_url: ZRO_PRICING_URL,
    fetched_at: now().toISOString(),
    models: rows,
  };
  try {
    validateZroSnapshot(snapshot, { previous: null });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, snapshot };
}

/**
 * Resolve Zro catalog rows for a refresh run.
 *
 * Returns newly validated rows when the live fetch succeeds and validates;
 * otherwise returns rows from the last-good snapshot. Always returns ordinary
 * catalog records (provider: "zro") — never null, never partial.
 *
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date, snapshotPath?: string,
 *   force?: boolean, log?: (msg: string) => void }} [options]
 * @returns {Promise<{rows: Array<object>, source: 'fresh'|'snapshot'|'none', reason?: string}>}
 */
export async function getZroCatalogRows({
  fetchImpl = fetch,
  now = () => new Date(),
  snapshotPath = ZRO_SNAPSHOT_PATH,
  force = false,
  log = console.log,
} = {}) {
  const previous = await readZroSnapshot(snapshotPath);
  const nowMs = now().getTime();

  // Reuse a fresh snapshot without touching the network (daily ingestion on a
  // 2-hourly refresh cadence).
  if (!force && previous && zroSnapshotFresh(previous, nowMs)) {
    log(`  Zro: reusing last-good snapshot (fetched ${previous.fetched_at})`);
    return { rows: zroRowsFromSnapshot(previous), source: 'snapshot' };
  }

  const fetched = await fetchZroSnapshot({ fetchImpl, now });
  if (fetched.ok) {
    // Guard against a large row-count regression before accepting fresh data.
    try {
      validateZroSnapshot(fetched.snapshot, { previous });
    } catch (err) {
      log(`  ⚠ Zro: fresh snapshot rejected (${err.message}) — using last-good`);
      if (previous) return { rows: zroRowsFromSnapshot(previous), source: 'snapshot', reason: err.message };
      return { rows: [], source: 'none', reason: err.message };
    }
    try {
      await writeZroSnapshot(fetched.snapshot, snapshotPath);
      log(`  ✓ Zro: fetched ${fetched.snapshot.models.length} API offerings`);
    } catch (err) {
      log(`  ⚠ Zro: could not persist snapshot (${err.message}) — using fresh rows anyway`);
    }
    return { rows: zroRowsFromSnapshot(fetched.snapshot), source: 'fresh' };
  }

  log(`  ⚠ Zro: fetch/parse failed (${fetched.reason}) — using last-good snapshot`);
  if (previous) return { rows: zroRowsFromSnapshot(previous), source: 'snapshot', reason: fetched.reason };
  return { rows: [], source: 'none', reason: fetched.reason };
}