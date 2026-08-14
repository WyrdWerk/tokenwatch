import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLiveBenchCsv } from '../scripts/fetch-benchmarks.mjs';

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

test('variant models inherit the base model creator (kimi-k3-fast → moonshot, glm-5.2-fast → z-ai)', () => {
  const org = (id) => bench.models.find((m) => m.id === id)?.org;
  assert.equal(org('kimi-k3-fast'), org('kimi-k3'));
  assert.equal(org('glm-5.2-fast'), org('glm-5.2'));
  assert.equal(org('glm5.2-fast'), org('glm-5.2'), 'dash-less spelling shares the family');
  assert.equal(org('kimi-k3-fast'), 'moonshot');
  assert.equal(org('glm-5.2'), 'z-ai');
});

test('well-known creators resolve even when every offering failed org extraction', () => {
  const org = (id) => bench.models.find((m) => m.id === id)?.org;
  const grok = bench.models.find((m) => m.id.startsWith('grok-4'));
  if (grok) assert.ok(['x-ai', 'xai'].includes(grok.org), `grok org=${grok.org}`);
  const gemini = bench.models.find((m) => m.id.startsWith('gemini-3'));
  if (gemini) assert.equal(gemini.org, 'google');
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
