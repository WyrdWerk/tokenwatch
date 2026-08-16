import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLiveBenchCsv } from '../scripts/fetch-benchmarks.mjs';
import { familyKey, resolveOrg, makeCleanOrg, orgFromPrefix, buildOrgIndex } from '../shared/benchmark-org.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_JSON = join(__dirname, '..', 'public', 'benchmarks.json');
const PRICING_JSON = join(__dirname, '..', 'public', 'pricing.json');

let bench, pricing;
try {
  bench = JSON.parse(await readFile(BENCH_JSON, 'utf8'));
  pricing = JSON.parse(await readFile(PRICING_JSON, 'utf8'));
} catch {
  bench = null;
}
// Fail loudly — these tests guard the committed artifacts.
assert.ok(bench, `benchmarks.json missing or unreadable at ${BENCH_JSON}`);

// ── Org correctness (regression: 2026-08-14 wafer/neuralwatt leaked as creators) ──

test('no model has a hosting provider slug as its creator org', () => {
  const slugs = new Set(pricing.providers.map((p) => String(p.key || '').toLowerCase()));
  const names = new Set(pricing.providers.map((p) => String(p.name || '').toLowerCase()));
  const bad = bench.models.filter((m) =>
    m.org && (slugs.has(m.org.toLowerCase()) || names.has(m.org.toLowerCase())));
  assert.deepEqual(bad.map((m) => `${m.id}→${m.org}`), [],
    'org extraction fallback leaked provider names as creators');
});

// ── Org resolution: hermetic unit tests (no live-data ID pins) ──────────────
// The 4-layer resolver (clean org → provider-slug blocklist → family inheritance
// → leading-token map) lives in shared/benchmark-org.mjs and is tested here
// with synthetic inputs. This replaces the old exact-ID pins into the committed
// benchmarks.json, which broke whenever an upstream provider renamed a slug
// (2026-08-16: Wafer renamed "glm5.2-fast", and the pin went to undefined).

test('familyKey strips variant/quant suffixes and reseller prefix, dash-insensitive', () => {
  assert.equal(familyKey('kimi-k3-fast'), familyKey('kimi-k3'));
  assert.equal(familyKey('glm-5.2-fast'), familyKey('glm-5.2'));
  assert.equal(familyKey('glm5.2-fast'), familyKey('glm-5.2'), 'dash-less spelling shares the family');
  assert.equal(familyKey('glm-5.2'), 'glm5.2');
  assert.equal(familyKey('umans-glm-5.2'), familyKey('glm-5.2'));
  assert.equal(familyKey('gpt-oss-120b-fast'), familyKey('gpt-oss-120b'));
  assert.equal(familyKey('glm-5.2-nvfp4'), familyKey('glm-5.2'), 'quant suffix is a family variant');
});

test('variant models inherit the base model creator', () => {
  const index = buildOrgIndex(new Map([
    ['glm-5.2',       [{ org: 'z-ai', provider: 'crof' }]],
    ['glm-5.2-fast',  [{ org: 'neuralwatt', provider: 'neuralwatt' }]], // provider leaked as org
    ['glm5.2-fast',   [{ org: 'wafer', provider: 'wafer' }]],           // dash-less spelling
    ['kimi-k3',       [{ org: 'moonshot', provider: 'hyper' }]],
    ['kimi-k3-fast',  [{ org: 'neuralwatt', provider: 'neuralwatt' }]],
    ['grok-4.6',      [{ org: null, provider: 'openrouter' }]],         // all offering orgs failed
  ]), ['neuralwatt', 'wafer', 'crof', 'hyper', 'openrouter']);

  assert.equal(index.get('glm-5.2'), 'z-ai');
  assert.equal(index.get('glm-5.2-fast'), 'z-ai');   // inherits base via family
  assert.equal(index.get('glm5.2-fast'), 'z-ai');    // dash-less inherits via family
  assert.equal(index.get('kimi-k3'), 'moonshot');
  assert.equal(index.get('kimi-k3-fast'), 'moonshot');
  assert.equal(index.get('grok-4.6'), 'x-ai');       // leading-token map fallback
});

test('resolveOrg rejects an org that equals its own or any provider slug', () => {
  assert.equal(resolveOrg([
    { org: 'neuralwatt', provider: 'neuralwatt' },
    { org: 'z-ai', provider: 'ember' },
  ]), 'z-ai');
  assert.equal(resolveOrg([{ org: 'wafer', provider: 'wafer' }]), null);

  const clean = makeCleanOrg(['neuralwatt', 'wafer']);
  assert.equal(clean('neuralwatt'), null, 'provider slug org must never surface');
  assert.equal(clean('z-ai'), 'z-ai');
});

test('orgFromPrefix maps leading canonical tokens to creators', () => {
  assert.equal(orgFromPrefix('grok-4.6'), 'x-ai');
  assert.equal(orgFromPrefix('gemini-3.6-flash'), 'google');
  assert.equal(orgFromPrefix('kimi-k3'), 'moonshot');
  assert.equal(orgFromPrefix('unknown-model'), null);
});

// ── Org resolution: dynamic invariants against committed benchmarks.json ──────
// No exact IDs — these assert structural properties of the emitted artifact, so
// they hold regardless of which providers host which models.

test('models sharing a family key agree on creator org', () => {
  const byFamily = new Map();
  for (const m of bench.models) {
    const fk = familyKey(m.id);
    if (!byFamily.has(fk)) byFamily.set(fk, new Set());
    byFamily.get(fk).add(m.org);
  }
  const conflicts = [...byFamily.entries()]
    .filter(([, orgs]) => orgs.size > 1)
    .map(([fk, orgs]) => `${fk}: [${[...orgs].join(', ')}]`);
  assert.deepEqual(conflicts, [],
    'same family resolved to conflicting creators');
});

test('created orgs are always string or null (never a raw provider object)', () => {
  const bad = bench.models.filter((m) => m.org !== null && typeof m.org !== 'string');
  assert.deepEqual(bad.map((m) => `${m.id}→${JSON.stringify(m.org)}`), []);
});

// ── Data integrity ────────────────────────────────────────────────────────────

test('every benchmarked model has a cheapest-provider blended price > 0', () => {
  for (const m of bench.models) {
    assert.ok(m.from && m.from.blended_per_m > 0, `${m.id} missing blended price`);
    assert.ok(m.from.provider, `${m.id} missing cheapest provider name`);
  }
});

test('every model has at least one numeric score', () => {
  for (const m of bench.models) {
    const numeric = Object.entries(m.scores).filter(([k, v]) => k !== 'design_arena_category' && typeof v === 'number');
    assert.ok(numeric.length > 0, `${m.id} has no scores`);
  }
});

test('score scales are sane (indices 0-100, Elo 800-2500)', () => {
  for (const m of bench.models) {
    for (const [k, v] of Object.entries(m.scores)) {
      if (k === 'design_arena_category' || typeof v !== 'number') continue;
      if (k.startsWith('aa_') || k.startsWith('livebench_')) {
        assert.ok(v >= 0 && v <= 100, `${m.id}.${k}=${v} outside 0-100`);
      } else if (k.includes('elo')) {
        assert.ok(v >= 800 && v <= 2500, `${m.id}.${k}=${v} outside Elo range`);
      }
    }
  }
});

test('mix documented and agentic (2.5/97/0.5)', () => {
  assert.equal(bench.mix.inputPct, 2.5);
  assert.equal(bench.mix.cacheReadPct, 97);
  assert.equal(bench.mix.outputPct, 0.5);
});

// ── LiveBench CSV parser ──────────────────────────────────────────────────────

test('parseLiveBenchCsv aggregates subtasks into categories', () => {
  const csv = [
    'model,AMPS_Hard,olympiad,code_generation,javascript,theory_of_mind',
    'test-model,80.0,90.0,70.0,60.0,50.0',
  ].join('\n');
  const map = parseLiveBenchCsv(csv);
  assert.equal(map.size, 1);
  const cats = map.values().next().value.categories;
  assert.equal(cats.math, 85, '(80+90)/2');
  assert.equal(cats.coding, 70);
  assert.equal(cats.agentic_coding, 60);
  assert.equal(cats.reasoning, 50);
});

test('parseLiveBenchCsv tolerates empty cells', () => {
  const csv = 'model,AMPS_Hard,olympiad\ntest-model,,90.0';
  const map = parseLiveBenchCsv(csv);
  assert.equal(map.values().next().value.categories.math, 90);
});
