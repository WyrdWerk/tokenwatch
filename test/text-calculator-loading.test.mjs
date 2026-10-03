import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dirname, '..', 'public', 'app.js');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js must define ${name}()`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name}() must close at column 0`);
  const prefix = src.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '';
  return prefix + src.slice(start, end + 2);
}

/** Build a sandboxed refreshPerfData with injectable fetch + module-level
 *  in-flight/cooldown state, so performance can stall or reject independently
 *  of pricing. */
function makePerfHarness(src) {
  const code = `
    let _perfInFlight = false;
    let _lastPerfFetch = 0;
    const PERF_COOLDOWN_MS = 60000;
    ${extractFn(src, 'refreshPerfData')}
    ${extractFn(src, 'perfViewDecision')}
    return {
      refreshPerfData,
      perfViewDecision,
      inFlight: () => _perfInFlight,
      setLast: (v) => { _lastPerfFetch = v; },
    };
  `;
  // eslint-disable-next-line no-new-func
  return new Function('state', 'els', 'fmtIST', 'fetch', code);
}

/** Build a sandboxed perfNoticeText with injectable state/els. */
function makeNoticeHarness(src) {
  const code = `
    ${extractFn(src, 'perfViewDecision')}
    ${extractFn(src, 'currentPerfDecision')}
    ${extractFn(src, 'perfNoticeText')}
    return { perfNoticeText, currentPerfDecision };
  `;
  // eslint-disable-next-line no-new-func
  return new Function('state', 'els', code);
}

test('stalled performance fetch leaves cost results usable (no blocked pricing, honest pending)', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const state = { perfData: null, perfStatus: 'pending' };
  let releaseFetch;
  const fetch = () => new Promise((resolve) => { releaseFetch = resolve; });
  const api = makePerfHarness(src)(state, {}, (v) => v, fetch);

  const pending = api.refreshPerfData(true); // deliberately not awaited
  assert.equal(state.perfStatus, 'pending', 'status stays pending while performance stalls');
  // Cost views are never blocked by pending performance.
  assert.equal(api.perfViewDecision(state.perfStatus, 'cost', 0).pending, false);
  // A performance-dependent view is honestly pending, not falsely final.
  assert.equal(api.perfViewDecision(state.perfStatus, 'speed', 0).pending, true);
  // A minimum-speed filter is also performance-dependent and provisional.
  const minToksDecision = api.perfViewDecision(state.perfStatus, 'cost', 5);
  assert.equal(minToksDecision.pending, true);
  assert.equal(minToksDecision.provisionalSort, false, 'pending filter does not change a valid cost sort');

  releaseFetch({ ok: false });
  await pending;
  assert.equal(state.perfStatus, 'unavailable', 'a failed initial fetch surfaces unavailable, not a false empty');
  assert.deepEqual(state.perfData, {});
});

test('rejected performance fetch is independent of pricing data and reports an error state', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const state = { perfData: null, perfStatus: 'pending' };
  const fetch = () => Promise.reject(new Error('network down'));
  const api = makePerfHarness(src)(state, {}, (v) => v, fetch);

  await api.refreshPerfData(true);
  assert.equal(state.perfStatus, 'error');
  assert.deepEqual(state.perfData, {}, 'performance failure must not fabricate data');
  assert.equal(api.perfViewDecision(state.perfStatus, 'speed', 0).failed, true);
  assert.equal(api.perfViewDecision(state.perfStatus, 'cost', 0).failed, false);
});

test('successful performance fetch marks the view ready and updates speed ranking', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const state = { perfData: null, perfStatus: 'pending' };
  const payload = { _meta: { generated_at: '2026-01-01T00:00:00Z' }, 'glm-5.2|z-ai': { throughput: { p50: 80 } } };
  const fetch = async () => ({ ok: true, json: async () => payload });
  const api = makePerfHarness(src)(state, {}, (v) => v, fetch);

  const changed = await api.refreshPerfData(true);
  assert.equal(changed, true);
  assert.equal(state.perfStatus, 'ready');
  assert.deepEqual(state.perfData, payload);
  const decision = api.perfViewDecision(state.perfStatus, 'speed', 0);
  assert.equal(decision.pending, false);
  assert.equal(decision.provisionalSort, false, 'speed view becomes authoritative once data arrives');
});

test('refresh failure preserves last-good performance data and ready state', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const good = { _meta: { generated_at: '2026-01-01T00:00:00Z' }, 'glm-5.2|z-ai': { throughput: { p50: 80 } } };
  const state = { perfData: good, perfStatus: 'ready' };
  let calls = 0;
  const fetch = async () => { calls += 1; throw new Error('later refresh failed'); };
  const api = makePerfHarness(src)(state, {}, (v) => v, fetch);

  await api.refreshPerfData(false);
  assert.equal(calls, 1, 'a non-initial refresh attempts the fetch');
  assert.equal(state.perfStatus, 'ready', 'last-good state is retained on refresh failure');
  assert.deepEqual(state.perfData, good, 'last-good performance data is never wiped');
});

test('performance refresh honors the cooldown and in-flight guards', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const state = { perfData: null, perfStatus: 'pending' };
  let calls = 0;
  const fetch = async () => { calls += 1; return { ok: true, json: async () => ({ _meta: { generated_at: 'x' } }) }; };
  const api = makePerfHarness(src)(state, {}, (v) => v, fetch);

  await api.refreshPerfData(true); // calls = 1, sets _lastPerfFetch = now
  const skipped = await api.refreshPerfData(false); // inside cooldown
  assert.equal(skipped, false);
  assert.equal(calls, 1, 'cooldown suppresses the duplicate fetch');

  api.setLast(0); // bypass cooldown
  await api.refreshPerfData(false);
  assert.equal(calls, 2);
});

test('a recovered performance fetch signals a re-render even when payloads carry no timestamp', async () => {
  const src = await readFile(APP_JS, 'utf8');
  // Initial failure leaves the state non-ready with an empty payload.
  const state = { perfData: {}, perfStatus: 'error' };
  const payload = { 'glm-5.2|z-ai': { throughput: { p50: 80 } } }; // no _meta.generated_at
  const fetch = async () => ({ ok: true, json: async () => payload });
  const api = makePerfHarness(src)(state, {}, (v) => v, fetch);
  api.setLast(0); // bypass cooldown

  const changed = await api.refreshPerfData(false);
  assert.equal(changed, true, 'error/unavailable → ready must signal a re-render');
  assert.equal(state.perfStatus, 'ready');
  assert.deepEqual(state.perfData, payload);
  assert.equal(api.perfViewDecision(state.perfStatus, 'speed', 0).provisionalSort, false,
    'a restored speed view becomes authoritative after recovery');
  assert.equal(api.perfViewDecision(state.perfStatus, 'cost', 5).pending, false,
    'a restored minimum-speed view stops being provisional after recovery');
});

test('a ready → ready refresh with an unchanged timestamp is a no-op', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const payload = { _meta: { generated_at: 'same' }, 'x|y': {} };
  const state = { perfData: payload, perfStatus: 'ready' };
  const fetch = async () => ({ ok: true, json: async () => payload });
  const api = makePerfHarness(src)(state, {}, (v) => v, fetch);
  api.setLast(0); // bypass cooldown

  const changed = await api.refreshPerfData(false);
  assert.equal(changed, false, 'an unchanged ready payload must not force a re-render');
});

test('init starts performance concurrently and renders pricing without awaiting it', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const initSrc = extractFn(src, 'init');
  const perfStart = initSrc.indexOf('refreshPerfData(true)');
  const pricingAwait = initSrc.indexOf('await pricingPromise');
  assert.notEqual(perfStart, -1, 'init must start the performance fetch');
  assert.notEqual(pricingAwait, -1, 'init must await pricing');
  assert.ok(perfStart < pricingAwait, 'performance fetch starts before pricing is awaited (concurrent)');

  const renderIdx = initSrc.indexOf('computeAndRender()');
  const thenIdx = initSrc.indexOf('perfPromise.then');
  assert.notEqual(renderIdx, -1, 'init must render once pricing is ready');
  assert.notEqual(thenIdx, -1, 'init must re-render when performance arrives');
  assert.ok(renderIdx < thenIdx, 'pricing render happens without waiting for performance');
});

test('performance-dependent filtering/ordering is gated by perfViewDecision', async () => {
  const src = await readFile(APP_JS, 'utf8');
  // Filter predicates live in the secondaryFilterChecks() registry that
  // matchingOfferings() applies.
  assert.match(src, /function matchingOfferings\(\) \{[\s\S]*?secondaryFilterChecks\(\)/);
  const matchStart = src.indexOf('function secondaryFilterChecks()');
  const matchEnd = src.indexOf('\n}\n', matchStart);
  const matchBody = src.slice(matchStart, matchEnd);
  assert.match(matchBody, /perfViewDecision\(/, 'the filter registry must consult perfViewDecision');
  assert.match(matchBody, /perfDecision\.pending/, 'minToks filter must be skipped while performance is pending');
  assert.match(matchBody, /perfDecision\.failed/, 'minToks filter must be skipped when performance failed');

  const computeStart = src.indexOf('function computeAndRender()');
  const computeEnd = src.indexOf('\n}\n', computeStart);
  const computeBody = src.slice(computeStart, computeEnd);
  assert.match(computeBody, /currentPerfDecision\(\)/, 'computeAndRender must consult the performance decision');
  assert.match(computeBody, /provisionalSort/, 'a pending/failed speed sort must fall back to a provisional cost order');
});

test('minimum-speed notice is explicit while pending and actionable on failure', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const state = { perfStatus: 'pending', sortBy: 'cost' };
  const els = { minToks: { value: '5' } };
  const api = makeNoticeHarness(src)(state, els);

  // Delayed performance + active speed minimum: explicit, provisional, awaiting.
  assert.match(api.perfNoticeText(), /speed minimum/i);
  assert.match(api.perfNoticeText(), /provisional/i);
  assert.equal(api.currentPerfDecision().pending, true);
  assert.equal(api.currentPerfDecision().dependent, true);

  // Failed performance + active speed minimum: explains it cannot be evaluated
  // and tells the user how to clear it.
  state.perfStatus = 'error';
  assert.match(api.perfNoticeText(), /cannot be evaluated/i);
  assert.match(api.perfNoticeText(), /clear the speed minimum/i);
  assert.equal(api.currentPerfDecision().failed, true);

  // Ready performance → no notice; the threshold is authoritative.
  state.perfStatus = 'ready';
  assert.equal(api.perfNoticeText(), '');

  // Cost-only startup with no speed minimum stays silent and usable.
  state.perfStatus = 'pending';
  state.sortBy = 'cost';
  els.minToks.value = '';
  assert.equal(api.perfNoticeText(), '');
  assert.equal(api.currentPerfDecision().pending, false);
});

test('export and WebMCP read contracts mark provisional speed-threshold views', async () => {
  const src = await readFile(APP_JS, 'utf8');

  const expStart = src.indexOf('function exportCsv()');
  const expEnd = src.indexOf('\n}\n', expStart);
  const exp = src.slice(expStart, expEnd);
  assert.match(exp, /currentPerfDecision\(\)/, 'CSV export must consult the live performance decision');
  assert.match(exp, /# TokenWatch export is provisional/, 'CSV must carry an explicit provisional note');
  assert.match(exp, /was not applied/, 'CSV must say the speed minimum was not applied');

  const viewStart = src.indexOf('function getView(input)');
  const viewEnd = src.indexOf('\n}\n', viewStart);
  const view = src.slice(viewStart, viewEnd);
  assert.match(view, /performance:\s*\{/, 'getView must expose the performance status');
  assert.match(view, /speedMinimumApplied/, 'getView must report whether the speed minimum was applied');
  assert.match(view, /provisional/, 'getView must flag a provisional row set');

  const expViewStart = src.indexOf('function exportCsvView()');
  const expViewEnd = src.indexOf('\n}\n', expViewStart);
  const expView = src.slice(expViewStart, expViewEnd);
  assert.match(expView, /provisional/, 'exportCsvView must flag a provisional export');
  assert.match(expView, /speedMinimumApplied/, 'exportCsvView must report whether the speed minimum was applied');
});

test('sortable column headers keep native columnheader semantics (no role=button)', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const start = src.indexOf("document.querySelectorAll('th.sortable')");
  const end = src.indexOf('// Mobile sort dropdown', start);
  assert.notEqual(start, -1, 'sortable header wiring must exist');
  assert.notEqual(end, -1, 'mobile sort marker must exist');
  const block = src.slice(start, end);
  assert.doesNotMatch(block, /setAttribute\(\s*['"]role['"]\s*,\s*['"]button['"]\s*\)/,
    'a <th> is already a columnheader — role=button is invalid with aria-sort');
  assert.match(block, /setAttribute\(\s*['"]tabindex['"]\s*,\s*['"]0['"]\s*\)/, 'headers stay keyboard-focusable');
  assert.match(block, /keydown/, 'Enter/Space sorting must remain');
  assert.match(block, /aria-sort/, 'sort state stays announced');
});

test('ranking explanation describes the actual fallback order while speed data is pending', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const state = { sortBy: 'speed', sortDir: 'desc', computeBy: 'tokens', costMode: 'perRequest' };
  const rankingMetric = new Function('state', 'currentPerfDecision',
    `${extractFn(src, 'rankingMetric')}\nreturn rankingMetric;`)(state, () => ({ provisionalSort: true }));
  assert.deepEqual(rankingMetric(), { by: 'cost', dir: 'asc', label: 'session cost' });
  state.computeBy = 'budget';
  assert.deepEqual(rankingMetric(), { by: 'cost', dir: 'desc', label: 'affordable tokens' });
});
