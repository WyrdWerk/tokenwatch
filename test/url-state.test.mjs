import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dirname, '..', 'public', 'app.js');

/**
 * Regression guard: deserializeState() must reset ALL filter checkboxes to
 * DEFAULTS before applying URL hash params. Previously subscriptionOnly was
 * missing from the reset block — if a URL hash lacked `sub=`, the checkbox
 * retained stale state from the previous session.
 *
 * This test reads app.js source text and asserts that all three filter
 * checkboxes (zdrOnly, promoOnly, subscriptionOnly) appear in the
 * deserializeState defaults-reset section. It does not execute the browser
 * code — it guards the structural invariant.
 */
/**
 * Regression guard: deserializeState() must reset ALL filter checkboxes to
 * DEFAULTS before applying URL hash params. Previously subscriptionOnly was
 * missing from the reset block — if a URL hash lacked `sub=`, the checkbox
 * retained stale state from the previous session.
 *
 * Asserts the EXACT assignment pattern (not just word presence) so a comment
 * or variable reference cannot make the test pass.
 */
test('deserializeState resets subscriptionOnly to DEFAULTS alongside zdrOnly and promoOnly', async () => {
  const src = await readFile(APP_JS, 'utf-8');

  // Extract the defaults-reset block inside deserializeState.
  const fnStart = src.indexOf('function deserializeState(hash) {');
  assert(fnStart !== -1, 'deserializeState function not found in app.js');
  const fnEnd = src.indexOf('const raw =', fnStart);
  assert(fnEnd !== -1, 'deserializeState hash-parsing section not found');

  const resetBlock = src.slice(fnStart, fnEnd);

  // Assert exact assignment patterns — not just word presence.
  // zdrOnly uses a guard: `if (els.zdrOnly) els.zdrOnly.checked = DEFAULTS.zdrOnly;`
  assert.match(resetBlock, /if\s*\(\s*els\.zdrOnly\s*\)\s*els\.zdrOnly\.checked\s*=\s*DEFAULTS\.zdrOnly/,
    'zdrOnly must be reset via `if (els.zdrOnly) els.zdrOnly.checked = DEFAULTS.zdrOnly`');
  // promoOnly uses direct assignment: `els.promoOnly.checked = DEFAULTS.promoOnly;`
  assert.match(resetBlock, /els\.promoOnly\.checked\s*=\s*DEFAULTS\.promoOnly/,
    'promoOnly must be reset via `els.promoOnly.checked = DEFAULTS.promoOnly`');
  // subscriptionOnly must use the same guarded pattern as zdrOnly
  assert.match(resetBlock, /if\s*\(\s*els\.subscriptionOnly\s*\)\s*els\.subscriptionOnly\.checked\s*=\s*DEFAULTS\.subscriptionOnly/,
    'subscriptionOnly must be reset via `if (els.subscriptionOnly) els.subscriptionOnly.checked = DEFAULTS.subscriptionOnly` — bug regression');
});

/**
 * Verify subscriptionOnly is applied from the URL hash param `sub=` with the
 * exact `params.has('sub')` pattern, so the filter restores from shared URLs.
 */
test('deserializeState applies subscriptionOnly from URL hash param `sub=`', async () => {
  const src = await readFile(APP_JS, 'utf-8');

  const fnStart = src.indexOf('function deserializeState(hash) {');
  assert(fnStart !== -1, 'deserializeState function not found in app.js');
  const rawStart = src.indexOf('const raw =', fnStart);
  assert(rawStart !== -1, 'deserializeState hash-parsing section not found');
  const fnEnd = src.indexOf('\n}', rawStart);
  const fnBody = src.slice(fnStart, fnEnd);

  // Assert the exact pattern: params.has('sub') → els.subscriptionOnly.checked = ...
  assert.match(fnBody, /params\.has\(\s*['"]sub['"]\s*\)\s*&&\s*els\.subscriptionOnly\)\s*els\.subscriptionOnly\.checked\s*=\s*params\.get\(\s*['"]sub['"]\s*\)\s*===\s*['"]1['"]/,
    'subscriptionOnly must be applied from `sub=` hash param with exact pattern');
});

test('hideBatch defaults on and serializes only when turned off', async () => {
  const src = await readFile(APP_JS, 'utf-8');
  assert.match(src, /hideBatch:\s*true/, 'DEFAULTS.hideBatch must be true');
  const serStart = src.indexOf('function serializeState()');
  const serEnd = src.indexOf('\nfunction deserializeState', serStart);
  const ser = src.slice(serStart, serEnd);
  assert.match(ser, /hideBatch/, 'serializeState must mention hideBatch');
  assert.match(ser, /params\.set\(\s*['"]batch['"]/, 'off state must set batch= hash param');
  const fnStart = src.indexOf('function deserializeState(hash) {');
  const fnEnd = src.indexOf('const raw =', fnStart);
  const resetBlock = src.slice(fnStart, fnEnd);
  assert.match(resetBlock, /els\.hideBatch\.checked\s*=\s*DEFAULTS\.hideBatch/,
    'deserializeState must reset hideBatch to DEFAULTS');
});

test('index.html exposes the new text-page filter controls and TTFT column', async () => {
  const html = await readFile(join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  for (const id of ['hideBatch', 'cacheOnly', 'maxBlended', 'minToks', 'hqFilter', 'popularChips']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html must include #${id}`);
  }
  assert.match(html, /data-sort="ttft"/, 'TTFT must be a sortable column');
  assert.match(html, /value="ttft:asc"/, 'mobile sort must include TTFT');
});

test('cache-all-fresh-input estimate removes obsolete write-volume controls and URL state', async () => {
  const src = await readFile(APP_JS, 'utf-8');
  const html = await readFile(join(__dirname, '..', 'public', 'index.html'), 'utf-8');

  assert.doesNotMatch(src, /\b(?:cacheWriteTokens|amortizeN|setCacheWrite)\b/);
  assert.doesNotMatch(html, /id="(?:cacheWriteTokens|amortizeN)"|Advanced: cache write/);
  assert.match(html, /Assumes all fresh input is cached where a higher cache-write rate is published/);
  assert.match(html, /Additional cache-storage charges are excluded/);

  const serStart = src.indexOf('function serializeState()');
  const serEnd = src.indexOf('\nfunction deserializeState', serStart);
  const ser = src.slice(serStart, serEnd);
  assert.doesNotMatch(ser, /params\.set\('(?:cw|cwn)'/);
  assert.doesNotMatch(src, /params\.(?:has|get)\('(?:cw|cwn)'/,
    'legacy cw/cwn parameters are ignored rather than read into removed controls');
});

test('index.html exposes IQ column and extra quality filters', async () => {
  const html = await readFile(join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  assert.match(html, /data-sort="intelligence"/, 'IQ must be a sortable column');
  assert.match(html, /value="intelligence:desc"/, 'mobile sort must include IQ desc');
  for (const id of ['minCoding', 'minAgentic', 'benchmarkedOnly']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html must include #${id}`);
  }
});

// ── optional quantization column + default-hidden detailed columns ───────────

test('quantization is an optional column keyed quantization with data-label Quantization', async () => {
  const src = await readFile(APP_JS, 'utf-8');
  assert.match(src, /\{\s*key:\s*'quantization',\s*label:\s*'Quantization — best effort',\s*dataLabel:\s*'Quantization'\s*\}/,
    'COLUMN_KEYS must include the quantization column with its popover label and data-label');
  assert.match(src, /data-label="Quantization"/, 'row renderer must emit a Quantization data-label');
  assert.match(src, /<span class="missing">Unknown<\/span>/, 'absent/unknown quantization renders Unknown');
  assert.match(src, /case 'quantization':/, 'sortValue must support quantization');
  assert.match(src, /case 'quantization':\s*label\s*=\s*'quantization'/, 'rankingMetric must name quantization');
});

test('detailed columns (quantization/input/output/cache_read/context/ttft) are hidden by default', async () => {
  const src = await readFile(APP_JS, 'utf-8');
  assert.match(src, /const DEFAULT_HIDDEN_COLS = new Set\(\['quantization', 'input', 'output', 'cache_read', 'context', 'ttft'\]\)/);
  // effectiveColHidden falls back to the default hidden set (not an empty set).
  const start = src.indexOf('function effectiveColHidden()');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  assert.match(body, /state\.colHidden \|\| new Set\(DEFAULT_HIDDEN_COLS\)/, 'default view hides the detailed columns');
  // resetColumns restores defaults (null → DEFAULT_HIDDEN_COLS).
  const rStart = src.indexOf('function resetColumns()');
  const rEnd = src.indexOf('\n}\n', rStart);
  const rBody = src.slice(rStart, rEnd);
  assert.match(rBody, /state\.colHidden = null/);
});

test('quantization opt-in persists through the hash and legacy cols/hide URLs stay compatible', async () => {
  const src = await readFile(APP_JS, 'utf-8');

  // Serialization records opt-in as `show` and extra hides as `hide`.
  const serStart = src.indexOf('function serializeState()');
  const serEnd = src.indexOf('\nfunction deserializeState', serStart);
  const ser = src.slice(serStart, serEnd);
  assert.match(ser, /params\.set\(\s*'show'/, 'explicit quantization opt-in must persist via show=');
  assert.match(ser, /params\.set\(\s*'hide'/, 'extra hidden columns persist via hide=');
  assert.match(ser, /DEFAULT_HIDDEN_COLS/, 'serialization must be relative to the default hidden set');

  // Deserialization starts from defaults, applies show then hide.
  const deStart = src.indexOf('function deserializeState(hash) {');
  const deEnd = src.indexOf('\nfunction updateHash', deStart);
  const de = src.slice(deStart, deEnd);
  assert.match(de, /const hidden = new Set\(DEFAULT_HIDDEN_COLS\)/, 'legacy hide URLs keep new default-hidden columns hidden');
  assert.match(de, /params\.has\('show'\)/, 'show= is honored');
  assert.match(de, /params\.has\('hide'\)/, 'legacy hide= is honored');
  // Legacy 11-key cols order is completed rather than discarded.
  assert.match(de, /DEFAULT_COL_ORDER\.filter\(\(k\) => !provided\.includes\(k\)\)/,
    'legacy partial cols order is completed with the new column in default position');
});
