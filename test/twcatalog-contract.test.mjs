import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dirname, '..', 'public', 'app.js');

const REQUIRED_METHODS = [
  'getView',
  'getModel',
  'setSort',
  'explainRanking',
  'listPresets',
  'getShareUrl',
  'getCatalogInfo',
  'setWorkload',
  'applyPreset',
  'setCacheWrite',
  'setFilters',
  'clearFilters',
  'compareModels',
  'openDetail',
  'highlightTradeoff',
  'exportCsv',
  'snapshotCompare',
  'downloadCostCard',
  'switchCatalog',
];

test('app.js assigns window.TWCatalog with required methods after a successful init', async () => {
  const src = await readFile(APP_JS, 'utf8');

  assert.match(src, /function publishTwCatalog\(\)/, 'publishTwCatalog must exist');
  assert.match(src, /computeAndRender\(\);\s*publishTwCatalog\(\);/,
    'successful init() must publish TWCatalog after the first render');
  assert.match(src, /window\.TWCatalog\s*=\s*\{/, 'must assign window.TWCatalog');
  assert.match(src, /page:\s*'text'/, 'TWCatalog.page must be text');
  assert.match(src, /ready:\s*true/, 'TWCatalog.ready must be true');
  assert.match(
    src,
    /document\.dispatchEvent\(\s*new CustomEvent\(\s*['"]tw-catalog-ready['"]/,
    'must dispatch tw-catalog-ready',
  );

  const start = src.indexOf('function publishTwCatalog()');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  for (const method of REQUIRED_METHODS) {
    assert.match(body, new RegExp(method), `TWCatalog must expose ${method}`);
  }

  // Failed pricing.json load returns before publish — do not register empty tools.
  const initStart = src.indexOf('async function init()');
  const initEnd = src.indexOf('\n}', src.indexOf('computeAndRender();', initStart));
  const initBody = src.slice(initStart, initEnd);
  const returnIdx = initBody.indexOf('return;');
  const publishIdx = initBody.indexOf('publishTwCatalog');
  assert.ok(returnIdx !== -1 && publishIdx !== -1 && returnIdx < publishIdx,
    'init() must return on load failure before publishing TWCatalog');
});

test('TWCatalog does not duplicate mix math: setWorkload / explainRanking call existing helpers', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const facadeStart = src.indexOf('// ── WebMCP façade');
  assert.notEqual(facadeStart, -1, 'façade section marker missing');
  const facade = src.slice(facadeStart);

  assert.match(facade, /function setWorkload\(/);
  assert.match(facade, /function explainRanking\(/);
  assert.match(facade, /costBreakdown\(/, 'explainRanking must use costBreakdown, not a forked formula');
  assert.match(facade, /computeAndRender\(\)/, 'writes must re-render the live table');
  assert.match(src, /function costFor\(pricing, tokens\) \{\s*return costBreakdown\(pricing, tokens\)\.total;/);
});

test('getView exposes the active sort used for top-ranked rows', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const getViewStart = src.indexOf('function getView(input)');
  const getViewEnd = src.indexOf('\n}\n\nfunction getModel', getViewStart);
  assert.notEqual(getViewStart, -1, 'getView must exist');
  assert.notEqual(getViewEnd, -1, 'getView boundary must exist');
  const body = src.slice(getViewStart, getViewEnd);
  assert.match(body, /sort:\s*\{\s*by:\s*state\.sortBy,\s*dir:\s*state\.sortDir,\s*\}/);
});

test('explainRanking uses the active sort metric instead of assuming cost', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const start = src.indexOf('function explainRanking()');
  const end = src.indexOf('\n}\n\nfunction listPresets', start);
  assert.notEqual(start, -1, 'explainRanking must exist');
  assert.notEqual(end, -1, 'explainRanking boundary must exist');
  const body = src.slice(start, end);
  assert.match(body, /rankingMetric\(\)/);
  assert.match(body, /sortValue\(winner, ranking\.by\)/);
  assert.match(body, /rankingValueFormatted/);
  assert.match(body, /sort: ranking/);
});

test('TWCatalog exposes setSort and uses the same sortable columns as the table', async () => {
  const src = await readFile(APP_JS, 'utf8');
  assert.match(src, /const SORT_COLUMNS = \['org', 'provider', 'model', 'input', 'output', 'cache_read', 'context', 'speed', 'blended', 'cost'\]/);
  assert.match(src, /function setSort\(input\)/);
  assert.match(src, /setSort,\s*setCacheWrite/);
});
