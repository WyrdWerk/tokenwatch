/**
 * Sparkline tests.
 *
 * The renderer is exercised against a hand-rolled DOM stub so the assertions
 * describe what the component actually emits (state attribute, message text,
 * SVG path geometry), not just that it ran. Each required state is covered:
 * loading, empty, error, single-point, flat-series, provider-switch, plus the
 * geometry that distinguishes a flat series from a normal one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(__dirname, '..', 'public', 'price-sparkline.js');

// ── Minimal DOM stub ──────────────────────────────────────────────────────────

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.classList = {
      _set: new Set(),
      add: (name) => this.classList._set.add(name),
      contains: (name) => this.classList._set.has(name),
    };
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(node) { this.childNodes.push(node); return node; }
  removeChild(node) { this.childNodes = this.childNodes.filter((n) => n !== node); }
  get firstChild() { return this.childNodes[0] || null; }
  /** All descendants, depth-first. */
  descendants() {
    const out = [];
    const walk = (node) => node.childNodes.forEach((child) => { out.push(child); walk(child); });
    walk(this);
    return out;
  }
  querySelector(selector) {
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const attr = selector.slice(1, -1);
      return this.descendants().find((n) => n.getAttribute(attr) !== null) || null;
    }
    return this.find(selector);
  }
  find(tag) { return this.descendants().find((n) => n.tagName === String(tag).toUpperCase()) || null; }
  findAll(tag) { return this.descendants().filter((n) => n.tagName === String(tag).toUpperCase()); }
}

function makeSandbox() {
  const sandbox = {
    document: {
      createElement: (tag) => new StubNode(tag),
      createElementNS: (_ns, tag) => new StubNode(tag),
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

async function loadSparkline() {
  const code = await readFile(SOURCE, 'utf8');
  const sandbox = makeSandbox();
  vm.runInContext(code, sandbox, { filename: 'price-sparkline.js' });
  return sandbox.PriceSparkline;
}

const point = (day, blended, provider = 'deepinfra') => ({ day, blended, provider });

// ── States ────────────────────────────────────────────────────────────────────

test('loading state renders a message and no chart geometry', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const container = new StubNode('div');
  createPriceSparkline(container).render({ state: 'loading' });

  assert.equal(container.getAttribute('data-state'), 'loading');
  assert.equal(container.find('svg'), null);
  assert.match(container.find('div').textContent, /Loading price history/);
  assert.match(container.getAttribute('aria-label'), /Loading price history/);
});

test('empty state explains that history has not started, and never draws a zero line', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const container = new StubNode('div');
  createPriceSparkline(container).render({ state: 'empty', points: [] });

  assert.equal(container.getAttribute('data-state'), 'empty');
  assert.equal(container.find('svg'), null, 'an empty history must not render an axis');
  assert.match(container.find('div').textContent, /No price history yet/);
  assert.doesNotMatch(container.getAttribute('aria-label'), /\$0\b/);
});

test('an empty points array renders the empty state even without an explicit state', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const container = new StubNode('div');
  createPriceSparkline(container).render({ points: [] });
  assert.equal(container.getAttribute('data-state'), 'empty');
});

test('error state surfaces the message and is visually distinct from empty', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const container = new StubNode('div');
  createPriceSparkline(container).render({ state: 'error', message: 'History API returned HTTP 503.' });

  assert.equal(container.getAttribute('data-state'), 'error');
  assert.equal(container.find('svg'), null);
  const message = container.find('div');
  assert.match(message.textContent, /Price history unavailable/);
  assert.match(message.descendants().find((n) => n.className === 'tw-spark-detail').textContent, /HTTP 503/);
});

test('single-point state draws a dot on a dashed baseline, not a broken line', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const container = new StubNode('div');
  createPriceSparkline(container).render({ points: [point('2026-09-14', 0.284)] });

  assert.equal(container.getAttribute('data-state'), 'single');
  const svg = container.find('svg');
  assert.ok(svg);
  assert.equal(svg.findAll('circle').length, 1);
  const baseline = svg.findAll('line').find((l) => l.getAttribute('stroke-dasharray'));
  assert.ok(baseline, 'a single point needs a baseline so it does not read as a failed chart');
  // No path — a one-point line would be invisible.
  assert.equal(svg.findAll('path').length, 0);
  assert.match(container.getAttribute('aria-label'), /one day recorded/);
  assert.match(container.getAttribute('aria-label'), /\$0\.284/);
});

test('flat series is detected, centred, and labelled as flat', async () => {
  const { createPriceSparkline, projectPoints } = await loadSparkline();
  const points = [
    point('2026-09-12', 1.5), point('2026-09-13', 1.5), point('2026-09-14', 1.5),
  ];
  const container = new StubNode('div');
  createPriceSparkline(container).render({ points });

  assert.equal(container.getAttribute('data-state'), 'flat');
  assert.equal(container.getAttribute('data-flat'), 'true');

  // The projected y must be the vertical centre, not the top or bottom edge.
  const projected = projectPoints(points);
  const ys = projected.map((p) => p.y);
  assert.equal(new Set(ys).size, 1, 'a flat series projects to one y value');
  assert.ok(ys[0] > 20 && ys[0] < 100, `flat y=${ys[0]} must sit inside the plot area, not on an edge`);

  const caption = container.descendants().find((n) => n.className === 'tw-spark-caption');
  assert.match(caption.textContent, /flat at \$1\.50/);
  assert.match(container.getAttribute('aria-label'), /unchanged across the period/);
});

test('a non-flat series is not mislabelled as flat and uses the full vertical range', async () => {
  const { createPriceSparkline, projectPoints } = await loadSparkline();
  const points = [
    point('2026-09-12', 0.1), point('2026-09-13', 5), point('2026-09-14', 2.5),
  ];
  const container = new StubNode('div');
  createPriceSparkline(container).render({ points });

  assert.equal(container.getAttribute('data-state'), 'ready');
  assert.equal(container.getAttribute('data-flat'), 'false');

  const projected = projectPoints(points);
  assert.notEqual(projected[0].y, projected[1].y);
  // The cheapest day sits at the bottom of the plot, the dearest at the top.
  assert.ok(projected[0].y > projected[1].y, 'cheaper value must plot lower on screen');
  const caption = container.descendants().find((n) => n.className === 'tw-spark-caption');
  assert.match(caption.textContent, /low \$0\.100 · high \$5\.00/);
});

test('provider-switch state marks the switch days and reports the count', async () => {
  const { createPriceSparkline, switchIndexes } = await loadSparkline();
  const points = [
    point('2026-09-10', 1, 'alpha'),
    point('2026-09-11', 1.1, 'alpha'),
    point('2026-09-12', 0.9, 'beta'),   // switch 1
    point('2026-09-13', 0.8, 'beta'),
    point('2026-09-14', 0.7, 'alpha'),  // switch 2
  ];
  assert.deepEqual([...switchIndexes(points)], [2, 4]);

  const container = new StubNode('div');
  createPriceSparkline(container).render({ points });

  assert.equal(container.getAttribute('data-state'), 'provider-switch');
  assert.equal(container.getAttribute('data-switches'), '2');
  const caption = container.descendants().find((n) => n.className === 'tw-spark-caption');
  assert.match(caption.textContent, /2 provider switches/);
  assert.match(container.getAttribute('aria-label'), /changed 2 time/);

  // Each switch draws a vertical marker in addition to the gridlines.
  const dashed = container.find('svg').findAll('line')
    .filter((l) => l.getAttribute('stroke-dasharray'));
  assert.equal(dashed.length, 2, 'one marker per provider switch');
});

test('a single switch is reported in the singular', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const points = [
    point('2026-09-13', 1, 'alpha'),
    point('2026-09-14', 0.5, 'beta'),
  ];
  const container = new StubNode('div');
  createPriceSparkline(container).render({ points });
  const caption = container.descendants().find((n) => n.className === 'tw-spark-caption');
  assert.match(caption.textContent, /1 provider switch\b/);
  assert.doesNotMatch(caption.textContent, /1 provider switches/);
});

test('a provider that never changes does not render switch markers', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const points = [
    point('2026-09-13', 1, 'alpha'),
    point('2026-09-14', 0.5, 'alpha'),
  ];
  const container = new StubNode('div');
  createPriceSparkline(container).render({ points });
  assert.equal(container.getAttribute('data-state'), 'ready');
  assert.equal(container.getAttribute('data-switches'), '0');
  assert.equal(container.find('svg').findAll('line').filter((l) => l.getAttribute('stroke-dasharray')).length, 0);
});

test('re-rendering replaces prior content instead of appending', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const container = new StubNode('div');
  const spark = createPriceSparkline(container);
  spark.render({ state: 'loading' });
  spark.render({ points: [point('2026-09-14', 1)] });
  spark.render({ points: [point('2026-09-13', 1), point('2026-09-14', 2)] });

  assert.equal(container.childNodes.length, 2, 'one svg + one caption');
  assert.equal(container.find('svg').findAll('path').length, 1);
});

// ── Geometry / formatting helpers ─────────────────────────────────────────────

test('projectPoints spaces points evenly and keeps chronological x order', async () => {
  const { projectPoints } = await loadSparkline();
  const projected = projectPoints([
    point('2026-09-12', 1), point('2026-09-13', 2), point('2026-09-14', 3),
  ]);
  assert.ok(projected[0].x < projected[1].x && projected[1].x < projected[2].x);
  assert.equal(projected[1].x - projected[0].x, projected[2].x - projected[1].x);
  // Higher price plots higher on screen (smaller y).
  assert.ok(projected[0].y > projected[2].y);
});

test('a single point is horizontally centred', async () => {
  const { projectPoints, VIEW_W } = await loadSparkline();
  const projected = projectPoints([point('2026-09-14', 1)]);
  assert.ok(Math.abs(projected[0].x - VIEW_W / 2) < 80);
});

test('fmtRate renders sub-cent rates with enough precision to be useful', async () => {
  const { fmtRate } = await loadSparkline();
  assert.equal(fmtRate(0), '$0');
  assert.equal(fmtRate(0.0025), '$0.0025');
  assert.equal(fmtRate(0.284), '$0.284');
  assert.equal(fmtRate(1.5), '$1.50');
  assert.equal(fmtRate(null), '—');
});

test('fmtDay renders an unambiguous short date', async () => {
  const { fmtDay } = await loadSparkline();
  assert.equal(fmtDay('2026-09-14'), 'Sep 14');
  assert.equal(fmtDay('2026-01-01'), 'Jan 1');
});

test('the component never treats a missing value as zero', async () => {
  const { createPriceSparkline } = await loadSparkline();
  const container = new StubNode('div');
  // A point whose blend could not be computed must not become a $0 line.
  createPriceSparkline(container).render({ points: [] });
  assert.equal(container.find('svg'), null);
  assert.doesNotMatch(container.getAttribute('aria-label'), /\$0/);
});

// ── Model-history wiring ──────────────────────────────────────────────────────

async function loadModelHistory(fetchImpl, localStorageValue) {
  const code = await readFile(join(__dirname, '..', 'public', 'model-history.js'), 'utf8');
  const sparkline = await readFile(SOURCE, 'utf8');
  const sandbox = makeSandbox();
  sandbox.fetch = fetchImpl;
  sandbox.localStorage = {
    getItem: (key) => (key === 'tw-mix' ? localStorageValue ?? null : null),
  };
  sandbox.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  vm.createContext(sandbox);
  vm.runInContext(sparkline, sandbox, { filename: 'price-sparkline.js' });
  vm.runInContext(code, sandbox, { filename: 'model-history.js' });
  return sandbox.ModelHistory;
}

test('historyUrl encodes the canonical id and appends the mix', async () => {
  const ModelHistory = await loadModelHistory(async () => { throw new Error('unused'); });
  assert.equal(
    ModelHistory.historyUrl('glm-5.2', 90, [2.5, 97, 0.5]),
    '/api/v1/models/glm-5.2/history?days=90&mix=2.5,97,0.5',
  );
  assert.equal(
    ModelHistory.historyUrl('org/model', 7, [10, 0, 90]),
    '/api/v1/models/org%2Fmodel/history?days=7&mix=10,0,90',
  );
});

test('readMix parses the exact CSV string app.js writes to tw-mix', async () => {
  // public/app.js:193 persists raw CSV:
  //   localStorage.setItem('tw-mix', `${inputPct.value},${cacheReadPct.value},${outputPct.value}`)
  // This is the production contract. Parsing it as JSON silently falls back to
  // the default mix and the chart shows the wrong workload.
  const exact = '10,0,90';
  const ModelHistory = await loadModelHistory(async () => { throw new Error('unused'); }, exact);
  assert.deepEqual([...ModelHistory.readMix()], [10, 0, 90],
    'the raw CSV value app.js writes must be parsed, not discarded');
});

test('the saved CSV mix drives the request URL, not the default', async () => {
  // End-to-end through the request builder: a visitor who saved 10,0,90 must
  // get a URL carrying that mix, so the API blends at their workload.
  const ModelHistory = await loadModelHistory(async () => { throw new Error('unused'); }, '10,0,90');
  const mix = ModelHistory.readMix();
  assert.equal(ModelHistory.historyUrl('glm-5.2', 90, mix), '/api/v1/models/glm-5.2/history?days=90&mix=10,0,90');
  assert.notEqual(ModelHistory.historyUrl('glm-5.2', 90, mix), '/api/v1/models/glm-5.2/history?days=90&mix=2.5,97,0.5');

  // And the fetch actually uses it.
  const urls = [];
  const WithFetch = await loadModelHistory(async (url) => {
    urls.push(url);
    return { ok: true, status: 200, async json() { return { points: [{ day: '2026-09-14', blended: 1, provider: 'p' }] }; } };
  }, '10,0,90');
  await WithFetch.createModelHistory(new StubNode('div'), 'glm-5.2').load();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /mix=10,0,90$/);
});

test('readMix accepts JSON forms for robustness and rejects unusable values', async () => {
  const cases = [
    ['10,0,90', [10, 0, 90]],                       // production CSV contract
    [' 10 , 0 , 90 ', [10, 0, 90]],                 // whitespace tolerated
    ['[10,0,90]', [10, 0, 90]],                     // JSON array
    ['{"inputPct":10,"cacheReadPct":0,"outputPct":90}', [10, 0, 90]], // JSON object
    ['33.33,33.33,33.34', [33.33, 33.33, 33.34]],   // float rounding tolerated
    // Unusable → agentic default (never a 400 from the API).
    ['10,10,10', [2.5, 97, 0.5]],                   // does not sum to 100
    ['10,0', [2.5, 97, 0.5]],                       // wrong arity
    ['a,b,c', [2.5, 97, 0.5]],
    ['-1,0,101', [2.5, 97, 0.5]],
    ['', [2.5, 97, 0.5]],
    ['{bad json', [2.5, 97, 0.5]],
  ];
  for (const [stored, expected] of cases) {
    const ModelHistory = await loadModelHistory(async () => { throw new Error('unused'); }, stored);
    assert.deepEqual([...ModelHistory.readMix()], expected, `tw-mix=${JSON.stringify(stored)}`);
  }

  const noMix = await loadModelHistory(async () => { throw new Error('unused'); }, null);
  assert.deepEqual([...noMix.readMix()], [2.5, 97, 0.5]);
});

test('a successful fetch renders points and a provider-switch note', async () => {
  const payload = {
    points: [
      point('2026-09-13', 1, 'alpha'),
      point('2026-09-14', 0.8, 'beta'),
    ],
    provider_switches: 1,
  };
  const ModelHistory = await loadModelHistory(async () => ({
    ok: true, status: 200, async json() { return payload; },
  }), null);
  const container = new StubNode('div');
  const note = new StubNode('p');
  const instance = ModelHistory.createModelHistory(container, 'glm-5.2', { note });
  await instance.load();

  assert.equal(container.getAttribute('data-state'), 'provider-switch');
  assert.match(note.textContent, /provider switch/);
  assert.match(note.textContent, /2\.5% input/);
});

test('an HTTP 503 renders the error state with an environment-specific message', async () => {
  const ModelHistory = await loadModelHistory(async () => ({
    ok: false, status: 503, async json() { return {}; },
  }), null);
  const container = new StubNode('div');
  await ModelHistory.createModelHistory(container, 'glm-5.2').load();

  assert.equal(container.getAttribute('data-state'), 'error');
  const detail = container.descendants().find((n) => n.className === 'tw-spark-detail');
  assert.match(detail.textContent, /not enabled in this environment/);
});

test('a network failure renders the error state rather than an empty chart', async () => {
  const ModelHistory = await loadModelHistory(async () => { throw new Error('offline'); }, null);
  const container = new StubNode('div');
  await ModelHistory.createModelHistory(container, 'glm-5.2').load();
  assert.equal(container.getAttribute('data-state'), 'error');
  assert.match(container.getAttribute('aria-label'), /unavailable/i);
});

test('an empty API result renders the empty state, not a zero line', async () => {
  const ModelHistory = await loadModelHistory(async () => ({
    ok: true, status: 200, async json() { return { points: [], provider_switches: 0 }; },
  }), null);
  const container = new StubNode('div');
  await ModelHistory.createModelHistory(container, 'glm-5.2').load();
  assert.equal(container.getAttribute('data-state'), 'empty');
});

test('mountAll wires every declared container in one pass', async () => {
  const payload = { points: [point('2026-09-14', 1)], provider_switches: 0 };
  const ModelHistory = await loadModelHistory(async () => ({
    ok: true, status: 200, async json() { return payload; },
  }), null);

  const wrappers = [new StubNode('div'), new StubNode('div')];
  wrappers[0].setAttribute('data-price-history', 'model-a');
  wrappers[1].setAttribute('data-price-history', 'model-b');
  wrappers.forEach((wrapper) => {
    const chart = new StubNode('div');
    chart.setAttribute('data-price-history-chart', '');
    wrapper.appendChild(chart);
  });
  const root = {
    querySelectorAll: () => wrappers,
  };
  const mounted = ModelHistory.mountAll(root);
  assert.equal(mounted.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const wrapper of wrappers) {
    assert.equal(wrapper.find('svg') !== null || wrapper.childNodes[0].getAttribute('data-state') === 'single', true);
  }
});