import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseNeuralwattEnergyHtml } from '../scripts/fetch-neuralwatt-energy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'neuralwatt-energy.html');

let fixture;
try {
  fixture = await readFile(fixturePath, 'utf8');
} catch {
  fixture = null;
}

// Fail loudly at setup if the fixture is missing — the tests below are meaningless
// without real HTML, and an empty-Map fallback would surface as confusing downstream
// assertion failures (e.g. size === 3) far from the actual cause.
assert.ok(fixture, `neuralwatt-energy.html fixture missing or unreadable at ${fixturePath}`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parse(html) {
  return parseNeuralwattEnergyHtml(html);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('parseNeuralwattEnergyHtml returns Map with correct catalogId keys', () => {
  const map = parse(fixture);
  assert.ok(map instanceof Map, 'should return a Map');
  assert.equal(map.size, 4, 'should have 4 models (GLM-5.2, DeepSeek V4 Flash, Kimi K2.7 Code Fast, Kimi K3)');
  assert.ok(map.has('glm-5.2'), 'should map GLM-5.2 → glm-5.2');
  assert.ok(map.has('deepseek-v4-flash'), 'should map DeepSeek V4 Flash → deepseek-v4-flash');
  assert.ok(map.has('kimi-k2.7-code-fast'), 'should map Kimi K2.7 Code Fast → kimi-k2.7-code-fast');
});

test('parseNeuralwattEnergyHtml converts mWh to Wh (divided by 1000)', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');
  assert.ok(glm52, 'GLM-5.2 should exist');

  // 175.07 mWh → 0.17507 Wh
  assert.equal(glm52.bands['0–256'].wh, 0.17507, '175.07 mWh → 0.17507 Wh');

  // 312.45 mWh → 0.31245 Wh
  assert.equal(glm52.bands['256–1k'].wh, 0.31245, '312.45 mWh → 0.31245 Wh');
});

test('parseNeuralwattEnergyHtml passes Wh through unchanged', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');

  // 1.23 Wh → 1.23 Wh (no conversion)
  assert.equal(glm52.bands['1k–4k'].wh, 1.23, '1.23 Wh → 1.23 Wh');

  // 3.45 Wh → 3.45 Wh
  assert.equal(glm52.bands['4k–16k'].wh, 3.45, '3.45 Wh → 3.45 Wh');
});

test('parseNeuralwattEnergyHtml handles "Gathering data" as null', () => {
  const map = parse(fixture);
  const kimi = map.get('kimi-k2.7-code-fast');
  assert.ok(kimi, 'Kimi K2.7 Code Fast should exist');

  // All bands should be null
  for (const band of Object.values(kimi.bands)) {
    assert.equal(band.wh, null, `band should be null for Wh`);
    assert.equal(band.share, null, `band should be null for share`);
  }
});

test('parseNeuralwattEnergyHtml extracts share percentage', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');

  // 39.9% of reqs → 39.9
  assert.equal(glm52.bands['0–256'].share, 39.9, '39.9% → 39.9');

  // 25.3% → 25.3
  assert.equal(glm52.bands['256–1k'].share, 25.3, '25.3% → 25.3');
});

// Per-band cache-hit is NOT available — the band table carries only energy (Wh)
// and request share. Cache-hit is a model-level figure from the summary cards
// (avg_cache_hit_pct). Bands must never expose a cache_hit_pct field.
test('band objects carry only wh + share (no per-band cache_hit_pct)', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');
  for (const k of Object.keys(glm52.bands)) {
    const b = glm52.bands[k];
    if (!b) continue;
    assert.deepEqual(Object.keys(b).sort(), ['share', 'wh'], `${k} band keys = wh+share only`);
  }
});

test('parseNeuralwattEnergyHtml extracts avg cache-hit % from summary card', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');

  // Card: "measured at a 85% avg cache-hit rate" → 85
  assert.equal(glm52.avg_cache_hit_pct, 85, '85% avg cache-hit from card');

  const deepseek = map.get('deepseek-v4-flash');
  assert.equal(deepseek.avg_cache_hit_pct, 91, 'DeepSeek 91% avg cache-hit from card');
});

test('parseNeuralwattEnergyHtml extracts trend % with correct sign (▲ positive, ▼ negative)', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');

  // Card: "▲ 66% above 7-day avg" → +66 (more energy = expensive)
  assert.equal(glm52.trend_48h_vs_7d_pct, 66, '▲66% above → +66');

  const deepseek = map.get('deepseek-v4-flash');

  // Card: "▼ 12% below 7-day avg" → -12 (less energy = cheaper)
  assert.equal(deepseek.trend_48h_vs_7d_pct, -12, '▼12% below → -12');
});

test('parseNeuralwattEnergyHtml extracts updated_ago from page', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');

  // Page: "updated 8m ago" → "8m ago"
  assert.equal(glm52.updated_ago, '8m ago', 'updated_ago should be "8m ago"');
});

test('parseNeuralwattEnergyHtml includes rate observation + warns on disagreement', async () => {
  // Mock console.warn to capture warnings
  const warnings = [];
  const mockLog = {
    log: () => {},
    warn: (...args) => warnings.push(args.join(' ')),
  };

  // Patch console.warn temporarily
  const originalWarn = console.warn;
  console.warn = mockLog.warn;

  try {
    // Fixture with $10.00/kWh matches config → no warning
    const map = parseNeuralwattEnergyHtml(fixture);
    assert.equal(map.size, 4, 'should parse 4 models');
    assert.equal(warnings.length, 0, 'no warning when rate matches config');
  } finally {
    console.warn = originalWarn;
  }

  // Now test with different rate
  const htmlWithDifferentRate = fixture.replace(
    '$10.00/kWh',
    '$15.00/kWh'
  );

  const warnings2 = [];
  const mockLog2 = {
    log: () => {},
    warn: (...args) => warnings2.push(args.join(' ')),
  };

  const originalWarn2 = console.warn;
  console.warn = mockLog2.warn;

  try {
    const map2 = parseNeuralwattEnergyHtml(htmlWithDifferentRate);
    assert.equal(map2.size, 4, 'should still parse 4 models');
    assert.ok(warnings2.length > 0, 'should warn when rate disagrees with config');
    assert.ok(
      warnings2[0].includes('$15.00'),
      'warning should mention observed rate'
    );
    assert.ok(
      warnings2[0].includes('$10.00'),
      'warning should mention configured rate'
    );
  } finally {
    console.warn = originalWarn2;
  }
});

test('parseNeuralwattEnergyHtml returns empty Map for HTML without table', () => {
  const html = '<html><body>No table here</body></html>';
  const map = parseNeuralwattEnergyHtml(html);
  assert.equal(map.size, 0, 'empty Map when no table');
});

test('parseNeuralwattEnergyHtml skips unknown models with warning', async () => {
  const html = `
    <table>
      <thead><tr><th>Model</th><th>0–256</th><th>256–1k</th><th>1k–4k</th><th>4k–16k</th><th>16k–64k</th><th>64k–256k</th><th>256k–1M</th></tr></thead>
      <tbody>
        <tr><td>Unknown Model X</td><td>100 mWh<br>10% of reqs</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
      </tbody>
    </table>
  `;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const map = parseNeuralwattEnergyHtml(html);
    assert.equal(map.size, 0, 'unknown model should be skipped');
    assert.ok(warnings.length > 0, 'should warn about unknown model');
    assert.ok(warnings[0].includes('Unknown Model X'), 'warning should mention model name');
  } finally {
    console.warn = originalWarn;
  }
});

test('parseNeuralwattEnergyHtml preserves all 7 band keys even if data is null', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');

  const expectedBands = ['0–256', '256–1k', '1k–4k', '4k–16k', '16k–64k', '64k–256k', '256k–1M'];
  for (const band of expectedBands) {
    assert.ok(band in glm52.bands, `band ${band} should exist`);
  }
});

test('parseNeuralwattEnergyHtml energyBlock shape matches spec', () => {
  const map = parse(fixture);
  const glm52 = map.get('glm-5.2');

  // Top-level fields
  assert.equal(glm52.source, 'https://portal.neuralwatt.com/energy-pricing');
  assert.equal(glm52.rate_usd_per_kwh, 10.0);
  assert.equal(glm52.measured_window, '7d');
  assert.equal(glm52.workload_dependent, true);
  assert.equal(glm52.updated_ago, '8m ago');
  assert.equal(glm52.avg_cache_hit_pct, 85);
  assert.equal(glm52.trend_48h_vs_7d_pct, 66);

  // Band shape
  const band = glm52.bands['0–256'];
  assert.equal(typeof band.wh, 'number');
  assert.equal(typeof band.share, 'number');
  assert.equal(band.cache_hit_pct, undefined, 'per-band cache_hit_pct does not exist');
});

// Regression: share is stored as PERCENT POINTS (0-100), NOT a 0-1 fraction.
// public/app.js energy section renders b.share.toFixed(1) directly (NOT b.share*100).
// If this contract changes, update the UI render in tandem.
// Schema coverage: `share` is stored as PERCENT POINTS (0-100), NOT a 0-1 fraction.
// public/app.js renders b.share.toFixed(1) directly (NOT b.share*100) — see app.js energy section.
// If this contract ever flips to a fraction, the UI render must change in tandem.
test('share is percent points (0-100), not a 0-1 fraction', () => {
  const glm52 = parse(fixture).get('glm-5.2');
  assert.ok(glm52, 'fixture must contain glm-5.2');
  // Concrete value: fixture's glm-5.2 "0–256" band is '39.9% of reqs' → 39.9 (not 0.399).
  assert.equal(glm52.bands['0–256'].share.toFixed(1), '39.9', 'share must be percent points');
  // Bounds guard across all bands.
  for (const k of Object.keys(glm52.bands)) {
    const b = glm52.bands[k];
    if (b && b.share != null) {
      assert.ok(b.share > 0 && b.share <= 100, `${k} share=${b.share} must be in (0,100] percent points`);
    }
  }
});

// ── Estimator parser tests (wh_per_mtok from /pricing inline JS) ─────────────

import { parseNeuralwattEstimator } from '../scripts/fetch-neuralwatt-energy.mjs';
import { readFile as _readFile } from 'node:fs/promises';
import { fileURLToPath as _fileURLToPath } from 'node:url';
import { dirname as _dirname, join as _join } from 'node:path';

const _estDir = _dirname(_fileURLToPath(import.meta.url));
const _estFixturePath = _join(_estDir, 'fixtures', 'neuralwatt-estimator.html');
let _estFixture;
try { _estFixture = await _readFile(_estFixturePath, 'utf8'); } catch (e) { _estFixture = null; }

// Fixture must exist — a missing fixture is a test failure, not a silent skip.
test('estimator fixture file exists', () => {
  assert.ok(_estFixture, `Fixture not found at ${_estFixturePath}`);
});

test('parseNeuralwattEstimator extracts wh_per_mtok from inline script', () => {
  const map = parseNeuralwattEstimator(_estFixture);
  assert.ok(map instanceof Map, 'should return a Map');
  assert.equal(map.size, 3, 'fixture has 3 models');

  const ds = map.get('deepseek-v4-flash');
  assert.ok(ds, 'deepseek-v4-flash present');
  assert.equal(ds.wh_per_mtok, 3.1424428382690093);
  assert.equal(ds.wh_per_mtok_overridden, false);
  assert.equal(ds.cached_energy_fraction, 0.3);
  assert.ok(typeof ds.measured_cached_input_share === 'number');
  assert.ok(typeof ds.measured_output_share === 'number');
});

test('parseNeuralwattEstimator handles overridden wh_per_mtok flag', () => {
  const map = parseNeuralwattEstimator(_estFixture);
  const kimi = map.get('kimi-k2.6');
  assert.ok(kimi, 'kimi-k2.6 present');
  assert.equal(kimi.wh_per_mtok, 27.5);
  assert.equal(kimi.wh_per_mtok_overridden, true, 'manually overridden value');
  assert.equal(kimi.cached_energy_fraction, 0.58, 'different fraction for Kimi');
});

test('parseNeuralwattEstimator returns empty Map on missing models array', () => {
  const map = parseNeuralwattEstimator('<script>function f() { return {}; }</script>');
  assert.equal(map.size, 0);
});

test('parseNeuralwattEstimator returns empty Map on malformed JSON', () => {
  const html = '<script>models: [{broken json}], // Fleet-wide</script>';
  const map = parseNeuralwattEstimator(html);
  assert.equal(map.size, 0);
});

test('$/Mtok energy computation: wh_per_mtok × rate / 1000', () => {
  const map = parseNeuralwattEstimator(_estFixture);
  const ds = map.get('deepseek-v4-flash');
  const rate = 10.0; // $/kWh
  const usdPerMtok = ds.wh_per_mtok * rate / 1000;
  // 3.142... × 10 / 1000 = 0.0314...
  assert.ok(usdPerMtok > 0.03 && usdPerMtok < 0.032, `$${usdPerMtok.toFixed(6)}/Mtok expected ~0.0314`);
});

// ── 2026-08 page-structure regression tests ──────────────────────────────────
// The live page now renders a per-model summary table (Model | Right now |
// 7-day typical | vs 7-day | 48h trend) BEFORE the band grid. The parser must
// select the band grid by its headers, not document order, and must read the
// model name from the first <td>'s title attr / first div (not the bundled
// subtitle text). Kimi K3 / K3 Fast joined the roster in this redesign.

test('band table is found by headers even when a summary table precedes it', () => {
  // Fixture has 2 tables; only the second has 0–256 band headers.
  const map = parse(fixture);
  assert.equal(map.size, 4, 'summary table rows must not be parsed as bands');
  assert.ok(map.has('kimi-k3'), 'Kimi K3 (2026-08 roster addition) must map');
});

test('summary-table first cell does not leak subtitle into model name', () => {
  const map = parse(fixture);
  for (const id of map.keys()) {
    assert.ok(!/cache|k–|reqs/i.test(id), `catalogId "${id}" must be a clean id`);
  }
});

test('Kimi K3 band values parse (mWh → Wh, share percent points)', () => {
  const kimi = parse(fixture).get('kimi-k3');
  assert.equal(kimi.bands['0–256'].wh, 0.4052, '405.2 mWh → 0.4052 Wh');
  assert.equal(kimi.bands['0–256'].share, 9.1, '9.1% → 9.1');
  assert.equal(kimi.bands['256–1k'].wh, 6.11, '6.11 Wh passthrough');
  assert.equal(kimi.bands['1k–4k'].wh, null, '— → null');
});
