import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseZroPricingHtml,
  validateZroSnapshot,
  ZRO_PRICING_URL,
  ZRO_MIN_ROWS,
  ZRO_MAX_ROW_DROP,
  ZRO_SNAPSHOT_TTL_MS,
  zroSnapshotFresh,
  zroRowsFromSnapshot,
  zroNameMatchesId,
} from '../scripts/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'zro-pricing.html');

let fixture;
try {
  fixture = await readFile(fixturePath, 'utf8');
} catch {
  fixture = null;
}
assert.ok(fixture, `zro-pricing.html fixture missing or unreadable at ${fixturePath}`);

// ── panel selection / row parsing ─────────────────────────────────────────────

test('parseZroPricingHtml extracts only the API pricing panel rows', () => {
  const rows = parseZroPricingHtml(fixture);
  assert.equal(rows.length, 5, `expected 5 API offerings, got ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['deepseek-v4-flash-0731', 'deepseek-v4.1-flash', 'kimi-k3', 'glm-5.3', 'glm-5.3-flash'],
  );
});

test('parseZroPricingHtml normalizes USD per million input/output/cache_read', () => {
  const rows = parseZroPricingHtml(fixture);
  const flash = rows.find((r) => r.id === 'deepseek-v4-flash-0731');
  assert.ok(flash, 'deepseek-v4-flash-0731 present');
  assert.equal(flash.input, 0.14);
  assert.equal(flash.output, 0.28);
  assert.equal(flash.cache_read, 0.028);
  assert.equal(flash.cache_write, null, 'Zro does not publish cache_write → null');
  assert.equal(flash.name, 'DeepSeek V4 Flash 0731');
  assert.equal(flash.context_length, 1000000);
});

test('parseZroPricingHtml preserves current + original (list) prices on promotions', () => {
  const rows = parseZroPricingHtml(fixture);
  const promo = rows.find((r) => r.id === 'deepseek-v4.1-flash');
  assert.ok(promo, 'deepseek-v4.1-flash present');
  assert.equal(promo.input, 0.15, 'current promotional input is authoritative');
  assert.equal(promo.output, 0.6);
  assert.equal(promo.cache_read, 0.003);
  assert.equal(promo.original_input, 0.3);
  assert.equal(promo.original_output, 1.2);
  assert.equal(promo.original_cache_read, 0.006);
  assert.ok(promo.discount > 0, 'discount fraction derived from current vs original');
  assert.ok(Math.abs(promo.discount - 0.5) < 1e-9, `expected 50% off, got ${promo.discount}`);
  assert.match(promo.promotion.label, /50% off/i);
});

test('parseZroPricingHtml leaves non-promo rows with zero discount and no original prices', () => {
  const rows = parseZroPricingHtml(fixture);
  const plain = rows.find((r) => r.id === 'glm-5.3');
  assert.ok(plain, 'glm-5.3 present');
  assert.equal(plain.discount, 0);
  assert.equal(plain.original_input, null);
  assert.equal(plain.original_output, null);
  assert.equal(plain.original_cache_read, null);
});

// ── validation / fail-closed ──────────────────────────────────────────────────

test('parseZroPricingHtml returns [] when the API pricing panel is absent', () => {
  // Remove the API group node entirely (not just its copy text) so no API
  // panel — and therefore no priced rows — remains.
  const noPanel = fixture.replace(/"id":"api"/g, '"id":"not-api"').replace(/apiModelIds/g, 'otherIds');
  assert.deepEqual(parseZroPricingHtml(noPanel), []);
});

test('parseZroPricingHtml drops duplicate ids rather than emitting ambiguous rows', () => {
  const dup = fixture.replace(
    'glm-5.3-flash',
    'glm-5.3',
  );
  const rows = parseZroPricingHtml(dup);
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids may survive');
});

test('parseZroPricingHtml skips rows with non-positive input or output', () => {
  // Break the first row's input price to $0.00 — it must not be emitted.
  const broken = fixture.replace('$$0.14', '$$0.00');
  const rows = parseZroPricingHtml(broken);
  assert.equal(rows.some((r) => r.id === 'deepseek-v4-flash-0731'), false);
});

test('validateZroSnapshot rejects a row count below the floor', () => {
  const rows = parseZroPricingHtml(fixture).slice(0, ZRO_MIN_ROWS - 1);
  assert.throws(() => validateZroSnapshot({ models: rows }, { previous: null }), /below the .*floor|minimum/i);
});

test('validateZroSnapshot rejects a >20% row-count drop versus last-good', () => {
  const rows = parseZroPricingHtml(fixture);
  // Build a last-good snapshot of 20 rows, then present 5 (a 75% drop). The
  // floor (5) still passes, so the drop guard is what must reject it.
  const previous = { models: Array.from({ length: 20 }, (_, i) => ({ ...rows[i % rows.length], id: `row-${i}`, name: `Row ${i}` })) };
  assert.throws(
    () => validateZroSnapshot({ models: rows }, { previous }),
    /drop|20%/i,
  );
  // A within-tolerance shrink (20 → 17) is accepted.
  const shrunk = previous.models.slice(0, 17);
  assert.doesNotThrow(() => validateZroSnapshot({ models: shrunk }, { previous }));
});

test('validateZroSnapshot accepts a healthy snapshot and rejects partial/malformed rows', () => {
  const rows = parseZroPricingHtml(fixture);
  assert.doesNotThrow(() => validateZroSnapshot({ models: rows }, { previous: null }));
  assert.throws(() => validateZroSnapshot({ models: rows.map((r, i) => (i ? r : { ...r, id: '' })) }, { previous: null }), /id/i);
  assert.throws(() => validateZroSnapshot({ models: rows.map((r, i) => (i ? r : { ...r, input: -1 })) }, { previous: null }), /input/i);
  assert.throws(() => validateZroSnapshot({ models: rows.map((r, i) => (i ? r : { ...r, output: 0 })) }, { previous: null }), /output/i);
});

// ── snapshot TTL + fallback rows ──────────────────────────────────────────────

test('zroSnapshotFresh enforces a 24-hour TTL and rejects stale/invalid snapshots', () => {
  const now = Date.parse('2026-09-14T12:00:00.000Z');
  const fresh = { fetched_at: new Date(now - ZRO_SNAPSHOT_TTL_MS + 60_000).toISOString(), models: [] };
  const stale = { fetched_at: new Date(now - ZRO_SNAPSHOT_TTL_MS - 60_000).toISOString(), models: [] };
  assert.equal(zroSnapshotFresh(fresh, now), true);
  assert.equal(zroSnapshotFresh(stale, now), false);
  assert.equal(zroSnapshotFresh({ models: [] }, now), false, 'missing fetched_at is not fresh');
  assert.equal(zroSnapshotFresh(null, now), false);
});

test('zroRowsFromSnapshot maps snapshot entries to ordinary catalog records', () => {
  const rows = parseZroPricingHtml(fixture);
  const records = zroRowsFromSnapshot({ models: rows });
  assert.equal(records.length, rows.length);
  for (const record of records) {
    assert.equal(record.provider, 'zro');
    assert.equal(record.quantization, null);
    assert.equal(typeof record.pricing.input, 'number');
    assert.equal(typeof record.pricing.output, 'number');
    assert.ok(record.pricing.input > 0);
    assert.ok(record.pricing.output > 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(record.pricing, 'input_cache_read'));
  }
  const promo = records.find((r) => r.id === 'deepseek-v4.1-flash');
  assert.equal(promo.discount, 0.5);
  assert.equal(promo.pricing.input, 0.15);
});

test('zroRowsFromSnapshot never represents zero/unpatched models as free', () => {
  const records = zroRowsFromSnapshot({ models: [
    { id: 'zero-input', input: 0, output: 1, cache_read: 0 },
    { id: 'zero-both', input: 0, output: 0, cache_read: 0 },
    { id: 'ok', input: 1, output: 2, cache_read: 0.1 },
  ] });
  assert.deepEqual(records.map((r) => r.id), ['ok'], 'zero-priced rows must be dropped, not published as free');
});

test('ZRO_PRICING_URL points at the official public pricing page', () => {
  assert.equal(ZRO_PRICING_URL, 'https://zro.moonmath.ai/pricing');
});
// ── regression: name/price pairing on the live 2026-10-03 layout ─────────────
// Live layout: the first two <article> rows are inline in one Flight chunk,
// while kimi-k3's price <dl> is streamed separately as "$L14". The old parser
// took the whole containing chunk as kimi-k3's body and read the first <h3>
// and first price <dl> in it — DeepSeek V4.1 Flash's — so kimi-k3 shipped as
// "DeepSeek V4.1 Flash" at $0.30/$1.20/$0.006 instead of $2.50/$12.00/$0.45.

const liveFixture = await readFile(join(__dirname, 'fixtures', 'zro-pricing-live-20261003.html'), 'utf8');

test('parseZroPricingHtml pairs each id with its own name and prices (live layout)', () => {
  const rows = parseZroPricingHtml(liveFixture);
  assert.deepEqual(
    rows.map((r) => [r.id, r.name, r.input, r.output, r.cache_read, r.context_length]),
    [
      ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 0.3, 1.2, 0.006, 1000000],
      ['kimi-k3', 'Kimi K3', 2.5, 12, 0.45, 1000000],
      ['glm-5.3', 'GLM-5.3', 1.4, 4.4, 0.26, 1000000],
      ['glm-5.3-flash', 'GLM-5.3 Flash', 0.15, 0.5, 0.03, 1000000],
      ['dolly1-security', 'Dolly 1 Security', 0.45, 1.5, 0.09, 1000000],
    ],
  );
  for (const r of rows) assert.equal(r.discount, 0);
  assert.doesNotThrow(() => validateZroSnapshot({ models: rows }, { previous: null }));
});

test('validateZroSnapshot rejects a display name shared by two distinct ids', () => {
  const rows = parseZroPricingHtml(liveFixture);
  const misPaired = rows.map((r) => (r.id === 'kimi-k3' ? { ...r, name: 'DeepSeek V4.1 Flash' } : r));
  assert.throws(() => validateZroSnapshot({ models: misPaired }, { previous: null }), /display name/i);
});

test('validateZroSnapshot rejects a display name that does not match its id', () => {
  const rows = parseZroPricingHtml(liveFixture);
  const shifted = rows.map((r) => (r.id === 'glm-5.3-flash' ? { ...r, name: 'Dolly 1 Security' } : r))
    .map((r) => (r.id === 'dolly1-security' ? { ...r, name: 'Kimi K4' } : r));
  assert.throws(() => validateZroSnapshot({ models: shifted }, { previous: null }), /does not match|shared/i);
});

test('zroNameMatchesId accepts real Zro names and rejects cross-row pairs', () => {
  for (const [name, id] of [
    ['DeepSeek V4 Flash 0731', 'deepseek-v4-flash-0731'],
    ['Kimi K3', 'kimi-k3'],
    ['GLM-5.3 Flash', 'glm-5.3-flash'],
    ['Dolly 1 Security', 'dolly1-security'],
  ]) assert.equal(zroNameMatchesId(name, id), true, `${name} ↔ ${id}`);
  assert.equal(zroNameMatchesId('DeepSeek V4.1 Flash', 'kimi-k3'), false);
});
