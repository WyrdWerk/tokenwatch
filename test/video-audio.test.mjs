import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIDEO_JSON = join(__dirname, '..', 'public', 'video-pricing.json');

/**
 * Regression test for Issue #3: the video audio filter used to drop 22 of 38
 * pricing entries (58%) — including 8 entire models like Sora 2 Pro, Grok
 * Imagine, Wan 2.6/2.7, Hailuo 2.3 — whenever a user picked either
 * "With audio" OR "Without audio".
 *
 * `audio === null` means the SKU has no audio dimension. The fix: "With audio"
 * = strictly audio===true; "Without / no audio" = anything not strictly true
 * (null + false both survive).
 *
 * NOTE: video-app.js is a non-module global script (no exports), so this test
 * reproduces the fixed filter logic. It MUST stay in sync with
 * public/video-app.js buildRows (the audioFilter === 'true'/'false' branches).
 */
function audioMatches(audio, filter) {
  if (filter === 'true') return audio === true;
  if (filter === 'false') return audio !== true; // null + false both survive
  return true; // '' (Any)
}

test('null-audio entries survive "Without / no audio" filter', async () => {
  const data = JSON.parse(await readFile(VIDEO_JSON, 'utf-8'));
  let nullTotal = 0;
  let nullSurvivesFalse = 0;
  for (const m of data.models) {
    for (const p of m.pricing) {
      if (p.audio === null) {
        nullTotal++;
        if (audioMatches(p.audio, 'false')) nullSurvivesFalse++;
      }
    }
  }
  assert.ok(nullTotal > 0, 'expected some null-audio entries in video-pricing.json');
  assert.equal(nullSurvivesFalse, nullTotal,
    `all ${nullTotal} null-audio entries must survive "Without / no audio", only ${nullSurvivesFalse} did`);
});

test('null-audio entries are excluded from "With audio" filter', async () => {
  const data = JSON.parse(await readFile(VIDEO_JSON, 'utf-8'));
  let nullTotal = 0;
  let nullInTrue = 0;
  for (const m of data.models) {
    for (const p of m.pricing) {
      if (p.audio === null) {
        nullTotal++;
        if (audioMatches(p.audio, 'true')) nullInTrue++;
      }
    }
  }
  assert.equal(nullInTrue, 0,
    `${nullInTrue} null-audio entries incorrectly matched "With audio" (should be 0)`);
});

test('null-only models stay visible under "Without / no audio"', async () => {
  const data = JSON.parse(await readFile(VIDEO_JSON, 'utf-8'));
  // Models that have ONLY null-audio entries — these used to vanish entirely.
  const nullOnlyModels = data.models.filter(m =>
    m.pricing.length > 0 && m.pricing.every(p => p.audio === null)
  );
  assert.ok(nullOnlyModels.length >= 5,
    `expected ≥5 null-only models, found ${nullOnlyModels.length}`);

  for (const m of nullOnlyModels) {
    const visible = m.pricing.filter(p => audioMatches(p.audio, 'false'));
    assert.ok(visible.length > 0,
      `${m.id} has 0 entries visible under "Without / no audio" (used to vanish)`);
  }
});

test('every null-only model stays visible under "Without / no audio" (no exact-ID pins)', async () => {
  const data = JSON.parse(await readFile(VIDEO_JSON, 'utf-8'));
  // The original regression named five flagship IDs (Sora 2 Pro, Grok Imagine,
  // Wan 2.6/2.7, Hailuo 2.3). Exact IDs are fragile to upstream churn — when a
  // provider retires/renames a model the pin breaks the CI gate for a data-only
  // change. The real invariant is structural: every null-only model (one whose
  // pricing is entirely audio===null) must remain visible under "Without audio".
  const nullOnlyModels = data.models.filter(m =>
    m.pricing.length > 0 && m.pricing.every(p => p.audio === null)
  );
  assert.ok(nullOnlyModels.length > 0, 'expected at least one null-only model');
  for (const m of nullOnlyModels) {
    const visible = m.pricing.filter(p => audioMatches(p.audio, 'false'));
    assert.ok(visible.length > 0,
      `${m.id} has 0 entries visible under "Without / no audio" (used to vanish)`);
  }
});

test('"Any audio" filter shows everything', async () => {
  const data = JSON.parse(await readFile(VIDEO_JSON, 'utf-8'));
  let total = 0;
  let visible = 0;
  for (const m of data.models) {
    for (const p of m.pricing) {
      total++;
      if (audioMatches(p.audio, '')) visible++;
    }
  }
  assert.equal(visible, total,
    `"Any audio" should show all ${total} entries, only ${visible} visible`);
});
