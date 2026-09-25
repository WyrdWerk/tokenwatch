/**
 * Price-history unit tests: identity, raw-vs-blended storage, read-time mix
 * blending, cheapest-provider inversion, promotions, provider add/remove,
 * missing days, quantized variants, retention windows, and parameter parsing.
 *
 * Fixtures are deliberately asymmetric: providers swap cheapest rank depending
 * on the workload mix, series change value day to day, and days are missing
 * rather than zero-filled. A symmetric fixture would pass even if the code
 * collapsed variants or ignored the mix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MIX,
  MAX_HISTORY_DAYS,
  RETENTION_DAYS,
  blendedRateFor,
  buildHistorySeries,
  capHistoryDays,
  isUtcDay,
  offeringKey,
  parseDaysParam,
  parseMixParam,
  retentionCutoff,
  shiftUtcDay,
  skuFromId,
  toSnapshotRow,
  utcDay,
  windowStartDay,
} from '../shared/price-history.mjs';
import { buildSnapshotStatements } from '../scripts/snapshot-prices.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CACHE_MIX = { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 };
const OUTPUT_MIX = { inputPct: 10, cacheReadPct: 0, outputPct: 90 };

/** Two providers of the same canonical model whose cheapest rank depends on mix. */
function inversionRows(day) {
  return [
    // Cache-heavy provider: cheap cache reads, expensive output.
    {
      utc_day: day, offering_key: `cheap-cache|alpha||`, provider: 'alpha',
      model_id: 'org/model', quantization: '', input_price: 1.0,
      output_price: 40.0, cache_read: 0.1, discount: 0,
    },
    // Output-heavy provider: expensive cache reads, cheap output.
    {
      utc_day: day, offering_key: `cheap-output|beta||`, provider: 'beta',
      model_id: 'org/model', quantization: '', input_price: 1.0,
      output_price: 2.0, cache_read: 5.0, discount: 0,
    },
  ];
}

// ── UTC day helpers ───────────────────────────────────────────────────────────

test('utcDay returns the UTC calendar day, not the local day', () => {
  assert.equal(utcDay(new Date('2026-09-14T23:59:59.999Z')), '2026-09-14');
  assert.equal(utcDay(new Date('2026-09-15T00:00:00.000Z')), '2026-09-15');
  assert.equal(utcDay('2026-01-02T05:00:00Z'), '2026-01-02');
});

test('utcDay rejects an unparseable timestamp instead of returning NaN text', () => {
  assert.throws(() => utcDay('not-a-date'), /invalid date/);
});

test('isUtcDay rejects real-looking but impossible dates', () => {
  assert.equal(isUtcDay('2026-09-14'), true);
  assert.equal(isUtcDay('2026-02-30'), false); // Date would roll this to March 2
  assert.equal(isUtcDay('2026-9-14'), false);
  assert.equal(isUtcDay(''), false);
  assert.equal(isUtcDay(null), false);
});

test('shiftUtcDay crosses month and year boundaries in UTC', () => {
  assert.equal(shiftUtcDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftUtcDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftUtcDay('2026-09-14', 1), '2026-09-15');
});

test('windowStartDay keeps today and the preceding days-1 days', () => {
  // days=90 must span exactly 90 calendar days including today.
  assert.equal(windowStartDay('2026-09-14', 90), '2026-06-17');
  assert.equal(windowStartDay('2026-09-14', 1), '2026-09-14');
  assert.equal(shiftUtcDay(windowStartDay('2026-09-14', 90), 89), '2026-09-14');
});

test('retentionCutoff keeps exactly RETENTION_DAYS days and drops day 91', () => {
  const cutoff = retentionCutoff('2026-09-14', RETENTION_DAYS);
  assert.equal(cutoff, '2026-06-17');
  // Day 90 (the cutoff) survives; the day before it is pruned.
  assert.equal(cutoff <= '2026-06-17', true);
  assert.equal('2026-06-16' < cutoff, true);
});

// ── Offering identity ─────────────────────────────────────────────────────────

test('offeringKey keeps quantization, SKU, and provider distinct', () => {
  const base = { modelId: 'org/model', provider: 'Alpha', quantization: null, sku: '' };
  const quant = { ...base, modelId: 'org/model-fp8', quantization: 'fp8' };
  const batch = { ...base, modelId: 'org/model:batch', sku: ':batch' };
  const otherProvider = { ...base, provider: 'beta' };

  const keys = new Set([base, quant, batch, otherProvider].map(offeringKey));
  assert.equal(keys.size, 4, 'quant/batch/provider variants must not collapse into one key');
  // Provider case is normalized so 'Alpha' and 'alpha' cannot fork one offering.
  assert.equal(offeringKey({ ...base, provider: 'alpha' }), offeringKey(base));
});

test('skuFromId names the variant suffixes canonicalId deliberately preserves', () => {
  assert.equal(skuFromId('openai/gpt-5-nano:batch'), ':batch');
  assert.equal(skuFromId('org/model-turbo'), '-turbo');
  assert.equal(skuFromId('org/model-fp8'), ''); // quantization, not SKU
  assert.equal(skuFromId('org/model'), '');
});

test('canonicalId unifies provider prefixes so one offering is one history row', () => {
  // Same offering reached through two id spellings must produce one key.
  const a = toSnapshotRow(
    { id: 'zai-org/GLM-5.2', provider: 'novita', quantization: null, pricing: { input: 1, output: 2 } },
    '2026-09-14', 'gen',
  );
  const b = toSnapshotRow(
    { id: 'GLM-5.2', provider: 'novita', quantization: null, pricing: { input: 1, output: 2 } },
    '2026-09-14', 'gen',
  );
  assert.equal(a.offering_key, b.offering_key);
  assert.equal(a.canonical_model, 'glm-5.2');
});

test('toSnapshotRow stores raw components and never a blended price', () => {
  const row = toSnapshotRow(
    {
      id: 'org/model', provider: 'alpha', quantization: 'fp8', discount: 0.7,
      pricing: { input: 1.5, output: 9, cache_read: 0.15, cache_write: 2 },
    },
    '2026-09-14', '2026-09-14T02:00:00Z',
  );
  assert.equal(row.input_price, 1.5);
  assert.equal(row.output_price, 9);
  assert.equal(row.cache_read, 0.15);
  assert.equal(row.cache_write, 2);
  assert.equal(row.discount, 0.7);
  assert.equal(row.quantization, 'fp8');
  assert.equal(row.source_generated_at, '2026-09-14T02:00:00Z');
  // A blended column must not exist on the stored row at all.
  assert.equal('blended' in row, false);
});

test('toSnapshotRow keeps null cache_read null rather than zeroing it', () => {
  const row = toSnapshotRow(
    { id: 'org/m', provider: 'alpha', pricing: { input: 2, output: 3, cache_read: null } },
    '2026-09-14', 'gen',
  );
  assert.equal(row.cache_read, null);
  assert.notEqual(row.cache_read, 0);
});

test('toSnapshotRow skips an offering with no published price at all', () => {
  assert.equal(toSnapshotRow(
    { id: 'org/m', provider: 'alpha', pricing: { input: null, output: null, cache_read: null, cache_write: null } },
    '2026-09-14', 'gen',
  ), null);
  assert.equal(toSnapshotRow({ id: 'org/m', provider: 'alpha' }, '2026-09-14', 'gen'), null);
});

test('toSnapshotRow rejects negative placeholder prices instead of storing them', () => {
  const row = toSnapshotRow(
    { id: 'org/m', provider: 'alpha', pricing: { input: -1000000, output: 3 } },
    '2026-09-14', 'gen',
  );
  assert.equal(row.input_price, null);
  assert.equal(row.output_price, 3);
});

// ── Read-time blending ────────────────────────────────────────────────────────

test('blendedRateFor applies the mix at read time from raw components', () => {
  const row = { input_price: 2, output_price: 8, cache_read: 0.2 };
  // 2.5% × 2 + 97% × 0.2 + 0.5% × 8 = 0.05 + 0.194 + 0.04
  assert.equal(blendedRateFor(row, CACHE_MIX).toFixed(6), '0.284000');
  // 10% × 2 + 90% × 8 = 0.2 + 7.2
  assert.equal(blendedRateFor(row, OUTPUT_MIX).toFixed(6), '7.400000');
  // The raw row is untouched by blending.
  assert.deepEqual(row, { input_price: 2, output_price: 8, cache_read: 0.2 });
});

test('cache_read null falls back to the input price, never to zero', () => {
  const row = { input_price: 2, output_price: 8, cache_read: null };
  // 97% of cached tokens bill at the input rate: 0.05 + 1.94 + 0.04
  assert.equal(blendedRateFor(row, CACHE_MIX).toFixed(6), '2.030000');
  // Contrast with a zero-cache row: if null were treated as $0 the result
  // would be 0.09, so this assertion would fail.
  assert.notEqual(blendedRateFor(row, CACHE_MIX).toFixed(6), '0.090000');
});

test('a mix leg with no price disqualifies the offering only when the mix requests it', () => {
  const row = { input_price: null, output_price: 8, cache_read: null };
  // The cache leg falls back to the (null) input price and contributes $0 —
  // it never disqualifies. The input leg does, because CACHE_MIX requests 2.5%.
  assert.equal(blendedRateFor(row, CACHE_MIX), null);
  assert.equal(blendedRateFor(row, { inputPct: 0, cacheReadPct: 97, outputPct: 3 }).toFixed(6), '0.240000');
  assert.equal(blendedRateFor(row, { inputPct: 0, cacheReadPct: 0, outputPct: 100 }).toFixed(6), '8.000000');
});

// ── Series construction ───────────────────────────────────────────────────────

test('cheapest provider inverts with the workload mix on the same raw rows', () => {
  const rows = inversionRows('2026-09-14');

  const cacheHeavy = buildHistorySeries(rows, CACHE_MIX);
  assert.equal(cacheHeavy.length, 1);
  assert.equal(cacheHeavy[0].point.provider, 'alpha',
    'cache-heavy mix must rank the cheap-cache provider first');

  const outputHeavy = buildHistorySeries(rows, OUTPUT_MIX);
  assert.equal(outputHeavy[0].point.provider, 'beta',
    'output-heavy mix must invert the ranking to the cheap-output provider');

  // The stored raw rows are identical in both calls — only the read-time blend differs.
  assert.deepEqual(rows, inversionRows('2026-09-14'));
});

test('series carries every offering for the day so a provider switch needs one request', () => {
  const days = buildHistorySeries(inversionRows('2026-09-14'), CACHE_MIX);
  assert.deepEqual(days[0].series.map((s) => s.provider), ['alpha', 'beta']);
  assert.equal(days[0].series.length, 2);
});

test('points are chronologically ascending even when rows arrive unordered', () => {
  const rows = [
    ...inversionRows('2026-09-12'),
    ...inversionRows('2026-09-14'),
    ...inversionRows('2026-09-13'),
  ];
  const days = buildHistorySeries(rows, CACHE_MIX);
  assert.deepEqual(days.map((d) => d.day), ['2026-09-12', '2026-09-13', '2026-09-14']);
});

test('a day with no rows stays absent instead of becoming a $0 point', () => {
  const rows = [
    ...inversionRows('2026-09-10'),
    // 2026-09-11 is genuinely missing
    ...inversionRows('2026-09-12'),
  ];
  const days = buildHistorySeries(rows, CACHE_MIX);
  assert.deepEqual(days.map((d) => d.day), ['2026-09-10', '2026-09-12']);
  assert.equal(days.some((d) => d.point.blended === 0), false);
});

test('a day where no offering can be priced under the mix is dropped, not zero-filled', () => {
  const rows = [{
    utc_day: '2026-09-14', offering_key: 'k|alpha||', provider: 'alpha',
    model_id: 'org/m', quantization: '', input_price: null, output_price: null,
    cache_read: null, discount: 0,
  }];
  assert.deepEqual(buildHistorySeries(rows, CACHE_MIX), []);
});

test('providers can be added, removed, and reappear without collapsing identity', () => {
  const rows = [
    ...inversionRows('2026-09-10'), // alpha + beta
    ...inversionRows('2026-09-11').filter((r) => r.provider === 'alpha'), // beta removed
    ...inversionRows('2026-09-12'), // beta returns
  ];
  const days = buildHistorySeries(rows, CACHE_MIX);
  assert.deepEqual(days.map((d) => d.series.length), [2, 1, 2]);
  assert.equal(days[1].point.provider, 'alpha');
  assert.deepEqual(days[2].series.map((s) => s.provider), ['alpha', 'beta']);
});

test('an active promotion is visible in the point and shifts the cheapest provider', () => {
  // beta is normally cheaper on the cache mix; alpha runs a 90%-off promo day.
  const promoDay = inversionRows('2026-09-11').map((row) =>
    row.provider === 'alpha'
      ? { ...row, discount: 0.9, input_price: 0.1, cache_read: 0.01 }
      : row);
  const days = buildHistorySeries([...inversionRows('2026-09-10'), ...promoDay], CACHE_MIX);
  assert.equal(days[0].point.provider, 'alpha'); // baseline: alpha already cheapest
  assert.equal(days[1].point.provider, 'alpha');
  assert.equal(days[1].point.discount, 0.9, 'promo fraction must be carried on the point');
  // And the promo day is genuinely cheaper than the non-promo day.
  assert.ok(days[1].point.blended < days[0].point.blended);
});

test('quantized variants stay distinct offerings on the same day', () => {
  const rows = [
    {
      utc_day: '2026-09-14', offering_key: 'm-fp8|alpha|fp8|', provider: 'alpha',
      model_id: 'org/m-fp8', quantization: 'fp8', input_price: 0.4, output_price: 2,
      cache_read: 0.04, discount: 0,
    },
    {
      utc_day: '2026-09-14', offering_key: 'm|alpha||', provider: 'alpha',
      model_id: 'org/m', quantization: '', input_price: 1, output_price: 4,
      cache_read: 0.1, discount: 0,
    },
  ];
  const days = buildHistorySeries(rows, CACHE_MIX);
  assert.equal(days[0].series.length, 2, 'fp8 and non-quant are separate offerings');
  assert.deepEqual(days[0].series.map((s) => s.quantization), ['fp8', null]);
  // The cheaper quant wins the day but both remain in the series.
  assert.equal(days[0].point.quantization, 'fp8');
});

test('ties break deterministically on provider then offering key', () => {
  const tied = (provider) => ({
    utc_day: '2026-09-14', offering_key: `k|${provider}||`, provider,
    model_id: 'org/m', quantization: '', input_price: 1, output_price: 2,
    cache_read: 0.1, discount: 0,
  });
  const forward = buildHistorySeries([tied('beta'), tied('alpha')], CACHE_MIX);
  const reverse = buildHistorySeries([tied('alpha'), tied('beta')], CACHE_MIX);
  assert.equal(forward[0].point.provider, 'alpha');
  assert.equal(reverse[0].point.provider, 'alpha');
});

test('rows with a malformed day are ignored rather than producing a bad point', () => {
  const rows = [
    { utc_day: 'not-a-day', offering_key: 'k|alpha||', provider: 'alpha', input_price: 1, output_price: 2, cache_read: 0.1, discount: 0, quantization: '', model_id: 'org/m' },
    ...inversionRows('2026-09-14'),
  ];
  assert.deepEqual(buildHistorySeries(rows, CACHE_MIX).map((d) => d.day), ['2026-09-14']);
});

// ── Point cap ─────────────────────────────────────────────────────────────────

test('capHistoryDays returns at most 90 points and keeps the newest', () => {
  const days = Array.from({ length: 120 }, (_, i) => ({
    day: `2026-01-${String(i + 1).padStart(2, '0')}`,
    point: { day: `d${i}` },
  }));
  const capped = capHistoryDays(days, MAX_HISTORY_DAYS);
  assert.equal(capped.length, 90);
  assert.equal(capped[0].point.day, 'd30', 'oldest 30 points are dropped, not the newest');
  assert.equal(capped[89].point.day, 'd119');
  // Chronological order is preserved.
  assert.deepEqual(capped.map((d) => d.point.day), [...capped.map((d) => d.point.day)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
});

test('capHistoryDays is a no-op below the cap', () => {
  const days = [{ day: '2026-09-14', point: { day: '2026-09-14' } }];
  assert.equal(capHistoryDays(days, MAX_HISTORY_DAYS), days);
});

// ── Parameter parsing ─────────────────────────────────────────────────────────

test('parseMixParam accepts the documented default mix and returns it', () => {
  const parsed = parseMixParam('2.5,97,0.5');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.mix, DEFAULT_MIX);
});

test('parseMixParam defaults when the parameter is absent or empty', () => {
  assert.deepEqual(parseMixParam(null).mix, DEFAULT_MIX);
  assert.deepEqual(parseMixParam('').mix, DEFAULT_MIX);
});

test('parseMixParam rejects malformed and out-of-range mixes instead of coercing them', () => {
  for (const bad of ['2.5,97', '2.5,97,0.5,1', 'a,b,c', '2.5,97,-0.5', '10,10,10', '', 'NaN,0,0']) {
    const parsed = parseMixParam(bad);
    if (bad === '') continue; // empty means "use the default"
    assert.equal(parsed.ok, false, `mix ${JSON.stringify(bad)} must be rejected`);
    assert.ok(parsed.error);
  }
});

test('parseMixParam tolerates float rounding in a 33.33-style mix', () => {
  assert.equal(parseMixParam('33.33,33.33,33.34').ok, true);
  assert.equal(parseMixParam('99.7,0,0.3').ok, true);
});

test('parseDaysParam defaults to 90 and accepts the boundary values', () => {
  assert.equal(parseDaysParam(null).days, MAX_HISTORY_DAYS);
  assert.equal(parseDaysParam('1').days, 1);
  assert.equal(parseDaysParam('90').days, 90);
});

test('parseDaysParam rejects zero, negatives, floats, and over-cap values', () => {
  for (const bad of ['0', '-1', '91', '1.5', '90.0', 'abc', '1e2', '+90', '']) {
    const parsed = parseDaysParam(bad);
    if (bad === '') continue; // empty means "use the default"
    assert.equal(parsed.ok, false, `days ${JSON.stringify(bad)} must be rejected`);
  }
});

// ── Statement batch (idempotence / retention / atomicity) ─────────────────────

test('buildSnapshotStatements claims the day, then writes one guarded insert per offering', () => {
  const models = [
    { id: 'org/a', provider: 'alpha', quantization: null, pricing: { input: 1, output: 2 } },
    { id: 'org/b', provider: 'beta', quantization: 'fp8', pricing: { input: 3, output: 4 } },
    // Zero-price rows are dropped by the pipeline before pricing.json exists, so
    // the writer never sees them — but if one appeared it would still be stored
    // as a real $0 offering, not silently skipped. Assert the honest behavior.
    { id: 'org/zero', provider: 'beta', pricing: { input: 0, output: 0 } },
  ];
  const batch = buildSnapshotStatements(models, '2026-09-14', 'gen');
  assert.equal(batch.rowCount, 3);

  const phases = batch.statements.map((s) => s.phase);
  assert.deepEqual(phases, ['claim', 'reset', 'insert', 'insert', 'insert', 'retention']);

  // The claim is the first statement and is an INSERT OR IGNORE, so a re-run
  // cannot overwrite the original claim.
  const claim = batch.statements[0];
  assert.match(claim.sql, /^INSERT OR IGNORE INTO price_snapshot_day/);
  assert.match(claim.sql, /VALUES \('2026-09-14', 3,/);

  // Every write after the claim is gated on this run owning the day, so a
  // second run of the same day writes nothing at all.
  const inserts = batch.statements.filter((s) => s.phase === 'insert');
  assert.equal(inserts.length, 3);
  for (const statement of inserts) {
    assert.match(statement.sql, /^INSERT OR REPLACE INTO price_snapshot/);
    assert.match(statement.sql, /WHERE \(SELECT COUNT\(\*\) FROM price_snapshot_day WHERE utc_day = '2026-09-14' AND claim_token = '/);
  }
  // The reset is guarded so a re-run leaves the claimed day alone.
  const reset = batch.statements.find((s) => s.phase === 'reset');
  assert.match(reset.sql, /AND \(SELECT COUNT\(\*\) FROM price_snapshot_day/);

  // Retention is deliberately NOT guarded: pruning old days must happen on every
  // invocation, including a no-op retry that owns nothing.
  const retention = batch.statements.find((s) => s.phase === 'retention');
  assert.match(retention.sql, /^DELETE FROM price_snapshot WHERE utc_day < '2026-06-17'$/);
  assert.doesNotMatch(retention.sql, /claim_token/);
});

test('retention is unguarded so a no-op retry still prunes old days', () => {
  // A re-run of an already-claimed day writes nothing, but retention is a
  // housekeeping step independent of ownership and must still fire.
  const batch = buildSnapshotStatements(
    [{ id: 'org/a', provider: 'alpha', pricing: { input: 1, output: 2 } }],
    '2026-09-14', 'gen',
  );
  const retention = batch.statements.at(-1);
  assert.equal(retention.phase, 'retention');
  assert.equal(retention.retention, true);
  assert.doesNotMatch(retention.sql, /claim_token/);
  assert.match(retention.sql, /utc_day < '2026-06-17'/);

  // Every insert, by contrast, IS guarded.
  for (const statement of batch.statements.filter((s) => s.phase === 'insert')) {
    assert.match(statement.sql, /claim_token = '/);
  }
});

test('a retry produces an equivalent batch with a distinct claim token', () => {
  const models = [
    { id: 'org/b', provider: 'beta', pricing: { input: 3, output: 4 } },
    { id: 'org/a', provider: 'alpha', pricing: { input: 1, output: 2 } },
  ];
  const first = buildSnapshotStatements(models, '2026-09-14', 'gen');
  const retry = buildSnapshotStatements(models, '2026-09-14', 'gen');

  // The token must differ so a retry cannot satisfy the ownership test and
  // overwrite the day. Everything else about the batch is identical.
  const tokenOf = (batch) => batch.statements[0].sql.match(/VALUES \('[^']*', \d+, [^,]+, '([^']+)'\)/)[1];
  assert.notEqual(tokenOf(first), tokenOf(retry));

  // Normalize BOTH token spellings: the VALUES literal in the claim and the
  // `claim_token = '...'` test in every guarded statement.
  const normalize = (batch) => batch.statements.map((s) => s.sql
    .replace(/VALUES \(('[^']*'), (\d+), ([^,]+), '[^']*'\)/, 'VALUES ($1, $2, $3, ?)')
    .replace(/claim_token = '[^']*'/, 'claim_token = ?'));

  assert.deepEqual(normalize(retry), normalize(first));

  // Input order must not matter either — otherwise a partial retry could write
  // a different statement sequence than the run that failed.
  const reordered = buildSnapshotStatements([...models].reverse(), '2026-09-14', 'gen');
  assert.deepEqual(normalize(reordered), normalize(first));
});

test('a retry after a partial failure is safe: the claim gate covers every write', () => {
  // Simulate a crash after the claim statement of a 2-offering day.
  const models = [
    { id: 'org/a', provider: 'alpha', pricing: { input: 1, output: 2 } },
    { id: 'org/b', provider: 'beta', pricing: { input: 3, output: 4 } },
  ];
  const full = buildSnapshotStatements(models, '2026-09-14', 'gen');
  const partial = full.statements.slice(0, 1); // claim committed, rows never written
  assert.equal(partial[0].phase, 'claim');

  // The retry re-issues the whole batch. Its claim is ignored (the day is
  // taken), and because every write tests for the RETRY's token — which never
  // landed — none of them run. So a crashed day is not silently repopulated by
  // a later refresh; `--force` is the explicit recovery path.
  const retry = buildSnapshotStatements(models, '2026-09-14', 'gen');
  assert.equal(retry.statements.length, full.statements.length);
  assert.match(retry.statements[0].sql, /^INSERT OR IGNORE/);
  // Row writes are all gated; retention is the one unguarded statement.
  for (const statement of retry.statements.slice(1)) {
    if (statement.phase === 'retention') continue;
    assert.match(statement.sql, /claim_token = '/);
  }
});

test('--force replaces the day claim metadata so it describes the new snapshot', () => {
  const batch = buildSnapshotStatements(
    [
      { id: 'org/a', provider: 'alpha', pricing: { input: 1, output: 2 } },
      { id: 'org/b', provider: 'beta', pricing: { input: 3, output: 4 } },
    ],
    '2026-09-14', '2030-01-01T06:00:00Z', 90, { force: true },
  );

  const claim = batch.statements[0];
  // A forced replacement must UPSERT the claim, not ignore it: otherwise
  // offering_count/source_generated_at would still describe the superseded
  // catalog while the stored rows are the new one.
  assert.match(claim.sql, /^INSERT OR REPLACE INTO price_snapshot_day/);
  assert.match(claim.sql, /VALUES \('2026-09-14', strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\), 2, '2030-01-01T06:00:00Z'/);
  assert.match(claim.sql, /offering_count, source_generated_at, claim_token/);

  // Rows are still replaced unconditionally.
  for (const statement of batch.statements.filter((s) => s.phase === 'insert')) {
    assert.match(statement.sql, /1 = 1/);
    assert.doesNotMatch(statement.sql, /claim_token = '/);
  }
});

test('a normal run still uses OR IGNORE so the first catalog keeps the day', () => {
  const batch = buildSnapshotStatements(
    [{ id: 'org/a', provider: 'alpha', pricing: { input: 1, output: 2 } }],
    '2026-09-14', 'gen',
  );
  const claim = batch.statements[0];
  assert.match(claim.sql, /^INSERT OR IGNORE INTO price_snapshot_day/);
  // The non-forced claim does not touch claimed_at; the column default applies
  // only on first insert, which is exactly the first-success semantics.
  assert.doesNotMatch(claim.sql, /claimed_at/);
});

test('retention deletes only rows strictly older than the 90-day window', () => {
  const batch = buildSnapshotStatements(
    [{ id: 'org/a', provider: 'alpha', pricing: { input: 1, output: 2 } }],
    '2026-09-14', 'gen',
  );
  const retention = batch.statements.at(-1);
  assert.equal(retention.retention, true);
  assert.match(retention.sql, /DELETE FROM price_snapshot WHERE utc_day < '2026-06-17'/);
  // Day 90 (2026-06-17) is inside the window and must survive.
  assert.equal('2026-06-17' < batch.cutoff, false);
  assert.equal('2026-06-16' < batch.cutoff, true);
});

test('the retention cutoff follows the snapshot day, not wall-clock time', () => {
  const batch = buildSnapshotStatements(
    [{ id: 'org/a', provider: 'alpha', pricing: { input: 1, output: 2 } }],
    '2026-01-31', 'gen',
  );
  assert.equal(batch.cutoff, '2025-11-03');
  assert.match(batch.statements.at(-1).sql, /'2025-11-03'/);
});

test('nulls and quotes are encoded safely in generated SQL', () => {
  const batch = buildSnapshotStatements(
    [{ id: "org/o'brien", name: null, provider: 'alpha', pricing: { input: 1, output: null } }],
    '2026-09-14', 'gen',
  );
  const sql = batch.statements.find((s) => s.phase === 'insert').sql;
  assert.match(sql, /'org\/o''brien'/);
  assert.match(sql, /NULL/);
  assert.doesNotMatch(sql, /undefined/);
});