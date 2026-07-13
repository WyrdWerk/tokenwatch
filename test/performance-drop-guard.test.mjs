import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

/**
 * Regression tests for the performance.json record-count drop guard.
 *
 * The guard in fetch-performance.mjs preserves the existing file when the new
 * record count drops >15% vs the existing record count (excluding _meta).
 * This catches truncated /models responses that pass the 20% endpoint-failure
 * check but yield far fewer matches than the prior run.
 *
 * Three scenarios:
 * 1. Drop exceeds 15% → preserve (don't overwrite)
 * 2. Drop within 15% → allow write
 * 3. First run (no existing file) → allow write
 */

test('drop guard arithmetic: 50 new vs 734 existing triggers preserve (>15% drop)', () => {
  const existingCount = 734;
  const newCount = 50;
  const dropPct = Math.round((1 - newCount / existingCount) * 100);
  const wouldPreserve = existingCount > 0 && newCount < existingCount * 0.85;

  assert.equal(dropPct, 93, '93% drop');
  assert.equal(wouldPreserve, true, 'must preserve when drop exceeds 15%');
});

test('drop guard arithmetic: 700 new vs 734 existing allows write (<15% drop)', () => {
  const existingCount = 734;
  const newCount = 700;
  const dropPct = Math.round((1 - newCount / existingCount) * 100);
  const wouldPreserve = existingCount > 0 && newCount < existingCount * 0.85;

  assert.equal(dropPct, 5, '5% drop — within threshold');
  assert.equal(wouldPreserve, false, 'must allow write when drop is within 15%');
});

test('drop guard arithmetic: 624 new vs 734 existing is exactly 15% (boundary)', () => {
  const existingCount = 734;
  const newCount = 624; // 734 * 0.85 = 623.9 → 624 > 623.9 → allows write
  const wouldPreserve = existingCount > 0 && newCount < existingCount * 0.85;

  assert.equal(wouldPreserve, false, '624 is above 85% threshold (623.9) — allows write');
});

test('drop guard arithmetic: 623 new vs 734 existing triggers preserve (boundary)', () => {
  const existingCount = 734;
  const newCount = 623; // 623 < 623.9 → triggers preserve
  const wouldPreserve = existingCount > 0 && newCount < existingCount * 0.85;

  assert.equal(wouldPreserve, true, '623 is below 85% threshold (623.9) — preserves');
});

test('drop guard arithmetic: first run (existingCount=0) allows write', () => {
  const existingCount = 0;
  const newCount = 50;
  const wouldPreserve = existingCount > 0 && newCount < existingCount * 0.85;

  assert.equal(wouldPreserve, false, 'no existing file → allows write');
});

test('fetch-performance.mjs source has the three-layer guard: zero-OR, empty, drop-count', async () => {
  const src = await readFile(join(REPO, 'scripts', 'fetch-performance.mjs'), 'utf-8');

  // Guard 1: zero OR matches
  assert.match(src, /modelSlugs\.size === 0/, 'must guard against zero OR catalog matches');

  // Guard 2: zero records
  assert.match(src, /Object\.keys\(perfData\)\.length === 0/, 'must guard against empty perfData');

  // Guard 3: >15% record drop
  assert.match(src, /newCount < existingCount \* 0\.85/, 'must guard against >15% record count drop');
  assert.match(src, /existingCount > 0/, 'must allow first run when no existing file');
});
