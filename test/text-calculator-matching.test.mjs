import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dirname, '..', 'public', 'app.js');

/** Extract a top-level `function name(...) { ... }` by locating its closing
 *  brace at column 0. app.js functions are all top-level, so this is stable
 *  and avoids brace counting tripping over regex quantifiers like `{4}`. */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js must define ${name}()`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name}() must close at column 0`);
  return src.slice(start, end + 2);
}

async function loadAppHelpers(names) {
  const src = await readFile(APP_JS, 'utf8');
  const code = names.map((n) => extractFn(src, n)).join('\n') + `\nreturn {${names.join(',')}};`;
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

const HELPERS = [
  'canonicalModelId',
  'resolveCanonicalQuery',
  'modelMatchesSearch',
  'freshInputRate',
  'costBreakdown',
  'costFor',
  'blendedCostFor',
  'affordabilityFor',
  'summaryWinners',
  'perfViewDecision',
];

const MIX = {
  total: 1e6,
  inputPct: 2.5,
  cacheReadPct: 97,
  outputPct: 0.5,
  input: 25_000,
  cacheRead: 970_000,
  output: 5_000,
  cacheWrite: 10e6,
  amortizeN: 100,
  sum: 100,
};

test('exact/unambiguous canonical selection uses exact canonical equality and excludes quant/SKU siblings', async () => {
  const app = await loadAppHelpers(['canonicalModelId', 'resolveCanonicalQuery', 'modelMatchesSearch']);
  const catalog = [
    { id: 'z-ai/glm-5.2', provider: 'z-ai' },
    { id: 'z-ai/glm-5.2', provider: 'novita' },
    { id: 'z-ai/glm-5.2-fp8', provider: 'deepinfra', quantization: 'fp8' },
    { id: 'z-ai/glm-5.2-nvfp4', provider: 'fireworks', quantization: 'nvfp4' },
    { id: 'glm-5.2-fast', provider: 'hyper' },
    { id: 'umans-glm-5.2', provider: 'umans' },
  ];

  const target = app.resolveCanonicalQuery(catalog, 'GLM 5.2');
  assert.equal(target, 'glm-5.2', 'space-separated unambiguous query resolves to the canonical id');

  const matched = catalog.filter((m) => app.modelMatchesSearch(m, 'glm 5.2', target, undefined));
  assert.equal(matched.length, 2, 'only exact canonical offerings remain');
  for (const m of matched) assert.equal(m.id, 'z-ai/glm-5.2');
  for (const bad of ['glm-5.2-fp8', 'glm-5.2-nvfp4', 'glm-5.2-fast', 'umans-glm-5.2']) {
    assert.ok(!matched.some((m) => m.id === bad), `${bad} must not broaden an exact selection`);
  }

  // Hyphen and space spellings resolve to the same canonical selection.
  assert.equal(app.resolveCanonicalQuery(catalog, 'glm-5.2'), 'glm-5.2');
  assert.deepEqual(
    catalog.filter((m) => app.modelMatchesSearch(m, 'glm-5.2', app.resolveCanonicalQuery(catalog, 'glm-5.2'), undefined)).map((m) => m.id),
    matched.map((m) => m.id),
  );

  // A quant-specific query stays exact to its own canonical id.
  const fp8Target = app.resolveCanonicalQuery(catalog, 'glm-5.2-fp8');
  assert.equal(fp8Target, 'glm-5.2-fp8');
  const fp8Matched = catalog.filter((m) => app.modelMatchesSearch(m, 'glm-5.2-fp8', fp8Target, undefined));
  assert.deepEqual(fp8Matched.map((m) => m.id), ['z-ai/glm-5.2-fp8']);
});

test('partial searches retain substring search across quant/SKU variants', async () => {
  const app = await loadAppHelpers(['canonicalModelId', 'resolveCanonicalQuery', 'modelMatchesSearch']);
  const catalog = [
    { id: 'z-ai/glm-5.2', provider: 'z-ai' },
    { id: 'z-ai/glm-5.2-fp8', provider: 'deepinfra', quantization: 'fp8' },
    { id: 'glm-5.2-fast', provider: 'hyper' },
    { id: 'umans-glm-5.2', provider: 'umans' },
  ];
  const target = app.resolveCanonicalQuery(catalog, 'glm');
  assert.equal(target, null, 'a broad partial query must not resolve to one canonical id');
  const matched = catalog.filter((m) => app.modelMatchesSearch(m, 'glm', target, undefined));
  assert.equal(matched.length, 4, 'partial search keeps the broad substring cohort');
});

test('summary and blended winners share fresh-input cache-write pricing and monthly scaling', async () => {
  const app = await loadAppHelpers(HELPERS);
  // A costs $1/M. B's fresh-input write tariff makes its rate $2.5142/M,
  // despite cheaper published input and cached-read rates.
  const rows = [
    { model: { provider: 'a', pricing: { input: 1, output: 1, cache_read: null, cache_write: null } } },
    { model: { provider: 'b', pricing: { input: 0.9, output: 0.9, cache_read: 0.01, cache_write: 100 } } },
  ];
  const blendedA = app.blendedCostFor(rows[0].model.pricing, MIX);
  const blendedB = app.blendedCostFor(rows[1].model.pricing, MIX);
  assert.equal(blendedA, 1);
  assert.ok(Math.abs(blendedB - 2.5142) < 1e-12);

  const w = app.summaryWinners(rows, MIX, { budgetMode: false, modeMultiplier: 1, perSessionBudget: 0 });
  assert.equal(w.blendedWinner.model.provider, 'a');
  assert.equal(w.costWinner.model.provider, 'a');

  // Monthly scaling (×30) must not change the winner, only the value.
  const wMonthly = app.summaryWinners(rows, MIX, { budgetMode: false, modeMultiplier: 30, perSessionBudget: 0 });
  assert.equal(wMonthly.costWinner.model.provider, 'a');
  assert.ok(Math.abs(wMonthly.costValue - w.costValue * 30) < 1e-9, 'monthly scaling applied to the headline value');
});

test('fresh-input writes replace input once and preserve the cached-read rate and budget inverse', async () => {
  const app = await loadAppHelpers(HELPERS);
  const pricing = { input: 2, cache_write: 5, cache_read: 0.2, output: 7 };
  const tokens = { ...MIX, total: 2e6, inputPct: 20, cacheReadPct: 50, outputPct: 30,
    input: 400_000, cacheRead: 1e6, output: 600_000, cacheWrite: 100e6, amortizeN: 10 };
  const breakdown = app.costBreakdown(pricing, tokens);
  assert.equal(breakdown.input, 2);
  assert.equal(breakdown.cacheRead, 0.2);
  assert.equal(breakdown.output, 4.2);
  assert.ok(Math.abs(breakdown.total - 6.4) < 1e-12, 'legacy write-volume fields must not add a second charge');
  assert.ok(Math.abs(app.blendedCostFor(pricing, tokens) - 3.2) < 1e-12);
  assert.ok(Math.abs(app.affordabilityFor(pricing, tokens, 20) - 6.25) < 1e-12);
  const noRead = { ...pricing, cache_read: null };
  assert.ok(Math.abs(app.costFor(noRead, tokens) - 8.2) < 1e-12,
    'missing cached-read price falls back to original input, not the write tariff');
  assert.deepEqual(pricing, { input: 2, cache_write: 5, cache_read: 0.2, output: 7 });
});

test('lower, equal, absent and invalid writes retain normal input; missing input stays unpriced', async () => {
  const app = await loadAppHelpers(HELPERS);
  const tokens = { ...MIX, inputPct: 20, cacheReadPct: 50, outputPct: 30,
    input: 200_000, cacheRead: 500_000, output: 300_000 };
  for (const cache_write of [undefined, null, '', 0, -1, 1, 2, '5', NaN, Infinity]) {
    const pricing = { input: 2, output: 7, cache_read: 0.2, cache_write };
    assert.ok(Math.abs(app.costFor(pricing, tokens) - 2.6) < 1e-12, `write=${String(cache_write)}`);
    assert.ok(Math.abs(app.blendedCostFor(pricing, tokens) - 2.6) < 1e-12);
  }
  const missing = { input: null, cache_write: 5, cache_read: 0.2, output: 7 };
  assert.equal(app.costFor(missing, tokens), null);
  assert.equal(app.blendedCostFor(missing, tokens), null);
  assert.equal(app.affordabilityFor(missing, tokens, 20), null);
});

test('summary keeps a zero-blended eligible offering as a candidate instead of excluding it', async () => {
  const app = await loadAppHelpers(HELPERS);
  const free = { model: { provider: 'free', pricing: { input: 0, output: 0, cache_read: 0, cache_write: null } } };
  const paid = { model: { provider: 'paid', pricing: { input: 2, output: 2, cache_read: 2, cache_write: null } } };
  const w = app.summaryWinners([free, paid], MIX, { budgetMode: false, modeMultiplier: 1, perSessionBudget: 0 });
  assert.equal(w.costWinner.model.provider, 'free');
  assert.equal(w.blendedWinner.model.provider, 'free');
  assert.equal(w.blendedValue, 0);
  assert.equal(w.costValue, 0);
});

test('summary in budget mode picks the greatest affordabilityFor result', async () => {
  const app = await loadAppHelpers(HELPERS);
  const rows = [
    { model: { provider: 'cheap', pricing: { input: 0.1, output: 0.1, cache_read: 0.01, cache_write: null } } },
    { model: { provider: 'pricey', pricing: { input: 5, output: 5, cache_read: 5, cache_write: null } } },
  ];
  const w = app.summaryWinners(rows, MIX, { budgetMode: true, modeMultiplier: 1, perSessionBudget: 20 });
  assert.equal(w.costWinner.model.provider, 'cheap');
  assert.ok(w.costValue > 0 && Number.isFinite(w.costValue));
});

test('perfViewDecision marks only performance-dependent views pending/failed and never blocks cost', async () => {
  const app = await loadAppHelpers(['perfViewDecision']);
  assert.deepEqual(app.perfViewDecision('pending', 'cost', 0), { dependent: false, pending: false, failed: false, provisionalSort: false });
  assert.deepEqual(app.perfViewDecision('pending', 'speed', 0), { dependent: true, pending: true, failed: false, provisionalSort: true });
  assert.deepEqual(app.perfViewDecision('pending', 'ttft', 0), { dependent: true, pending: true, failed: false, provisionalSort: true });
  assert.deepEqual(app.perfViewDecision('pending', 'cost', 5), { dependent: true, pending: true, failed: false, provisionalSort: false });
  assert.deepEqual(app.perfViewDecision('error', 'provider', 5), { dependent: true, pending: false, failed: true, provisionalSort: false });
  assert.deepEqual(app.perfViewDecision('ready', 'speed', 0), { dependent: true, pending: false, failed: false, provisionalSort: false });
  assert.deepEqual(app.perfViewDecision('error', 'speed', 0), { dependent: true, pending: false, failed: true, provisionalSort: true });
  assert.deepEqual(app.perfViewDecision('unavailable', 'ttft', 0), { dependent: true, pending: false, failed: true, provisionalSort: true });
});

test('budget distribution preserves unlimited affordability instead of displaying the finite maximum', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const rows = [
    { model: { provider: 'free' }, cost: Infinity },
    { model: { provider: 'paid' }, cost: 5 },
  ];
  const bars = { dataset: {}, innerHTML: '' };
  const details = { open: true, querySelector: () => bars, addEventListener() {} };
  const summaryElement = { innerHTML: '', querySelector: () => details };
  const els = { modelSearch: { value: 'sample' }, modelSummary: summaryElement, budgetInput: { value: '20' } };
  const render = new Function('els', 'state', 'canonicalSummary', 'MIN_PROVIDER_ROWS', 'summaryWinners',
    'providerName', 'esc', 'fmtAffordability', 'fmtCost', 'fmtPrice',
    `${extractFn(src, 'renderModelSummary')}\nreturn renderModelSummary;`)(
    els, { costMode: 'perRequest', computeBy: 'budget' },
    () => ({ name: 'Sample', canonical: 'sample' }), 1,
    () => ({ costWinner: rows[0], costValue: Infinity, blendedWinner: rows[0], blendedValue: 0 }),
    (p) => p, (v) => v, (v) => v === Infinity ? '∞' : String(v), String, String,
  );
  render(rows, MIX);
  assert.match(bars.innerHTML, /model-summary-bar-value">∞<\/span>/);
  assert.match(bars.innerHTML, /model-summary-bar-value">5<\/span>/);
});
