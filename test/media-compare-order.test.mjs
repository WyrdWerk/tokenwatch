import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const IMAGE_APP = join(PUBLIC, 'image-app.js');
const VIDEO_APP = join(PUBLIC, 'video-app.js');
const SHARED_UI = join(PUBLIC, 'shared-ui.js');
const BENCHMARKS_APP = join(PUBLIC, 'benchmarks-app.js');

/**
 * The comparison modal leads with the cost outcome (total cost, or affordable
 * count/seconds in budget mode), then the unit rate and variant information,
 * and only then model identity / provenance. This guards the reorder: a future
 * edit must not drift back to leading with Org/Model.
 */
function metricRowsBlock(src) {
  const start = src.indexOf('const metricRows = [');
  assert.notEqual(start, -1, 'metricRows block not found');
  const end = src.indexOf('];', start);
  assert.notEqual(end, -1, 'metricRows block end not found');
  return src.slice(start, end);
}

function assertOrdered(block, markers, label) {
  let last = -1;
  for (const marker of markers) {
    const idx = block.indexOf(marker);
    assert.notEqual(idx, -1, `${label}: missing marker ${marker}`);
    assert.ok(idx > last, `${label}: ${marker} must come after the previous row (order drifted)`);
    last = idx;
  }
}

test('image compare rows lead with cost, then unit rate, variant, then identity', async () => {
  const src = await readFile(IMAGE_APP, 'utf-8');
  const block = metricRowsBlock(src);
  assertOrdered(block, [
    'headlineGet',        // total cost / affordable images (headline)
    "'$/Unit'",           // unit rate
    "label: 'Unit'",      // unit + variant identity
    "label: 'Model'",     // model identity
    "label: 'Provider'",
    "label: 'Org'",
  ], 'image-app');
});

test('video compare rows lead with cost, then unit rate, variant, then identity', async () => {
  const src = await readFile(VIDEO_APP, 'utf-8');
  const block = metricRowsBlock(src);
  assertOrdered(block, [
    'headlineGet',          // total cost / affordable seconds (headline)
    "'$/Sec'",              // unit rate
    "label: 'Resolution'",  // variant information
    "label: 'Audio'",       // variant information
    "label: 'Model'",       // model identity
    "label: 'Org'",
  ], 'video-app');
});

test('cost rows are marked so unknown (null) values never win the best-value highlight', async () => {
  for (const [file, src] of [['image-app.js', await readFile(IMAGE_APP, 'utf-8')],
    ['video-app.js', await readFile(VIDEO_APP, 'utf-8')]]) {
    const block = metricRowsBlock(src);
    assert.match(block, /getRaw:\s*headlineGet/, `${file}: headline cost row must expose getRaw for best-value math`);
    // The best-value loop must exclude null/undefined — "unknown is not zero".
    assert.match(src, /v\s*!={1,2}\s*null\s*&&\s*v\s*!==\s*undefined\s*&&\s*v\s*===\s*best/,
      `${file}: null/undefined values must not be treated as the best (zero) value`);
  }
});

test('comparison identity stays per pricing variant in the column headers', async () => {
  const image = await readFile(IMAGE_APP, 'utf-8');
  const video = await readFile(VIDEO_APP, 'utf-8');
  assert.match(image, /variantSuffix/, 'image headers must keep the variant suffix');
  assert.match(video, /variantSuffix/, 'video headers must keep resolution/audio variant suffix');
});

test('snapshot sharing reads rows generically, so row reorder cannot break it', async () => {
  const src = await readFile(SHARED_UI, 'utf-8');
  const start = src.indexOf('function snapshotFromCard(');
  const end = src.indexOf('\n  }', start);
  const body = src.slice(start, end);
  assert.match(body, /tBodies\[0\]\?\.rows/, 'snapshot must read body rows in document order');
  assert.doesNotMatch(body, /'Total Cost'|'Org'|'Model'|'Provider'|'\$\/Unit'|'\$\/Sec'/,
    'snapshot must not depend on specific metric labels or their order');
});

test('sortable media headers keep native columnheader semantics (aria-sort stays valid)', async () => {
  for (const [file, src] of [['image-app.js', await readFile(IMAGE_APP, 'utf-8')],
    ['video-app.js', await readFile(VIDEO_APP, 'utf-8')]]) {
    assert.doesNotMatch(src, /setAttribute\(\s*['"]role['"]\s*,\s*['"]button['"]\s*\)/,
      `${file}: sortable th must not be given role=button (invalidates aria-sort)`);
    assert.match(src, /setAttribute\(\s*['"]aria-sort['"]/,
      `${file}: sortable th must keep aria-sort on the native columnheader`);
    assert.match(src, /setAttribute\(\s*['"]tabindex['"]\s*,\s*['"]0['"]/,
      `${file}: sortable th must stay keyboard focusable`);
    assert.match(src, /addEventListener\(\s*['"]keydown['"]/,
      `${file}: keyboard sorting must be preserved`);
  }
});

test('benchmarks From $/M tooltip describes the live mix, not a fixed agentic mix', async () => {
  const src = await readFile(BENCHMARKS_APP, 'utf-8');
  assert.doesNotMatch(src, /blended rate at the agentic mix/,
    'tooltip must not claim a fixed agentic mix when the mix is live');
  assert.match(src, /blended rate at your current token mix/,
    'tooltip must describe the current token mix');
  const html = await readFile(join(PUBLIC, 'benchmarks.html'), 'utf-8');
  assert.doesNotMatch(html, /blended rate at the agentic mix/,
    'visible benchmark subtitle must not contradict the live-mix tooltip');
  assert.match(html, /blended rate at your current token mix/);
});

test('benchmark sortable headers retain columnheader semantics and keyboard access', async () => {
  const src = await readFile(BENCHMARKS_APP, 'utf-8');
  assert.doesNotMatch(src, /role="button"[^>]*aria-sort=/,
    'aria-sort must stay on native columnheaders, not role=button');
  assert.match(src, /tabindex="0"[^>]*aria-sort=/);
  assert.match(src, /addEventListener\('keydown'/);
});
