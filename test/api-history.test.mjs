/**
 * History API tests: GET /api/v1/models/:canonicalId/history
 *
 * Uses a mock D1 binding whose prepared statements are captured, so the test can
 * assert BOTH the SQL the handler issues and the response it builds. The seeded
 * fixtures are deliberately asymmetric:
 *   - provider A/B swap cheapest rank with the workload mix;
 *   - day-to-day values change, so a flat/unordered series would be obvious;
 *   - days are missing rather than zero-filled;
 *   - a quantized variant exists alongside the plain one;
 *   - one provider disappears and reappears.
 *
 * The mock also enforces the schema's uniqueness contract: it rejects a second
 * INSERT for an (offering_key, utc_day) pair, which is what lets the writer's
 * idempotence test mean something.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildSnapshotStatements } from '../scripts/snapshot-prices.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const api = await import('../functions/api/v1/[[route]].js');
const { onRequestGet } = api;

// ── Mock D1 ───────────────────────────────────────────────────────────────────

/**
 * A minimal D1Database stand-in. It understands exactly the two statements the
 * history route issues (a bound SELECT) plus the writer's INSERT/DELETE batch,
 * and enforces the (offering_key, utc_day) uniqueness that the migration
 * declares.
 */
class MockD1 {
  constructor(rows = []) {
    this.rows = [...rows];
    this.captured = [];
    this.failNext = null;
  }

  prepare(sql) {
    const self = this;
    const record = { sql: sql.replace(/\s+/g, ' ').trim(), bindings: [] };
    self.captured.push(record);
    const statement = {
      bind(...values) {
        record.bindings = values;
        return statement;
      },
      async all() {
        if (self.failNext) {
          const err = self.failNext;
          self.failNext = null;
          throw err;
        }
        const [model, start, end] = record.bindings;
        const results = self.rows
          .filter((row) => row.canonical_model === model && row.utc_day >= start && row.utc_day <= end)
          .sort((a, b) => a.utc_day.localeCompare(b.utc_day) || a.offering_key.localeCompare(b.offering_key));
        return { results };
      },
    };
    return statement;
  }

  /**
   * Apply the writer's generated batch, emulating the D1 semantics the writer
   * relies on:
   *   - `price_snapshot_day` is a claim table with a PRIMARY KEY on utc_day, so
   *     `INSERT OR IGNORE` only succeeds for the run that first claims the day;
   *   - every following statement is gated on `claim_token = '<token>'`, so a
   *     run whose claim was ignored writes nothing;
   *   - `price_snapshot` has UNIQUE(offering_key, utc_day).
   */
  async batch(statements) {
    this.dayClaims = this.dayClaims || new Map();
    const claimOf = (sql) => (sql.match(/claim_token = '([^']+)'/) || [])[1] || null;

    for (const { sql } of statements) {
      const claim = sql.match(/^INSERT OR (IGNORE|REPLACE) INTO price_snapshot_day \(([^)]+)\) VALUES \((.*)\)$/s);
      if (claim) {
        const columns = claim[2].split(',').map((c) => c.trim());
        // `strftime(...)` for claimed_at is emulated with a fixed marker so the
        // test can assert the metadata was refreshed without depending on time.
        const values = splitSqlValues(claim[3]).map((v) => (typeof v === 'string' && /^strftime\(/i.test(v) ? 'refreshed' : v));
        const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
        if (claim[1] === 'REPLACE' || !this.dayClaims.has(row.utc_day)) {
          this.dayClaims.set(row.utc_day, row);
        }
        continue;
      }

      // Ownership test: the token must match the stored claim for its day.
      const token = claimOf(sql);
      const ownedByToken = token === null
        ? true
        : [...this.dayClaims.values()].some((row) => row.claim_token === token);
      if (!ownedByToken) continue; // claim was ignored → the whole write is skipped

      const del = sql.match(/^DELETE FROM price_snapshot WHERE utc_day = '([^']+)'/);
      if (del && !sql.includes('utc_day <')) {
        this.rows = this.rows.filter((r) => r.utc_day !== del[1]);
        continue;
      }
      const retention = sql.match(/^DELETE FROM price_snapshot WHERE utc_day < '([^']+)'/);
      if (retention) {
        this.rows = this.rows.filter((r) => r.utc_day >= retention[1]);
        continue;
      }
      const insert = sql.match(/^INSERT OR REPLACE INTO price_snapshot \(([^)]+)\) SELECT (.*) WHERE /s);
      if (insert) {
        const columns = insert[1].split(',').map((c) => c.trim());
        const values = splitSqlValues(insert[2]);
        const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
        const existing = this.rows.findIndex(
          (r) => r.offering_key === row.offering_key && r.utc_day === row.utc_day,
        );
        if (existing >= 0) this.rows[existing] = { ...this.rows[existing], ...row };
        else this.rows.push(row);
      }
    }
    return [];
  }
}

function splitSqlValues(text) {
  // Splits a SQL VALUES list. Tracks quote state AND parenthesis depth so a
  // function literal like strftime('%Y-%m-%dT%H:%M:%fZ', 'now') stays one value
  // even though it contains both a comma and quoted text.
  const values = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === "'" && text[i + 1] === "'") { current += "''"; i++; continue; }
      if (char === "'") { quoted = false; current += char; continue; }
      current += char;
      continue;
    }
    if (char === "'") { quoted = true; current += char; continue; }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { values.push(current.trim()); current = ''; continue; }
    current += char;
  }
  values.push(current.trim());
  return values.map((value) => {
    const text_ = value.trim();
    if (text_ === 'NULL') return null;
    // Keep a function literal intact so the test can detect a refreshed claim.
    if (/^strftime\(/i.test(text_)) return text_;
    if (/^-?\d+(\.\d+)?$/.test(text_)) return Number(text_);
    return text_.replace(/^'([\s\S]*)'$/, '$1');
  });
}

// ── Fixture rows ──────────────────────────────────────────────────────────────

/** Same canonical model, two providers whose cheapest rank depends on the mix. */
function row(day, provider, { input, output, cache_read, discount = 0, modelId = 'google/gemini-3.1-pro', quantization = '' }) {
  return {
    utc_day: day,
    offering_key: `gemini-3.1-pro|${provider}|${quantization}|`,
    canonical_model: 'gemini-3.1-pro',
    provider,
    quantization,
    sku: '',
    model_id: modelId,
    model_name: modelId,
    org: 'google',
    input_price: input,
    output_price: output,
    cache_read,
    cache_write: null,
    discount,
    source_generated_at: '2026-09-14T02:00:00Z',
  };
}

function makeAssets() {
  return {
    async fetch(url) {
      const u = new URL(url);
      if (u.pathname === '/pricing.json') {
        return new Response(await readFile(join(FIXTURES, 'pricing.json'), 'utf-8'), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    },
  };
}

function makeContext(pathname, search = '', db) {
  const env = { ASSETS: makeAssets() };
  if (db) env.PRICE_HISTORY = db;
  return { request: new Request(`https://tokenwatch.test${pathname}${search}`), env };
}

async function getJson(ctx) {
  const res = await onRequestGet(ctx);
  return { status: res.status, body: await res.json() };
}

/** Day `n` days before `today`, in the UTC calendar. */
function dayBefore(today, n) {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
}

const TODAY = new Date().toISOString().slice(0, 10);
const HISTORY_PATH = '/api/v1/models/gemini-3.1-pro/history';

// ── Response shape ────────────────────────────────────────────────────────────

test('history returns the documented envelope with an ordered, capped point list', async () => {
  const db = new MockD1([
    row(dayBefore(TODAY, 2), 'deepinfra', { input: 1.25, output: 5, cache_read: 0.31 }),
    row(dayBefore(TODAY, 1), 'google', { input: 0.1, output: 7, cache_read: 0.1 }),
    row(TODAY, 'deepinfra', { input: 1.25, output: 5, cache_read: 0.31 }),
  ]);
  const { status, body } = await getJson(makeContext(HISTORY_PATH, '', db));

  assert.equal(status, 200);
  assert.equal(body.canonical_id, 'gemini-3.1-pro');
  assert.equal(body.days, 90);
  assert.deepEqual(body.mix, { input: 2.5, cache_read: 97, output: 0.5 });
  assert.equal(body.point_count, 3);
  assert.deepEqual(body.points.map((p) => p.day), [
    dayBefore(TODAY, 2), dayBefore(TODAY, 1), TODAY,
  ]);
  // Every point carries the raw components that produced the blend.
  for (const point of body.points) {
    assert.ok('input' in point && 'output' in point && 'cache_read' in point);
    assert.ok(typeof point.blended === 'number');
    assert.ok(typeof point.provider === 'string');
  }
});

test('history queries only the requested model and day window, with bound parameters', async () => {
  const db = new MockD1([]);
  await getJson(makeContext(HISTORY_PATH, '?days=7', db));
  assert.equal(db.captured.length, 1);
  const query = db.captured[0];
  assert.match(query.sql, /FROM price_snapshot/);
  assert.match(query.sql, /canonical_model = \?/);
  assert.match(query.sql, /ORDER BY utc_day ASC/);
  assert.deepEqual(query.bindings, ['gemini-3.1-pro', dayBefore(TODAY, 6), TODAY]);
  // No interpolation of user input into the SQL text.
  assert.doesNotMatch(query.sql, /gemini/);
});

test('history caps output at 90 points even when more rows exist', async () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push(row(dayBefore(TODAY, i), 'deepinfra', { input: 1, output: 2, cache_read: 0.1 }));
  }
  const db = new MockD1(rows);
  const { body } = await getJson(makeContext(HISTORY_PATH, '?days=90', db));
  assert.equal(body.point_count, 90);
  assert.ok(body.points.length <= 90);
  assert.equal(body.points.at(-1).day, TODAY, 'the newest point must be retained');
  // Strictly ascending order.
  for (let i = 1; i < body.points.length; i++) {
    assert.ok(body.points[i].day > body.points[i - 1].day);
  }
});

// ── Mix semantics ─────────────────────────────────────────────────────────────

test('cheapest provider inverts when the requested mix changes, from identical raw rows', async () => {
  const db = new MockD1([
    // alpha: cheap cache, expensive output. beta: expensive cache, cheap output.
    row(TODAY, 'alpha', { input: 1, output: 40, cache_read: 0.1 }),
    row(TODAY, 'beta', { input: 1, output: 2, cache_read: 5 }),
  ]);

  const cacheHeavy = await getJson(makeContext(HISTORY_PATH, '?mix=2.5,97,0.5', db));
  assert.equal(cacheHeavy.body.points[0].provider, 'alpha');
  assert.equal(cacheHeavy.body.mix.cache_read, 97);

  const outputHeavy = await getJson(makeContext(HISTORY_PATH, '?mix=10,0,90', db));
  assert.equal(outputHeavy.body.points[0].provider, 'beta');
  assert.deepEqual(outputHeavy.body.mix, { input: 10, cache_read: 0, output: 90 });
});

test('series lists every offering of the day so a provider switch needs no extra request', async () => {
  const db = new MockD1([
    row(TODAY, 'alpha', { input: 1, output: 40, cache_read: 0.1 }),
    row(TODAY, 'beta', { input: 1, output: 2, cache_read: 5 }),
  ]);
  const { body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.equal(body.series.length, 1);
  assert.deepEqual(body.series[0].day, TODAY);
  assert.deepEqual(body.series[0].offerings.map((o) => o.provider).sort(), ['alpha', 'beta']);
});

test('cache_read null falls back to the input price instead of disqualifying the offering', async () => {
  const db = new MockD1([
    // No cache price published: 2.5%×2 + 97%×2 (input fallback) + 0.5%×8 = 2.03
    row(TODAY, 'alpha', { input: 2, output: 8, cache_read: null }),
  ]);
  const { body } = await getJson(makeContext(HISTORY_PATH, '?mix=2.5,97,0.5', db));
  assert.equal(body.point_count, 1);
  assert.equal(body.points[0].provider, 'alpha');
  assert.equal(body.points[0].blended, 2.03);
  // If null were treated as $0 the blend would be 0.09.
  assert.notEqual(body.points[0].blended, 0.09);
  assert.equal(body.points[0].cache_read, null, 'the raw null must survive to the response');
});

test('a promotion is carried on the point and can flip the daily cheapest provider', async () => {
  const db = new MockD1([
    row(dayBefore(TODAY, 1), 'beta', { input: 1, output: 2, cache_read: 5 }),
    row(TODAY, 'beta', { input: 1, output: 2, cache_read: 5, discount: 0.9 }),
  ]);
  const { body } = await getJson(makeContext(HISTORY_PATH, '?mix=10,0,90', db));
  assert.equal(body.points[1].discount, 0.9);
  assert.equal(body.points[0].discount, 0);
});

// ── Missing data ──────────────────────────────────────────────────────────────

test('a missing day is absent from the series, never a $0 point', async () => {
  const db = new MockD1([
    row(dayBefore(TODAY, 3), 'deepinfra', { input: 1, output: 2, cache_read: 0.1 }),
    // days 2 and 1 are missing entirely
    row(TODAY, 'deepinfra', { input: 1, output: 2, cache_read: 0.1 }),
  ]);
  const { body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.equal(body.point_count, 2);
  assert.deepEqual(body.points.map((p) => p.day), [dayBefore(TODAY, 3), TODAY]);
  assert.equal(body.points.some((p) => p.blended === 0), false);
});

test('a provider that disappears and reappears keeps its identity in the series', async () => {
  const db = new MockD1([
    row(dayBefore(TODAY, 2), 'alpha', { input: 1, output: 2, cache_read: 0.1 }),
    row(dayBefore(TODAY, 2), 'beta', { input: 2, output: 3, cache_read: 0.2 }),
    row(dayBefore(TODAY, 1), 'alpha', { input: 1, output: 2, cache_read: 0.1 }), // beta gone
    row(TODAY, 'alpha', { input: 1, output: 2, cache_read: 0.1 }),
    row(TODAY, 'beta', { input: 2, output: 3, cache_read: 0.2 }), // beta back
  ]);
  const { body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.deepEqual(body.series.map((s) => s.offerings.length), [2, 1, 2]);
  assert.equal(body.provider_switches, 0); // alpha stays cheapest throughout
});

test('quantized and plain variants of one model stay distinct offerings', async () => {
  const db = new MockD1([
    row(TODAY, 'deepinfra', { input: 1, output: 4, cache_read: 0.1 }),
    row(TODAY, 'deepinfra', {
      input: 0.4, output: 2, cache_read: 0.04,
      modelId: 'google/gemini-3.1-pro-fp8', quantization: 'fp8',
    }),
  ]);
  const { body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.equal(body.series[0].offerings.length, 2);
  assert.deepEqual(
    body.series[0].offerings.map((o) => o.quantization).sort(),
    ['fp8', null],
  );
  assert.equal(body.points[0].quantization, 'fp8', 'the cheaper quant wins the day');
});

// ── Parameter validation ──────────────────────────────────────────────────────

test('malformed and out-of-range parameters return 400 with a named parameter', async () => {
  const db = new MockD1([]);
  const cases = [
    ['?days=0', 'days'],
    ['?days=91', 'days'],
    ['?days=abc', 'days'],
    ['?days=1.5', 'days'],
    ['?mix=10,10,10', 'mix'],
    ['?mix=2.5,97', 'mix'],
    ['?mix=a,b,c', 'mix'],
    ['?mix=2.5,97,-0.5', 'mix'],
  ];
  for (const [search, parameter] of cases) {
    const { status, body } = await getJson(makeContext(HISTORY_PATH, search, db));
    assert.equal(status, 400, `${search} must be a 400`);
    assert.equal(body.parameter, parameter);
    assert.ok(body.error);
  }
  // A rejected request must never reach the database.
  assert.equal(db.captured.length, 0);
});

test('valid boundary parameters are accepted', async () => {
  const db = new MockD1([]);
  for (const search of ['?days=1', '?days=90', '?mix=100,0,0', '?mix=0,0,100', '?mix=33.33,33.33,33.34']) {
    const { status } = await getJson(makeContext(HISTORY_PATH, search, db));
    assert.equal(status, 200, `${search} must be accepted`);
  }
});

test('an unknown model returns 404 without touching the database', async () => {
  const db = new MockD1([]);
  const { status, body } = await getJson(makeContext('/api/v1/models/no-such-model/history', '', db));
  assert.equal(status, 404);
  assert.equal(body.error, 'Model not found');
  assert.equal(db.captured.length, 0);
});

test('an empty history is a 200 with zero points, not an error', async () => {
  const db = new MockD1([]);
  const { status, body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.equal(status, 200);
  assert.equal(body.point_count, 0);
  assert.deepEqual(body.points, []);
  assert.deepEqual(body.series, []);
});

test('malformed %-encoding returns 400 JSON rather than an uncaught URIError', async () => {
  const db = new MockD1([]);
  const res = await onRequestGet(makeContext('/api/v1/models/%E0%A4%A/history', '', db));
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal((await res.json()).error, 'Invalid model id encoding');
});

test('a missing PRICE_HISTORY binding is a 503, not a silent empty history', async () => {
  const { status, body } = await getJson(makeContext(HISTORY_PATH));
  assert.equal(status, 503);
  assert.match(body.error, /not configured/i);
  assert.equal('points' in body, false);
});

test('a database failure is reported as 503 instead of an empty chart', async () => {
  const db = new MockD1([]);
  db.failNext = new Error('no such table: price_snapshot');
  const { status, body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.equal(status, 503);
  assert.match(body.error, /Failed to read price history/);
  assert.match(body.detail, /no such table/);
});

test('the history route is discoverable from the API directory', async () => {
  const { body } = await getJson(makeContext('/api/v1/'));
  assert.ok(body.endpoints.some((line) => line.includes('/api/v1/models/:canonicalId/history')));
});

// ── End-to-end: writer batch -> mock D1 -> API ────────────────────────────────

test('running the writer twice then reading history yields one row per offering per day', async () => {
  const models = [
    { id: 'google/gemini-3.1-pro', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 1.25, output: 5, cache_read: 0.31 } },
    { id: 'google/gemini-3.1-pro-preview', provider: 'google', quantization: null, discount: 0, pricing: { input: 0.1, output: 7, cache_read: 0.1 } },
  ];
  const db = new MockD1([]);

  const first = buildSnapshotStatements(models, TODAY, 'gen');
  await db.batch(first.statements);
  const afterFirst = db.rows.length;

  // An exact retry of the claiming run writes nothing: the claim is ignored and
  // every guarded statement is skipped.
  await db.batch(buildSnapshotStatements(models, TODAY, 'gen').statements);
  assert.equal(db.rows.length, afterFirst, 'a retry must not duplicate rows');

  const { status, body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.equal(status, 200);
  assert.equal(body.point_count, 1);
  assert.equal(body.series[0].offerings.length, 2, 'both providers present exactly once');
});

test('the first successful catalog owns the UTC day; a later same-day catalog cannot change it', async () => {
  // The exact scenario the day-claim invariant exists for: catalog A writes
  // price A for one offering. Later the same UTC day, catalog B has a CHANGED
  // price for that offering AND a newly appearing offering. The stored day must
  // remain exactly A's catalog — no rewritten price, no appended newcomer.
  const catalogA = [
    { id: 'google/gemini-3.1-pro', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 1, output: 2, cache_read: 0.1 } },
  ];
  const catalogB = [
    { id: 'google/gemini-3.1-pro', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 99, output: 99, cache_read: 99 } },
    { id: 'google/gemini-3.1-pro-preview', provider: 'google', quantization: null, discount: 0, pricing: { input: 5, output: 5, cache_read: 5 } },
  ];
  const db = new MockD1([]);

  await db.batch(buildSnapshotStatements(catalogA, TODAY, '2030-01-01T00:05:00Z').statements);
  assert.equal(db.rows.length, 1);

  await db.batch(buildSnapshotStatements(catalogB, TODAY, '2030-01-01T06:00:00Z').statements);

  // Exactly A's catalog: one row, A's prices, and the newcomer is absent.
  assert.equal(db.rows.length, 1, 'catalog B must not append the newly appearing offering');
  assert.equal(db.rows[0].offering_key, 'gemini-3.1-pro|deepinfra||');
  assert.equal(db.rows[0].input_price, 1);
  assert.equal(db.rows[0].output_price, 2);
  assert.equal(db.rows[0].cache_read, 0.1);
  assert.equal(db.rows.some((r) => r.provider === 'google'), false, 'the newcomer must stay absent');

  // And the claim still records catalog A as the day's owner.
  assert.equal(db.dayClaims.get(TODAY).source_generated_at, '2030-01-01T00:05:00Z');
  assert.equal(db.dayClaims.get(TODAY).offering_count, 1);

  // The API therefore reports A's price, not B's.
  const { body } = await getJson(makeContext(HISTORY_PATH, '', db));
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0].input, 1);
  assert.equal(body.points[0].provider, 'deepinfra');
  // 2.5% × 1 + 97% × 0.1 + 0.5% × 2
  assert.equal(body.points[0].blended.toFixed(6), (0.025 + 0.097 + 0.01).toFixed(6));
});

test('a day claimed by a crashed run is not silently repopulated by a later refresh', async () => {
  const models = [
    { id: 'google/gemini-3.1-pro', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 1.25, output: 5, cache_read: 0.31 } },
  ];
  const db = new MockD1([]);
  const full = buildSnapshotStatements(models, TODAY, 'gen');
  // Simulate a crash after the claim statement committed but before any row.
  await db.batch(full.statements.slice(0, 1));
  assert.equal(db.rows.length, 0);
  assert.equal(db.dayClaims.has(TODAY), true);

  // A later refresh cannot take over the day: its token never landed.
  await db.batch(buildSnapshotStatements(models, TODAY, 'gen').statements);
  assert.equal(db.rows.length, 0);

  // The explicit recovery path re-claims and repopulates.
  await db.batch(buildSnapshotStatements(models, TODAY, 'gen', 90, { force: true }).statements);
  assert.equal(db.rows.length, 1);
});

test('--force replaces both the rows and the day claim metadata', async () => {
  // Real-D1 counterpart of the statement-level assertion: after a forced
  // replacement the stored rows AND the claim row must both describe catalog B.
  const catalogA = [
    { id: 'google/gemini-3.1-pro', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 1, output: 2, cache_read: 0.1 } },
  ];
  const catalogB = [
    { id: 'google/gemini-3.1-pro', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 99, output: 99, cache_read: 99 } },
    { id: 'google/gemini-3.1-pro-preview', provider: 'google', quantization: null, discount: 0, pricing: { input: 5, output: 5, cache_read: 5 } },
  ];
  const db = new MockD1([]);

  await db.batch(buildSnapshotStatements(catalogA, TODAY, '2030-01-01T00:05:00Z').statements);
  assert.equal(db.dayClaims.get(TODAY).offering_count, 1);
  assert.equal(db.dayClaims.get(TODAY).source_generated_at, '2030-01-01T00:05:00Z');

  // Force-replace with catalog B.
  await db.batch(buildSnapshotStatements(catalogB, TODAY, '2030-01-01T06:00:00Z', 90, { force: true }).statements);

  // Rows: exactly B's two offerings at B's prices.
  assert.equal(db.rows.length, 2);
  assert.deepEqual(
    db.rows.map((r) => [r.offering_key, r.input_price]).sort(),
    [['gemini-3.1-pro|deepinfra||', 99], ['gemini-3.1-pro|google||', 5]].sort(),
  );

  // Claim: refreshed to describe B, not A.
  const claim = db.dayClaims.get(TODAY);
  assert.equal(claim.offering_count, 2, 'claim must describe the replacement snapshot');
  assert.equal(claim.source_generated_at, '2030-01-01T06:00:00Z');
  assert.equal(claim.claimed_at, 'refreshed', 'claimed_at must be refreshed on a forced replacement');
});

test('retention keeps day 90 and prunes day 91 across a writer run', async () => {
  const models = [
    { id: 'google/gemini-3.1-pro', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 1, output: 2, cache_read: 0.1 } },
  ];
  const db = new MockD1([]);
  // Seed the boundary: exactly 91 days of rows ending today.
  for (let i = 0; i < 91; i++) {
    const day = dayBefore(TODAY, i);
    db.rows.push({ ...row(day, 'deepinfra', { input: 1, output: 2, cache_read: 0.1 }), canonical_model: 'gemini-3.1-pro' });
  }
  assert.equal(db.rows.length, 91);

  // The writer's retention statement uses the snapshot day as "today".
  const batch = buildSnapshotStatements(models, TODAY, 'gen');
  await db.batch(batch.statements);

  const kept = db.rows.map((r) => r.utc_day);
  assert.equal(kept.includes(dayBefore(TODAY, 89)), true, 'day 90 must survive');
  assert.equal(kept.includes(dayBefore(TODAY, 90)), false, 'day 91 must be pruned');
  assert.equal(new Set(kept).size, 90);

  // And the API still returns at most 90 points for the surviving window.
  const { body } = await getJson(makeContext(HISTORY_PATH, '?days=90', db));
  assert.equal(body.point_count, 90);
});