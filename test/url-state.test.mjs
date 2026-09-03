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
