/**
 * shared/price-history.mjs — pure helpers for the daily price-snapshot writer
 * and the history API. No `node:` imports, so the Cloudflare Pages Function can
 * import it directly and tests can exercise it without a database.
 *
 * Why this module exists (see docs/adr/0011-price-history-snapshots.md):
 *   1. Snapshot RAW USD-per-million rate components. Never snapshot a blended
 *      or effective price — the visitor's token mix is a read-time concern.
 *   2. `offeringKey` is the catalog's dedup identity. Quantization, batch, and
 *      other SKU variants are distinct offerings and must not collapse.
 *   3. A day with no row means "not offered that day". Nothing here invents a
 *      zero-price row or a carry-forward row.
 */

import { canonicalId } from './normalize.mjs';
import { blendedRate } from './cost.mjs';

/** Default snapshot retention window, in days. */
export const RETENTION_DAYS = 90;

/** Maximum number of daily points the history API will return. */
export const MAX_HISTORY_DAYS = 90;

/** Default visitor mix when a request omits `mix`. Mirrors shared/cost.mjs AGENTIC_MIX. */
export const DEFAULT_MIX = { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 };

/**
 * UTC calendar day ('YYYY-MM-DD') for a Date or ISO timestamp string.
 * The daily writer keys on this, so a retry later the same UTC day is an upsert
 * rather than a new row.
 */
export function utcDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date.toISOString().slice(0, 10);
}

/** UTC day `n` days before `from` (n > 0 goes back in time). */
export function shiftUtcDay(day, n) {
  if (!isUtcDay(day)) throw new Error(`invalid utc day: ${day}`);
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** True when `value` is a well-formed 'YYYY-MM-DD' UTC day. */
export function isUtcDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Identity of one priced offering inside a canonical model.
 *
 * Every component that the catalog treats as a separate row belongs here, so
 * the unique `(utc_day, offering_key)` index enforces one row per offering per
 * day without ever merging variants:
 *   - `modelId`     — full catalog id, e.g. `zai-org/GLM-5.2` vs `GLM-5.2`
 *   - `provider`    — provider key
 *   - `quantization`— catalog quantization, or '' when absent
 *   - `sku`         — suffix beyond quantization/batch that still separates
 *                     SKUs, e.g. `:batch`, `:free`, `-turbo`, peak/off-peak
 */
export function offeringKey({ modelId, provider, quantization, sku }) {
  return [
    canonicalId(modelId),
    String(provider || '').toLowerCase(),
    String(quantization || '').toLowerCase(),
    String(sku || '').toLowerCase(),
  ].join('|');
}

/**
 * Normalize a catalog model row into a snapshot row (or null when the row has
 * no usable price at all — a fully unpriced row must stay absent, not become a
 * row of zeroes).
 *
 * Raw fields only: no blending, no discount application, no rounding.
 */
export function toSnapshotRow(model, day, generatedAt) {
  const pricing = model?.pricing;
  if (!pricing) return null;
  const input = num(pricing.input);
  const output = num(pricing.output);
  const cacheRead = num(pricing.cache_read);
  const cacheWrite = num(pricing.cache_write);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;

  return {
    utc_day: day,
    offering_key: offeringKey({
      modelId: model.id,
      provider: model.provider,
      quantization: model.quantization,
      sku: skuFromId(model.id),
    }),
    canonical_model: canonicalId(model.id),
    provider: String(model.provider || ''),
    quantization: model.quantization || '',
    sku: skuFromId(model.id),
    model_id: model.id,
    model_name: model.name ?? null,
    org: model.org ?? null,
    input_price: input,
    output_price: output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    discount: num(model.discount) ?? 0,
    source_generated_at: generatedAt ?? null,
  };
}

/**
 * SKU discriminator for an offering: the variant suffixes that `canonicalId`
 * deliberately preserves. Returns '' for a plain model id.
 *
 * `canonicalId` already keeps quantization and turbo/batch suffixes distinct,
 * so this only needs to *name* the discriminator for the schema's `sku` column
 * (it is not used for dedup on its own — `offeringKey` also includes the
 * canonical id, which already carries these suffixes).
 */
export function skuFromId(modelId) {
  const match = String(modelId || '').match(/(:batch|:free|:thinking|-turbo|-fast|-highspeed|-offpeak|-off-peak)$/i);
  return match ? match[1].toLowerCase() : '';
}

/** Coerce a catalog price to a non-negative finite number, or null. */
function num(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Read-time blended rate ($/M) for one snapshot row.
 *
 * Delegates to `shared/cost.mjs` semantics so the API cannot drift from the
 * calculator: `cache_read: null` falls back to the INPUT price (the offering
 * simply publishes no cache discount), and a mix leg is only disqualifying when
 * its own price is missing and the mix actually requests it.
 */
export function blendedRateFor(row, mix = DEFAULT_MIX) {
  return blendedRate(
    { input: row.input_price, output: row.output_price, cache_read: row.cache_read },
    mix,
  );
}

/**
 * Group snapshot rows into an ordered per-day cheapest-provider series.
 *
 * - Rows for a day that no offering can price under the mix are dropped (the
 *   day stays absent rather than becoming $0).
 * - Ties break on provider name then offering key, so the series is
 *   deterministic for a given database state.
 * - Output is chronological, ascending by day.
 *
 * `series` carries EVERY offering for the day so a client can show a
 * provider switch without a second request; `point` is the cheapest one.
 */
export function buildHistorySeries(rows, mix = DEFAULT_MIX) {
  const byDay = new Map();
  for (const row of rows) {
    if (!isUtcDay(row.utc_day)) continue;
    if (!byDay.has(row.utc_day)) byDay.set(row.utc_day, []);
    byDay.get(row.utc_day).push(row);
  }

  const days = [];
  for (const day of [...byDay.keys()].sort()) {
    const offers = [];
    for (const row of byDay.get(day)) {
      const rate = blendedRateFor(row, mix);
      if (rate === null) continue;
      offers.push({ row, rate });
    }
    if (!offers.length) continue;
    offers.sort((a, b) =>
      a.rate - b.rate ||
      a.row.provider.localeCompare(b.row.provider) ||
      a.row.offering_key.localeCompare(b.row.offering_key));

    const cheapest = offers[0];
    days.push({
      day,
      point: {
        day,
        provider: cheapest.row.provider,
        model_id: cheapest.row.model_id,
        quantization: cheapest.row.quantization || null,
        blended: round6(cheapest.rate),
        input: cheapest.row.input_price,
        output: cheapest.row.output_price,
        cache_read: cheapest.row.cache_read,
        discount: cheapest.row.discount,
      },
      series: offers.map(({ row, rate }) => ({
        provider: row.provider,
        model_id: row.model_id,
        quantization: row.quantization || null,
        blended: round6(rate),
      })),
    });
  }
  return days;
}

/**
 * Cap an ordered day list to the newest `days` points, keeping chronological
 * order. Truncation drops the OLDEST points — a history chart must end at the
 * most recent day.
 */
export function capHistoryDays(days, days_ = MAX_HISTORY_DAYS) {
  if (days.length <= days_) return days;
  return days.slice(days.length - days_);
}

/** Round to 6 decimals — enough to keep $/M rates exact without float noise. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Parse `?mix=inputPct,cacheReadPct,outputPct`.
 *
 * Returns `{ ok: true, mix }` or `{ ok: false, error }`. Percentages must be
 * finite, non-negative, and sum to 100 (±0.5 tolerance for 33.33-style mixes).
 */
export function parseMixParam(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, mix: DEFAULT_MIX };
  const parts = String(raw).split(',');
  if (parts.length !== 3) return { ok: false, error: 'mix must be inputPct,cacheReadPct,outputPct' };
  const values = [];
  for (const part of parts) {
    if (!/^\s*\d+(\.\d+)?\s*$/.test(part)) return { ok: false, error: 'mix values must be non-negative numbers' };
    values.push(Number(part));
  }
  const total = values[0] + values[1] + values[2];
  if (Math.abs(total - 100) > 0.5) return { ok: false, error: 'mix percentages must sum to 100' };
  return { ok: true, mix: { inputPct: values[0], cacheReadPct: values[1], outputPct: values[2] } };
}

/**
 * Parse `?days=N` into an integer in [1, MAX_HISTORY_DAYS].
 * Returns `{ ok: false }` for malformed or out-of-range values instead of
 * silently clamping, so a caller can return 400 rather than a misleading chart.
 */
export function parseDaysParam(raw, max = MAX_HISTORY_DAYS) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, days: max };
  if (!/^\d+$/.test(String(raw).trim())) return { ok: false, error: `days must be an integer between 1 and ${max}` };
  const days = Number(raw);
  if (days < 1 || days > max) return { ok: false, error: `days must be an integer between 1 and ${max}` };
  return { ok: true, days };
}

/**
 * UTC day cutoff for a `days` window ending at `today` (inclusive).
 * days=90 keeps today and the 89 days before it, so a 90-row history spans
 * exactly 90 calendar days.
 */
export function windowStartDay(today, days) {
  return shiftUtcDay(today, -(days - 1));
}

/** Days to prune for a retention window: everything strictly before `cutoff`. */
export function retentionCutoff(today, retentionDays = RETENTION_DAYS) {
  return shiftUtcDay(today, -(retentionDays - 1));
}