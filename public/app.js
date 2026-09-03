// deploy-fix: stale cache bypass
// deploy: 2026-07-30 neuralwatt
// TokenWatch — app.js
// Loads pricing.json, lets the user search by provider (inference host) and/or
// model name, enter token volumes as total + percentage breakdown, and computes
// per-offering cost.

// Shared helpers live in shared-ui.js (window.TW), loaded before this script.
const { esc, median, fmtIST, debounce } = window.TW;
const { fmtPrice, fmtCost } = window.TW.makeFormatters({ style: 'round3', missingCost: 'N/A' });

const state = {
  data: null,             // { generated_at, providers, models }
  providerSearch: '',     // provider name filter text
  modelSearch: '',        // canonical model name filter text
  providerDisplayName: {},// provider display name lowercase → pretty (e.g. "deepinfra" → "DeepInfra")
  modelDisplayName: {},   // canonical → display name
  sortBy: 'cost',         // current sort column key
  sortDir: 'asc',         // 'asc' or 'desc'
  costMode: 'perRequest', // 'perRequest' or 'monthly'
  computeBy: 'tokens',   // 'tokens' (forward) or 'budget' (inverse)
  groupBy: 'none',
  compareSelection: [], // array of model objects (max 6)
  currentRows: null,
  perfData: null,         // loaded from performance.json
  showAllRows: false,    // when false, flat unfiltered table caps at ROW_CAP rows
  colOrder: null,         // array of the 10 draggable column keys in display order (null = default)
  colHidden: null,        // Set of hidden column keys (null = none hidden)
};

// Flat-table render cap: first paint shows this many rows + a "Show all" row.
// data-idx is resolved via findIndex against the full state.currentRows, so a
// head slice keeps detail-modal/compare indices correct for visible rows.
const ROW_CAP = 250;

// The 10 draggable/hideable columns (between the locked # and Total Cost columns).
// key → { label (popover + hash), dataLabel (td[data-label] match) }.
const COLUMN_KEYS = [
  { key: 'org',        label: 'Org',          dataLabel: 'Org' },
  { key: 'provider',   label: 'Provider',     dataLabel: 'Provider' },
  { key: 'model',      label: 'Model',        dataLabel: 'Model' },
  { key: 'input',      label: 'Input $/M',    dataLabel: 'Input $/M' },
  { key: 'output',     label: 'Output $/M',   dataLabel: 'Output $/M' },
  { key: 'cache_read', label: 'Cache $/M',    dataLabel: 'Cache $/M' },
  { key: 'context',    label: 'Context',      dataLabel: 'Context' },
  { key: 'speed',      label: 'Speed',        dataLabel: 'Speed' },
  { key: 'ttft',       label: 'TTFT',         dataLabel: 'TTFT' },
  { key: 'blended',    label: 'Blended $/M',  dataLabel: 'Blended $/M' },
];
const DEFAULT_COL_ORDER = COLUMN_KEYS.map((c) => c.key);

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  providerSearch: $('providerSearch'),
  modelSearch: $('modelSearch'),
  orgList: $('orgList'),
  modelList: $('modelList'),
  totalTokens: $('totalTokens'),
  inputPct: $('inputPct'),
  cacheReadPct: $('cacheReadPct'),
  outputPct: $('outputPct'),
  tokenBreakdown: $('tokenBreakdown'),
  pctSum: $('pctSum'),
  resultsBody: $('resultsBody'),
  resultsTitle: $('resultsTitle'),
  lastUpdated: $('lastUpdated'),
  perfUpdated: $('perfUpdated'),
  promoOnly: $('promoOnly'),
  zdrOnly: $('zdrOnly'),
  subscriptionOnly: $('subscriptionOnly'),
  hideBatch: $('hideBatch'),
  cacheOnly: $('cacheOnly'),
  maxBlended: $('maxBlended'),
  minToks: $('minToks'),
  hqFilter: $('hqFilter'),
  popularChips: $('popularChips'),
  minIntelligence: $('minIntelligence'),
  modePerRequest: $('modePerRequest'),
  modeMonthly: $('modeMonthly'),
  totalTokensLabel: $('totalTokensLabel'),
  totalTokensHint: $('totalTokensHint'),
  costColumnHeader: $('costColumnHeader'),
  speedColumnHeader: $('speedColumnHeader'),
  showOrg: $('showOrg'),
  groupBy: $('groupBy'),
  exportCsvBtn: $('exportCsvBtn'),
  compareTray: $('compareTray'),
  compareCount: $('compareCount'),
  compareBtn: $('compareBtn'),
  compareClear: $('compareClear'),
  compareModal: $('compareModal'),
  compareClose: $('compareClose'),
  compareBody: $('compareBody'),
  detailModal: $('detailModal'),
  detailClose: $('detailClose'),
  detailBody: $('detailBody'),
  detailTitle: $('detailTitle'),
  cacheWriteTokens: $('cacheWriteTokens'),
  amortizeN: $('amortizeN'),
  mobileSort: $('mobileSort'),
  byTokens: $('byTokens'),
  byBudget: $('byBudget'),
  budgetInput: $('budgetInput'),
  budgetField: $('budgetField'),
  totalTokensField: $('totalTokensField'),
  budgetLabel: $('budgetLabel'),
  budgetHint: $('budgetHint'),
  benchmarkBar: $('benchmarkBar'),
};


// Theme toggle — shared init (applies saved/default theme, wires the button).
TW.initTheme();

// Default control values — used to keep shared URLs minimal when unchanged
const DEFAULTS = {
  totalTokens: '1000',
  budget: '20',
  computeBy: 'tokens',
  inputPct: '2.5',
  cacheReadPct: '97',
  outputPct: '0.5',
  providerSearch: '',
  modelSearch: '',
  promoOnly: false,
  zdrOnly: false,
  subscriptionOnly: false,
  hideBatch: true,
  cacheOnly: false,
  maxBlended: 0,
  minToks: 0,
  hq: '',
  minIntelligence: 0,
  sortBy: 'cost',
  sortDir: 'asc',
  groupBy: 'none',
};

/** providers_meta slugs that differ from catalog provider keys. */
const HQ_SLUG_ALIASES = {
  google: 'google-ai-studio',
  amazon: 'amazon-bedrock',
  atlascloud: 'atlas-cloud',
  moonshot: 'moonshotai',
  'mancer-2': 'mancer',
  arcee: 'arcee-ai',
  'claude-platform-on-aws': 'amazon-bedrock',
};

/** Named mix presets — same objects the preset buttons apply. WebMCP list_presets / apply_preset read this; do not fork a second table. */
const PRESETS = {
  agentic:        { totalTokens: 1000, inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 },
  balanced:       { totalTokens: 1000, inputPct: 30,  cacheReadPct: 50,  outputPct: 20 },
  'heavy-output': { totalTokens: 1000, inputPct: 10,  cacheReadPct: 0,   outputPct: 90 },
  'no-cache':     { totalTokens: 1000, inputPct: 70,  cacheReadPct: 0,   outputPct: 30 },
};

const CATALOG_PAGES = {
  text: '/',
  image: '/image',
  video: '/video',
  benchmarks: '/benchmarks',
};

// ── URL hash state ─────────────────────────────────────────────────────────────

/** Build a hash query string from current UI + sort state. Omits default values. */
function serializeState() {
  const params = new URLSearchParams();

  const tokens = els.totalTokens.value;
  if (tokens !== DEFAULTS.totalTokens) params.set('tokens', tokens);

  const { inputPct, cacheReadPct, outputPct } = els;
  const mixDefault =
    inputPct.value === DEFAULTS.inputPct &&
    cacheReadPct.value === DEFAULTS.cacheReadPct &&
    outputPct.value === DEFAULTS.outputPct;
  if (!mixDefault) {
    params.set('mix', `${inputPct.value},${cacheReadPct.value},${outputPct.value}`);
  }
  // Cross-page mix sharing: the Benchmarks page reads this to compute blended
  // $/M at the visitor's own workload mix (same text boxes, one source of truth).
  try {
    localStorage.setItem('tw-mix', `${inputPct.value},${cacheReadPct.value},${outputPct.value}`);
  } catch (e) { /* private mode etc. — non-fatal */ }

  const provider = els.providerSearch.value.trim();
  if (provider) params.set('provider', provider);

  const model = els.modelSearch.value.trim();
  if (model) params.set('model', model);
  if (els.zdrOnly?.checked) params.set('zdr', '1');
  if (els.subscriptionOnly?.checked) params.set('sub', '1');

  const minInt = parseInt(els.minIntelligence?.value, 10) || 0;
  if (minInt !== DEFAULTS.minIntelligence) params.set('minIntelligence', String(minInt));
  if (els.promoOnly.checked) params.set('promo', '1');
  if (els.hideBatch && els.hideBatch.checked !== DEFAULTS.hideBatch) params.set('batch', '1');
  if (els.cacheOnly?.checked) params.set('cacheOnly', '1');
  const maxBlended = parseFloat(els.maxBlended?.value);
  if (Number.isFinite(maxBlended) && maxBlended > 0) params.set('maxBlended', String(maxBlended));
  const minToks = parseFloat(els.minToks?.value);
  if (Number.isFinite(minToks) && minToks > 0) params.set('minToks', String(minToks));
  const hq = els.hqFilter?.value || '';
  if (hq) params.set('hq', hq);

  if (state.sortBy !== DEFAULTS.sortBy || state.sortDir !== DEFAULTS.sortDir) {
    params.set('sort', `${state.sortBy}:${state.sortDir}`);
  }

  if (state.costMode === 'monthly') params.set('mode', 'monthly');

  if (state.computeBy === 'budget') params.set('by', 'budget');
  const budget = els.budgetInput?.value;
  if (budget && budget !== DEFAULTS.budget) params.set('budget', budget);

  if (els.groupBy.value !== 'none') params.set('group', els.groupBy.value);
  if (els.showOrg?.checked) params.set('orgcol', '1');

  const cacheWriteVal = parseFloat(document.getElementById('cacheWriteTokens').value) || 0;
  const amortizeVal = parseInt(document.getElementById('amortizeN').value, 10) || 100;
    if (cacheWriteVal > 0) params.set('cw', document.getElementById('cacheWriteTokens').value);
    if (amortizeVal !== 100) params.set('cwn', String(amortizeVal));

    // Column customization: order + hidden set (only when non-default)
    if (state.colOrder && state.colOrder.join(',') !== DEFAULT_COL_ORDER.join(',')) {
      params.set('cols', state.colOrder.join(','));
    }
    if (state.colHidden && state.colHidden.size > 0) {
      params.set('hide', [...state.colHidden].join(','));
    }

    return params.toString();
}
function deserializeState(hash) {
  els.totalTokens.value = DEFAULTS.totalTokens;
  els.budgetInput.value = DEFAULTS.budget;
  els.inputPct.value = DEFAULTS.inputPct;
  els.cacheReadPct.value = DEFAULTS.cacheReadPct;
  els.outputPct.value = DEFAULTS.outputPct;
  els.providerSearch.value = DEFAULTS.providerSearch;
  if (els.zdrOnly) els.zdrOnly.checked = DEFAULTS.zdrOnly;
  if (els.minIntelligence) els.minIntelligence.value = DEFAULTS.minIntelligence;
  els.modelSearch.value = DEFAULTS.modelSearch;
  els.promoOnly.checked = DEFAULTS.promoOnly;
  if (els.subscriptionOnly) els.subscriptionOnly.checked = DEFAULTS.subscriptionOnly;
  if (els.hideBatch) els.hideBatch.checked = DEFAULTS.hideBatch;
  if (els.cacheOnly) els.cacheOnly.checked = DEFAULTS.cacheOnly;
  if (els.maxBlended) els.maxBlended.value = DEFAULTS.maxBlended || '';
  if (els.minToks) els.minToks.value = DEFAULTS.minToks || '';
  if (els.hqFilter) els.hqFilter.value = DEFAULTS.hq;
  if (els.showOrg) { els.showOrg.checked = false; document.getElementById('resultsTable').classList.add('hide-org'); }
  state.sortBy = DEFAULTS.sortBy;
  state.sortDir = DEFAULTS.sortDir;
  state.costMode = 'perRequest';
  state.computeBy = 'tokens';
  els.modePerRequest.classList.toggle('active', true);
  els.modeMonthly.classList.toggle('active', false);
  els.byTokens?.classList.toggle('active', true);
  els.byBudget?.classList.toggle('active', false);
  els.totalTokensField.style.display = '';
  els.budgetField.style.display = 'none';
  updateLabelsAndHeaders();
  els.groupBy.value = DEFAULTS.groupBy;
    document.getElementById('cacheWriteTokens').value = '0';
    document.getElementById('amortizeN').value = '100';
    state.colOrder = null;
    state.colHidden = null;

  const raw = (hash || '').replace(/^#/, '');
  if (!raw) return;

  const params = new URLSearchParams(raw);

  if (params.has('tokens')) els.totalTokens.value = params.get('tokens');
  if (params.has('mix')) {
    const [input, cache, output] = params.get('mix').split(',');
    if (input !== undefined) els.inputPct.value = input;
    if (cache !== undefined) els.cacheReadPct.value = cache;
    if (output !== undefined) els.outputPct.value = output;
  }
  if (params.has('provider')) els.providerSearch.value = params.get('provider');
  if (params.has('model')) els.modelSearch.value = params.get('model');
  if (params.has('promo')) els.promoOnly.checked = params.get('promo') === '1';
  if (params.has('zdr') && els.zdrOnly) els.zdrOnly.checked = params.get('zdr') === '1';
  if (params.has('sub') && els.subscriptionOnly) els.subscriptionOnly.checked = params.get('sub') === '1';
  if (params.has('minIntelligence')) els.minIntelligence.value = params.get('minIntelligence');
  if (els.hideBatch) els.hideBatch.checked = params.get('batch') === '1' ? false : DEFAULTS.hideBatch;
  if (params.has('cacheOnly') && els.cacheOnly) els.cacheOnly.checked = params.get('cacheOnly') === '1';
  if (params.has('maxBlended') && els.maxBlended) els.maxBlended.value = params.get('maxBlended');
  if (params.has('minToks') && els.minToks) els.minToks.value = params.get('minToks');
  if (params.has('hq') && els.hqFilter) els.hqFilter.value = params.get('hq');
  if (params.has('sort')) {
    const [by, dir] = params.get('sort').split(':');
    if (by) state.sortBy = by;
    if (dir === 'asc' || dir === 'desc') state.sortDir = dir;
  }

  const mode = params.get('mode');
  if (mode === 'monthly') setCostMode('monthly');

  const group = params.get('group');
  if (group) els.groupBy.value = group;
  if (params.has('orgcol') && els.showOrg) { els.showOrg.checked = params.get('orgcol') === '1'; document.getElementById('resultsTable').classList.toggle('hide-org', !els.showOrg.checked); }
  if (params.has('cw')) document.getElementById('cacheWriteTokens').value = params.get('cw');
  if (params.has('budget')) els.budgetInput.value = params.get('budget');
  if (params.get('by') === 'budget') setComputeBy('budget');
    if (params.has('cwn')) document.getElementById('amortizeN').value = params.get('cwn');

    // Column customization: order + hidden set
      if (params.has('cols')) {
        const order = params.get('cols').split(',').filter((k) => COLUMN_KEYS.some((c) => c.key === k));
        // Only accept a complete, valid order — a partial list would silently
        // append the missing columns in default order, which is surprising.
        if (order.length === COLUMN_KEYS.length) state.colOrder = order;
      }
    if (params.has('hide')) {
      const hidden = params.get('hide').split(',').filter((k) => COLUMN_KEYS.some((c) => c.key === k));
      if (hidden.length > 0) state.colHidden = new Set(hidden);
    }
  }

/** Sync the URL hash to current state without adding history entries. */
function updateHash() {
  const hash = serializeState();
  const current = location.hash.slice(1);
  if (hash === current) return;
  const url = hash ? `#${hash}` : `${location.pathname}${location.search}`;
  history.replaceState(null, '', url);
}

/** Format an ISO timestamp as IST (Asia/Kolkata). Returns — on invalid input. */


// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('pricing.json');
    state.data = await res.json();
  } catch (err) {
    els.resultsBody.innerHTML = `<tr><td colspan="${els.showOrg?.checked ? 12 : 11}" class="empty error-state">
      <p>Could not load pricing data.</p>
      <p class="error-hint">Run <code>node scripts/fetch-pricing.mjs</code> if you're developing locally.</p>
      <button type="button" class="retry-btn" onclick="location.reload()">Retry</button>
    </td></tr>`;
    return;
  }

  els.lastUpdated.textContent = `Pricing (IST): ${fmtIST(state.data.generated_at)}`;
  populateDatalists();
  deserializeState(location.hash.slice(1));
  attachListeners();
  updateCompareTray();
  await refreshPerfData(true);
  computeAndRender();
  publishTwCatalog();
}

/** Fetch performance.json. Fail-soft: on initial load sets {}, on refresh keeps last-good data. */
let _perfInFlight = false;
let _lastPerfFetch = 0;
const PERF_COOLDOWN_MS = 60_000; // min 60s between refreshes

async function refreshPerfData(isInitial = false) {
  const now = Date.now();
  if (_perfInFlight) return false;
  if (!isInitial && now - _lastPerfFetch < PERF_COOLDOWN_MS) return false;
  _perfInFlight = true;
  _lastPerfFetch = now;
  let changed = false;
  try {
    const perfRes = await fetch('performance.json');
    if (perfRes.ok) {
      const next = await perfRes.json();
      const prevTs = state.perfData?._meta?.generated_at;
      const ts = next?._meta?.generated_at;
      changed = isInitial || ts !== prevTs;
      state.perfData = next;
      if (els.perfUpdated) els.perfUpdated.textContent = ts
        ? `Performance (IST): ${fmtIST(ts)}`
        : 'Performance (IST): (no timestamp)';
    } else if (isInitial) {
      state.perfData = {};
      changed = true;
    }
  } catch (err) {
    if (isInitial) { state.perfData = {}; changed = true; }
    // On refresh failure: retain last-good state.perfData and timestamp
  } finally {
    _perfInFlight = false;
  }
  return changed;
}

/** Build a canonical model key for cross-provider matching.
 *  Strips provider prefix, suffixes (:free, dates, -preview, :thinking), lowercases.
 *  Date formats stripped: YYYY-MM-DD, YYYYMMDD, YYYYMM.
 *  Preview formats stripped: -preview, -preview-MM-YY, -preview-MM-YYYY, -preview-YYYY-MM-DD.
 *  Used for MATCHING only — display ID stays as-is.
 *  Turbo variants kept separate (different SKUs). */
function canonicalModelId(id) {
  let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
  k = k.replace(/:free$/, '')
       .replace(/:thinking$/, '')
       .replace(/-(\d{4})-(\d{2})-(\d{2})$/, '')
       .replace(/-preview-(\d{2})-(\d{4})$/, '')
       .replace(/-preview-(\d{4})-(\d{2})-(\d{2})$/, '')
       .replace(/-preview-(\d{2})-(\d{2})$/, '')
       .replace(/-preview$/, '')
       .replace(/-(\d{8})$/, '')
       .replace(/-(\d{6})$/, '')
       .toLowerCase().trim();
  return k;
}

// ── Selectors ──────────────────────────────────────────────────────────────────

function populateDatalists() {
  // Build provider display names and populate provider datalist
  const provCounts = {};
  for (const m of state.data.models) {
    const name = providerName(m.provider, m.provider_display);
 provCounts[name] = (provCounts[name] || 0) + 1;
  }
  state.providerDisplayName = {};
  els.orgList.innerHTML = Object.keys(provCounts)
    .sort((a, b) => provCounts[b] - provCounts[a])  // most models first
    .map((name) => {
      state.providerDisplayName[name.toLowerCase()] = name;
      return `<option value="${name}">${name} (${provCounts[name]})</option>`;
    })
    .join('');

  // Build canonical model display names and populate model datalist
  const modelKeys = new Map(); // canonical -> display name
  for (const m of state.data.models) {
    const c = canonicalModelId(m.id);
    if (!modelKeys.has(c)) modelKeys.set(c, m.id.includes('/') ? m.id.split('/').slice(-1)[0] : m.id);
  }
  state.modelDisplayName = {};
  const sortedKeys = [...modelKeys.keys()].sort();
  els.modelList.innerHTML = sortedKeys
    .map((k) => {
      state.modelDisplayName[k] = modelKeys.get(k);
      return `<option value="${modelKeys.get(k)}">`;
    })
    .join('');
}

// ── Event listeners ────────────────────────────────────────────────────────────

function setCostMode(mode) {
  state.costMode = mode;
  els.modePerRequest.classList.toggle('active', mode === 'perRequest');
  els.modeMonthly.classList.toggle('active', mode === 'monthly');
  updateLabelsAndHeaders();
  computeAndRender();
}

function setComputeBy(mode) {
  state.computeBy = mode;
  els.byTokens?.classList.toggle('active', mode === 'tokens');
  els.byBudget?.classList.toggle('active', mode === 'budget');
  // Show/hide the appropriate input field (only one is visible at a time)
  const showBudget = mode === 'budget';
  els.totalTokensField.style.display = showBudget ? 'none' : '';
  els.budgetField.style.display = showBudget ? '' : 'none';
  // Convention: budget mode ranks highest-affordability first (desc).
  // Only flip when currently on the cost/affordability column, so a
  // user's explicit sort on (org/provider/model/price/context) is preserved.
  if (state.sortBy === 'cost') {
    state.sortDir = mode === 'budget' ? 'desc' : 'asc';
  }
  updateLabelsAndHeaders();
  computeAndRender();
}

/** Update token-input labels, hints, and the cost/affordability column header
 *  for the current (computeBy × costMode) combination. Called by both setters. */
function updateLabelsAndHeaders() {
  const monthly = state.costMode === 'monthly';
  const budget = state.computeBy === 'budget';
  if (budget) {
    els.budgetLabel.textContent = monthly ? 'Monthly budget' : 'Budget';
    els.budgetHint.textContent = monthly
      ? 'USD per month (×30 days)'
      : 'USD per session (e.g. 20 = $20/session)';
    els.costColumnHeader.textContent = monthly
      ? 'Monthly Affordable Tokens (×30 days)'
      : 'Affordable Tokens (M)';
  } else {
    if (monthly) {
      els.totalTokensLabel.textContent = 'Daily tokens';
      els.totalTokensHint.textContent = 'Million tokens/day (e.g. 33 = 33M tokens/day)';
      els.costColumnHeader.textContent = 'Monthly Cost (×30 days)';
    } else {
      els.totalTokensLabel.textContent = 'Total tokens';
      els.totalTokensHint.textContent = 'Million tokens (e.g. 1000 = 1B tokens)';
      els.costColumnHeader.textContent = 'Total Cost';
    }
  }
}

function attachListeners() {
  els.modePerRequest.addEventListener('click', () => setCostMode('perRequest'));
  els.modeMonthly.addEventListener('click', () => setCostMode('monthly'));
  els.byTokens?.addEventListener('click', () => setComputeBy('tokens'));
  els.byBudget?.addEventListener('click', () => setComputeBy('budget'));
  // Changing a filter/search can change the visible row set, so drop any
  // "show all" expansion and re-render (immediate for toggles, debounced for text).
  const onFilterChange = () => { state.showAllRows = false; computeAndRender(); };
  const onFilterChangeDebounced = debounce(onFilterChange);

  els.budgetInput?.addEventListener('input', debounce(() => computeAndRender()));

  els.providerSearch.addEventListener('input', onFilterChangeDebounced);
  els.modelSearch.addEventListener('input', onFilterChangeDebounced);
  els.promoOnly.addEventListener('change', onFilterChange);
  if (els.zdrOnly) els.zdrOnly.addEventListener('change', onFilterChange);
  if (els.minIntelligence) els.minIntelligence.addEventListener('input', onFilterChangeDebounced);
  if (els.subscriptionOnly) els.subscriptionOnly.addEventListener('change', onFilterChange);
  if (els.hideBatch) els.hideBatch.addEventListener('change', onFilterChange);
  if (els.cacheOnly) els.cacheOnly.addEventListener('change', onFilterChange);
  if (els.maxBlended) els.maxBlended.addEventListener('input', onFilterChangeDebounced);
  if (els.minToks) els.minToks.addEventListener('input', onFilterChangeDebounced);
  if (els.hqFilter) els.hqFilter.addEventListener('change', onFilterChange);
  els.popularChips?.addEventListener('click', (e) => {
    const chip = e.target.closest('.popular-chip');
    if (!chip) return;
    const model = chip.dataset.model || '';
    els.modelSearch.value = model;
    state.showAllRows = false;
    computeAndRender();
  });
  els.groupBy.addEventListener('change', onFilterChange);
  els.showOrg?.addEventListener('change', () => {
    document.getElementById('resultsTable').classList.toggle('hide-org', !els.showOrg.checked);
    computeAndRender();
  });

  els.resultsBody.addEventListener('click', (e) => {
    // Compare checkbox — handled by change event, ignore here.
    if (e.target.closest('.compare-check')) return;
    // "Show all N models" — lift the flat-table row cap and re-render.
    if (e.target.closest('#showAllRows')) {
      state.showAllRows = true;
      computeAndRender();
      return;
    }
    // Group header toggle (collapse/expand child rows).
    const header = e.target.closest('.group-header');
    if (header) {
      header.classList.toggle('collapsed');
      const group = header.dataset.group;
      const collapsed = header.classList.contains('collapsed');
      els.resultsBody.querySelectorAll(`tr[data-group="${CSS.escape(group)}"]:not(.group-header)`).forEach((row) => {
        row.style.display = collapsed ? 'none' : '';
      });
      return;
    }
    // Detail card open (any other click on a body row).
    const tr = e.target.closest('tr[data-idx]');
    if (tr) {
      const idx = Number(tr.dataset.idx);
      if (Number.isInteger(idx)) showDetailModal(idx);
    }
  });

  // Keyboard: Enter/Space on a focused data row opens its detail modal.
  els.resultsBody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.compare-check')) return; // let checkbox toggle itself
    const tr = e.target.closest('tr[data-idx]');
    if (tr) {
      const idx = Number(tr.dataset.idx);
      if (Number.isInteger(idx)) { e.preventDefault(); showDetailModal(idx); }
    }
  });

  const debouncedRender = debounce(() => computeAndRender());
  for (const id of ['totalTokens', 'inputPct', 'cacheReadPct', 'outputPct', 'cacheWriteTokens', 'amortizeN']) {
    els[id].addEventListener('input', debouncedRender);
  }

  document.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  // Sortable column headers (mouse + keyboard).
  document.querySelectorAll('th.sortable').forEach((th) => {
      const sort = () => {
        // Skip if this click immediately follows a column drag (the drag's
        // pointerdown set __colDragSuppress; the click fires right after).
        if (window.__colDragSuppress && Date.now() - window.__colDragSuppress < 300) return;
        const col = th.dataset.sort;
        if (state.sortBy === col) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortBy = col;
          state.sortDir = 'asc';
        }
        computeAndRender();
      };
    th.setAttribute('tabindex', '0');
    th.setAttribute('role', 'button');
    th.addEventListener('click', sort);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); }
    });
  });

  // Mobile sort dropdown
  els.mobileSort.addEventListener('change', () => {
    const [col, dir] = els.mobileSort.value.split(':');
    state.sortBy = col;
    state.sortDir = dir;
    computeAndRender();
  });

  // Export current results to CSV
  els.exportCsvBtn?.addEventListener('click', exportCsv);

  // Comparison checkboxes (event delegation on tbody)
  els.resultsBody.addEventListener('change', (e) => {
    if (!e.target.classList.contains('compare-check')) return;
    const idx = parseInt(e.target.dataset.idx, 10);
    const model = state.currentRows?.[idx]?.model;
    if (model) toggleCompare(model);
  });
  els.compareBtn.addEventListener('click', showCompareModal);
  els.compareClose.addEventListener('click', closeCompareModal);
  els.compareClear.addEventListener('click', clearCompare);
  els.compareModal.addEventListener('click', (e) => {
    if (e.target === els.compareModal) closeCompareModal();
  });

  els.detailClose.addEventListener('click', closeDetailModal);
  els.detailModal.addEventListener('click', (e) => {
    if (e.target === els.detailModal) closeDetailModal();
  });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (els.detailModal.style.display !== 'none') closeDetailModal();
      if (els.compareModal.style.display !== 'none') closeCompareModal();
      // Close the column popover too (additive — no conflict with the modals).
      const colPop = document.getElementById('colPopover');
      if (colPop && !colPop.hidden) toggleColPopover(false);
    });

  window.addEventListener('hashchange', () => {
    deserializeState(location.hash.slice(1));
    computeAndRender();
  });

  // ── Performance data auto-refresh ──
  // Re-fetch performance.json every 2h (while tab is visible) and on tab resume.
  // refreshPerfData has an in-flight guard + 60s cooldown to prevent overlap.
  const PERF_REFRESH_MS = 2 * 60 * 60 * 1000; // 2 hours
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshPerfData().then((changed) => { if (changed) computeAndRender(); });
  }, PERF_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshPerfData().then((changed) => { if (changed) computeAndRender(); });
    });

    // ── Column customization (drag-reorder + hide) ──
    initColumnDrag();
    const colConfigBtn = document.getElementById('colConfigBtn');
    const colPopover = document.getElementById('colPopover');
    if (colConfigBtn) {
      colConfigBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleColPopover();
      });
    }
    // Close popover on outside click
    document.addEventListener('click', (e) => {
      if (colPopover && !colPopover.hidden && !e.target.closest('.col-config')) {
        toggleColPopover(false);
      }
    });
    // Per-column hide toggles (event delegation)
    const colPopoverList = document.getElementById('colPopoverList');
    if (colPopoverList) {
      colPopoverList.addEventListener('change', (e) => {
        if (!e.target.classList.contains('col-toggle')) return;
        const col = e.target.dataset.col;
        const hidden = effectiveColHidden();
        if (e.target.checked) hidden.delete(col);
        else hidden.add(col);
        state.colHidden = hidden;
        applyColumnLayout();
        updateHash();
      });
    }
    const colResetBtn = document.getElementById('colResetBtn');
    if (colResetBtn) colResetBtn.addEventListener('click', resetColumns);
  }

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  for (const [k, v] of Object.entries(p)) {
    if (els[k]) els[k].value = v;
  }
  computeAndRender();
}


// Comparison UI (compare-tray, compare-modal)
function toggleCompare(model) {
  const idx = state.compareSelection.findIndex(m => m.id === model.id && m.provider === model.provider);
  if (idx >= 0) {
    state.compareSelection.splice(idx, 1);
  } else {
    if (state.compareSelection.length >= 6) return; // max 6
    state.compareSelection.push(model);
  }
  updateCompareTray();
  computeAndRender();
}

function updateCompareTray() {
  const n = state.compareSelection.length;
  els.compareTray.style.display = n > 0 ? '' : 'none';
  els.compareCount.textContent = `${n} selected`;
  els.compareBtn.disabled = n < 2;
}

function closeDetailModal() {
  els.detailModal.style.display = 'none';
}

function copyToClipboard(text, btn) {
  if (!navigator.clipboard) {
    btn.textContent = '✗';
    setTimeout(() => { btn.textContent = '📋'; }, 1200);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '📋'; }, 1200); },
    () => { btn.textContent = '✗'; setTimeout(() => { btn.textContent = '📋'; }, 1200); }
  );
}

function showDetailModal(idx) {
  const r = state.currentRows?.[idx]?.model;
  if (!r) return;
  const md = r.modelsdev;
  const mdModel = r.modelsdev_model;
  const parts = [];

  // Header
  parts.push(`<div class="detail-subtitle">${esc(orgDisplay(r.org))} · via ${esc(providerName(r.provider, r.provider_display))}` +
    (md && md.confidence === 'medium' ? ' <span class="approx-badge" title="Matched by fuzzy logic against models.dev — verify before configuring">⚠ approx</span>' : '') +
    `</div>`);

  // Section: Connect (only if provider-specific enrichment exists)
  if (md) {
    parts.push('<div class="detail-section"><div class="detail-section-title">Connect</div>');
    const baseUrl = md.base_url;
    parts.push(`<div class="detail-field"><span class="detail-field-label">Base URL</span>` +
      `<span class="detail-field-value">${baseUrl ? esc(baseUrl) + ' <button class="copy-btn" data-copy="' + esc(baseUrl) + '">📋</button>' : '<span class="detail-no-url">Provider uses its own SDK package — no generic base URL</span>'}</span></div>`);
    parts.push(`<div class="detail-field"><span class="detail-field-label">Model ID</span>` +
      `<span class="detail-field-value">${esc(md.model_id || '—')} <button class="copy-btn" data-copy="${esc(md.model_id || '')}">📋</button></span></div>`);
    if (md.doc_url) {
      parts.push(`<div class="detail-field"><span class="detail-field-label">Docs</span>` +
        `<span class="detail-field-value"><a href="${esc(md.doc_url)}">${esc(md.doc_url)} ↗</a></span></div>`);
    }
    parts.push('</div>');
  } else {
    parts.push('<div class="detail-section"><div class="detail-no-enrich">Direct configuration not available for this provider.</div></div>');
  }

  // Section: Pricing
  const p = r.pricing || {};
  parts.push('<div class="detail-section"><div class="detail-section-title">Pricing ($/M tokens)</div>');
  parts.push('<div class="detail-pricing-grid">');
  parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Input</div><div class="detail-pricing-cell-value">${p.input != null ? fmtPrice(p.input) : '—'}</div></div>`);
  parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Output</div><div class="detail-pricing-cell-value">${p.output != null ? fmtPrice(p.output) : '—'}</div></div>`);
  parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Cache read</div><div class="detail-pricing-cell-value">${p.cache_read != null ? fmtPrice(p.cache_read) : '—'}</div></div>`);
  parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Cache write</div><div class="detail-pricing-cell-value">${p.cache_write != null ? fmtPrice(p.cache_write) : '—'}</div></div>`);
  parts.push('</div></div>');

  // Section: Capabilities + About (from provider-specific OR model-level fallback)
  // Prefer md (provider-specific); fall back to md_model (model-level from any provider).
  const meta = md || mdModel;
  if (meta && (meta.capabilities || meta.description || meta.modalities || meta.release_date)) {
    const usingFallback = !md && !!mdModel;

    // Section: Capabilities
    if (meta.capabilities || meta.modalities) {
      parts.push('<div class="detail-section"><div class="detail-section-title">Capabilities</div>');
      if (meta.capabilities) {
        const caps = meta.capabilities;
        const trueCaps = [];
        if (caps.reasoning) trueCaps.push('Reasoning');
        if (caps.tool_call) trueCaps.push('Tool call');
        if (caps.structured_output) trueCaps.push('Structured output');
        if (caps.attachment) trueCaps.push('Attachment');
        if (caps.temperature) trueCaps.push('Temperature');
        if (trueCaps.length > 0) {
          parts.push('<div class="detail-capabilities">' + trueCaps.map((c) => `<span class="detail-capability">✓ ${esc(c)}</span>`).join('') + '</div>');
        }
      }
      if (meta.modalities) {
        const inp = (meta.modalities.input || []).join(', ');
        const outp = (meta.modalities.output || []).join(', ');
        parts.push(`<div class="detail-modalality-line">Input: ${esc(inp)} → Output: ${esc(outp)}</div>`);
      }
      parts.push('</div>');
    }


    // Section: About
    parts.push('<div class="detail-section"><div class="detail-section-title">About</div>');
    if (meta.description) {
      const desc = meta.description.length > 200 ? meta.description.slice(0, 200) + '…' : meta.description;
      parts.push(`<div class="detail-description" title="${esc(meta.description)}">${esc(desc)}</div>`);
    }
    const provBits = [];
    if (meta.release_date) provBits.push('Released ' + esc(meta.release_date));
    if (meta.knowledge_cutoff) provBits.push('Knowledge cutoff ' + esc(meta.knowledge_cutoff));
    if (meta.open_weights === true) provBits.push('Open weights ✓');
    if (provBits.length > 0) parts.push(`<div class="detail-provenance">${provBits.join(' · ')}</div>`);
    if (meta.doc_url) {
      parts.push(`<div class="detail-provenance"><a href="${esc(meta.doc_url)}">Provider docs ↗</a></div>`);
    }
    if (usingFallback) {
      parts.push('<div class="detail-disclaimer">⚠ Model details sourced from models.dev (different provider). Configuration above is not available for this provider — verify on the provider\'s site.</div>');
    }
    parts.push('</div>');
  }

  // Section: Quality (only if benchmark data exists)
  // Outside the meta block — benchmark data is independent of modelsdev enrichment.
  if (r.benchmarks) {
    const b = r.benchmarks;
    const hasAA = b.intelligence_index !== null && b.intelligence_index !== undefined;
    const hasArena = !!b.design_arena_best;
    if (hasAA || hasArena) {
      parts.push('<div class="detail-section"><div class="detail-section-title">Quality</div>');
      if (hasAA) {
        parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Intelligence Index</span><span class="detail-quality-value">' + esc(b.intelligence_index) + '</span></div>');
        parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Coding Index</span><span class="detail-quality-value">' + esc(b.coding_index) + '</span></div>');
        parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Agentic Index</span><span class="detail-quality-value">' + esc(b.agentic_index) + '</span></div>');
      }
      if (hasArena) {
        const a = b.design_arena_best;
        const arenaStr = a.elo + ' (' + esc(a.category) + ', rank ' + a.rank + ', ' + a.win_rate + '% win rate)';
        parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Design Arena Elo</span><span class="detail-quality-value">' + arenaStr + '</span></div>');
      }
      parts.push('<div class="detail-quality-source">Source: Artificial Analysis via OpenRouter</div>');
      parts.push('</div>');
    }
  }
  // Section: Energy (Neuralwatt energy data)
  // Independent data source — only rendered when model has energy metadata.
  const energy = r.energy;
  if (energy && energy.bands) {
    parts.push('<div class="detail-section"><div class="detail-section-title">Energy (Neuralwatt)</div>');
    // Bands table
    const BAND_ORDER = ['0\u2013256', '256\u20131k', '1k\u20134k', '4k\u201316k', '16k\u201364k', '64k\u2013256k', '256k\u20131M'];
    const rate = energy.rate_usd_per_kwh || 0;
    let tbl = '<table class="detail-bands-table"><thead><tr><th>Band</th><th>Avg energy</th><th>$/request</th><th>Share</th></tr></thead><tbody>';
    for (const band of BAND_ORDER) {
      const b = energy.bands[band];
      if (!b || b.wh == null) continue;
      const cost = (b.wh / 1000) * rate;
      tbl += '<tr><td>' + esc(band) + '</td>';
      tbl += '<td>' + b.wh.toLocaleString() + ' Wh</td>';
      tbl += '<td>$' + cost.toFixed(4) + '</td>';
      tbl += '<td>' + (b.share != null ? b.share.toFixed(1) + '%' : '\u2014') + '</td></tr>';
    }
    tbl += '</tbody></table>';
    parts.push(tbl);
    // $/Mtok energy (from estimator wh_per_mtok) — the headline comparison figure
    if (energy.wh_per_mtok != null) {
      const usdPerMtok = (energy.wh_per_mtok * rate / 1000).toFixed(4);
      const whStr = energy.wh_per_mtok < 1 ? energy.wh_per_mtok.toFixed(3) : energy.wh_per_mtok.toFixed(1);
      parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Energy cost (est.)</span><span class="detail-quality-value">' + whStr + ' Wh/Mtok \u2248 $' + usdPerMtok + '/Mtok at $' + rate + '/kWh</span></div>');
      parts.push('<div class="detail-quality-source">Blended rate at model\u2019s measured traffic mix. For comparison vs token pricing only \u2014 actual cost varies with workload.</div>');
      if (energy.estimator_source === 'stale-cache') {
        parts.push('<div class="detail-quality-source">\u26A0 Estimator data from stale cache (fetched ' + esc(energy.estimator_fetched_at || 'unknown') + ')</div>');
      } else if (energy.estimator_fetched_at) {
        parts.push('<div class="detail-quality-source">Estimator updated: ' + esc(energy.estimator_fetched_at) + '</div>');
      }
    }
    // Below-table metadata
    if (energy.avg_cache_hit_pct != null) {
      parts.push('<div class="detail-quality-row"><span class="detail-quality-label">Avg cache-hit rate</span><span class="detail-quality-value">' + energy.avg_cache_hit_pct + '%</span></div>');
    }
    if (energy.trend_48h_vs_7d_pct != null) {
      const pct = energy.trend_48h_vs_7d_pct;
      const arrow = pct < 0 ? '\u25BC' : pct > 0 ? '\u25B2' : '\u25CF';
      const word = pct < 0 ? 'cheaper' : pct > 0 ? 'pricier' : 'same';
      parts.push('<div class="detail-quality-row"><span class="detail-quality-label">48h trend</span><span class="detail-quality-value">' + arrow + ' ' + Math.abs(pct).toFixed(1) + '% ' + word + ' than 7-day avg</span></div>');
    }
    parts.push('<div class="detail-quality-source">Measured from live traffic (7-day avg, workload-dependent)</div>');
    if (energy.updated_ago) {
      parts.push('<div class="detail-quality-source">Updated ' + esc(energy.updated_ago) + '</div>');
    }
    if (energy.source) {
      parts.push('<div class="detail-quality-source"><a href="' + esc(energy.source) + '">Energy status \u2197</a></div>');
    }
    parts.push('</div>');
  }

  // Section: Performance (latency + throughput from performance.json)
  // Outside the meta block — perf data is independent of modelsdev enrichment.
  if (state.perfData) {
    const perfKey = canonicalModelId(r.id) + '|' + r.provider;
    const perf = state.perfData[perfKey];
    if (perf && (perf.latency || perf.throughput)) {
      parts.push('<div class="detail-section"><div class="detail-section-title">Performance</div>');
      if (perf.latency) {
        const l = perf.latency;
        parts.push('<div class="detail-pricing-grid">');
        parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Latency p50</div><div class="detail-pricing-cell-value">${l.p50 != null ? Math.round(l.p50 * 100) / 100 : '—'} ms</div></div>`);
        parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Latency p90</div><div class="detail-pricing-cell-value">${l.p90 != null ? Math.round(l.p90 * 100) / 100 : '—'} ms</div></div>`);
        parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Latency p99</div><div class="detail-pricing-cell-value">${l.p99 != null ? Math.round(l.p99 * 100) / 100 : '—'} ms</div></div>`);
        parts.push('</div>');
      }
      if (perf.throughput) {
        const t = perf.throughput;
        parts.push('<div class="detail-pricing-grid">');
        parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Throughput p50</div><div class="detail-pricing-cell-value">${t.p50 != null ? Math.round(t.p50 * 100) / 100 : '—'} tps</div></div>`);
        parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Throughput p90</div><div class="detail-pricing-cell-value">${t.p90 != null ? Math.round(t.p90 * 100) / 100 : '—'} tps</div></div>`);
        parts.push(`<div class="detail-pricing-cell"><div class="detail-pricing-cell-label">Throughput p99</div><div class="detail-pricing-cell-value">${t.p99 != null ? Math.round(t.p99 * 100) / 100 : '—'} tps</div></div>`);
        parts.push('</div>');
      }
      parts.push('<div class="detail-quality-source">Source: OpenRouter endpoint metrics (30m window)</div>');
      parts.push('</div>');
    }
  }

  // Footer actions
  parts.push('<div class="detail-actions">');
  parts.push(`<button type="button" id="detailAddCompare">Add to compare</button>`);
  parts.push(`<button type="button" id="detailDownloadCard" class="detail-download-btn">Download cost card</button>`);
  parts.push(`<button type="button" id="detailShareCard" class="detail-share-btn">Share card</button>`);
  parts.push(`<p class="detail-card-status" id="cardStatus" role="status" aria-live="polite"></p>`);
  parts.push('</div>');

  els.detailTitle.textContent = r.name || r.id;
  els.detailBody.innerHTML = parts.join('');
  els.detailModal.style.display = '';

  // Wire footer actions + copy buttons
  const addBtn = document.getElementById('detailAddCompare');
  if (addBtn) addBtn.addEventListener('click', () => { closeDetailModal(); toggleCompare(r); });
  const dlBtn = document.getElementById('detailDownloadCard');
  if (dlBtn) dlBtn.addEventListener('click', () => downloadCostCard(r, dlBtn));
  const shareBtn = document.getElementById('detailShareCard');
  if (shareBtn) shareBtn.addEventListener('click', () => shareCostCard(r, shareBtn));
  for (const btn of els.detailBody.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy, btn));
  }
}

// ── Cost-card PNG export (single offering) ────────────────────────────────────
//
// Renders an offscreen, compare-card-structured snapshot of ONE offering against
// the live calculator assumptions, then hands it to the shared domToPngBlob
// renderer + downloadBlob. The card reuses the same compare-* class names so the
// shared renderer paints it identically to the compare-image output. No cost
// math is duplicated: getTokens / costFor / affordabilityFor + the same
// modeMultiplier as computeAndRender derive the outcome.

/** Deterministic, sanitized filename for a single-offering cost card. */
function costCardFilename(r) {
  const safe = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'model';
  const prov = safe(r.provider);
  const mod = safe((r.name && r.name !== r.id ? r.name : r.id).split('/').pop());
  const stamp = new Date().toISOString().slice(0, 10);
  return `tokenwatch-cost-${prov}-${mod}-${stamp}.png`;
}

/** Build an offscreen .compare-modal-content card populated from `r` and the
 *  current calculator state. Returned element is NOT yet attached (caller
 *  appends it so domToPngBlob can measure live layout). */
function buildCostCard(r) {
  const tokens = getTokens();
  const monthly = state.costMode === 'monthly';
  const budgetMode = state.computeBy === 'budget';
  const modeMultiplier = monthly ? 30 : 1;            // mirrors computeAndRender
  const budgetVal = budgetMode ? Math.max(0, parseFloat(els.budgetInput?.value) || 0) : 0;
  const perSessionBudget = budgetMode ? budgetVal / modeMultiplier : 0;
  const pricing = r.pricing || {};

  // Outcome — exact same derivation as computeAndRender (no duplicated math).
  const rawOutcome = budgetMode
    ? affordabilityFor(pricing, tokens, perSessionBudget)
    : costFor(pricing, tokens);
  const outcome = rawOutcome == null ? null : rawOutcome * modeMultiplier;
  const outcomeStr = budgetMode ? fmtAffordability(outcome) : fmtCost(outcome);
  const outcomeLabel = (els.costColumnHeader?.textContent || (budgetMode ? 'Affordable tokens' : 'Total cost')).trim();

  // Basis line — kept to a single readable line; the full mix + cache-write
  // assumptions live in table rows so nothing is truncated by the renderer.
  let basis;
  if (budgetMode) {
    basis = monthly ? `$${budgetVal.toLocaleString()} monthly budget` : `$${budgetVal.toLocaleString()} budget per session`;
  } else {
    const totalM = tokens.total / 1e6;
    basis = monthly
      ? `${totalM.toLocaleString()}M tokens/day (\u00d730 monthly)`
      : `${totalM.toLocaleString()}M tokens per session`;
  }

  const modelName = r.name && r.name !== r.id ? r.name : r.id;
  const mixVal = `In ${tokens.inputPct}% \u00b7 Cache ${tokens.cacheReadPct}% \u00b7 Out ${tokens.outputPct}%`;

  // Blended $/M, ZDR, Speed — same sources as the compare modal; em-dash when
  // no source data exists. Never inferred (matches compare-table semantics).
  const blended = blendedCostFor(pricing, tokens);
  const blendedVal = blended != null ? fmtPrice(blended) : '\u2014';
  const zdrVal = r.zdr === true ? 'Yes' : r.zdr === false ? 'No' : '\u2014';
  const perf = getPerfData({ model: r });
  const tps = perf && perf.throughput ? perf.throughput.p50 : null;
  const speedVal = tps == null ? '\u2014' : `${Math.round(tps * 10) / 10} tps`;

  // Two-column metric/value table. All four published rates are always shown.
  const rows = [
    ['Provider', esc(providerName(r.provider, r.provider_display)), false, false],
    ['Input $/M', fmtPrice(pricing.input), true, false],
    ['Cache read $/M', fmtPrice(pricing.cache_read), true, false],
    ['Output $/M', fmtPrice(pricing.output), true, false],
    ['Cache write $/M', fmtPrice(pricing.cache_write), true, false],
    ['Blended $/M', blendedVal, true, false],
    ['Token mix', esc(mixVal), false, false],
  ];
  if (tokens.cacheWrite > 0) {
    rows.push(['Cache-write tokens', `${(tokens.cacheWrite / 1e6).toLocaleString()}M \u00f7 ${tokens.amortizeN}`, true, false]);
  }
  rows.push(['ZDR', zdrVal, false, false]);
  rows.push(['Speed', speedVal, true, false]);
  // Headline outcome \u2014 accent (compare-cheapest) so it reads as the result.
  rows.push([esc(outcomeLabel), outcomeStr, true, true]);
  let body = '';
  for (const [label, val, isNum, isBest] of rows) {
    const cls = ['compare-value', isNum ? 'num' : '', isBest ? 'compare-cheapest' : ''].filter(Boolean).join(' ');
    body += `<tr><td class="compare-label">${label}</td><td class="${cls}">${val}</td></tr>`;
  }

  const card = document.createElement('div');
  card.className = 'compare-modal-content cost-card-export';
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML =
    `<div class="compare-modal-header">` +
      `<div class="compare-brand">` +
        `<span class="compare-brand-link">\uD83D\uDCB0 TokenWatch</span>` +
        `<h2>Cost card</h2>` +
      `</div>` +
    `</div>` +
    `<div class="compare-snapshot"><span class="snapshot-label">Basis:</span> ${esc(basis)}</div>` +
    `<table class="compare-table cost-card-table"><thead><tr><th>Metric</th><th>${esc(modelName)}</th></tr></thead><tbody>${body}</tbody></table>`;
  return card;
}

/** Generate + download a single-offering cost-card PNG. Disables the trigger
 *  button while rendering, restores it afterward, and surfaces failures via an
 *  aria-live status region — never leaving a hidden card behind. */
async function downloadCostCard(r, btn) {
  const status = document.getElementById('cardStatus');
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Rendering\u2026';
  let card = null;
  try {
    card = buildCostCard(r);
    document.body.appendChild(card);            // must be in DOM for layout metrics
    card.offsetWidth;                            // force reflow so measurements are live
    const blob = await TW.domToPngBlob(card);
    if (!blob || blob.size === 0) throw new Error('renderer produced an empty image');
    TW.downloadBlob(blob, costCardFilename(r));
    if (status) { status.textContent = 'Cost card downloaded.'; status.className = 'detail-card-status ok'; }
    btn.textContent = 'Downloaded \u2713';
  } catch (err) {
    console.warn('Cost card export failed:', err);
    btn.textContent = 'Failed \u2014 retry';
    if (status) { status.textContent = '\u26A0 Couldn\u2019t generate the cost card image. Please try again.'; status.className = 'detail-card-status error'; }
  } finally {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = prev;
      if (status) setTimeout(() => { status.textContent = ''; status.className = 'detail-card-status'; }, 2600);
    }, 1500);
  }
}

/** Create a direct image URL containing the exact single-offering snapshot. */
async function shareCostCard(r, btn) {
  const status = document.getElementById('cardStatus');
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sharing\u2026';
  let card = null;
  try {
    card = buildCostCard(r);
    document.body.appendChild(card);
    const { result } = await TW.shareElementAsUrl(card, 'cost');
    if (result === 'cancelled') {
      btn.textContent = 'Cancelled';
      if (status) { status.textContent = ''; status.className = 'detail-card-status'; }
    } else {
      btn.textContent = result === 'shared' ? 'Shared \u2713' : 'URL copied \u2713';
      if (status) {
        status.textContent = result === 'shared' ? 'Cost-card URL shared.' : 'Cost-card image URL copied.';
        status.className = 'detail-card-status ok';
      }
    }
  } catch (err) {
    console.warn('Cost-card URL sharing failed:', err);
    btn.textContent = 'Failed \u2014 retry';
    if (status) { status.textContent = '\u26A0 Couldn\u2019t create the share URL. Please try again.'; status.className = 'detail-card-status error'; }
  } finally {
    if (card && card.parentNode) card.parentNode.removeChild(card);
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = prev;
      if (status) setTimeout(() => { status.textContent = ''; status.className = 'detail-card-status'; }, 2600);
    }, 1500);
  }
}

function showCompareModal() {
  if (state.compareSelection.length < 2) return;
  const tokens = getTokens();
  const modeMultiplier = state.costMode === 'monthly' ? 30 : 1;
  const budgetMode = state.computeBy === 'budget';
  const budgetVal = budgetMode ? Math.max(0, parseFloat(els.budgetInput?.value) || 0) : 0;
  const perSessionBudget = budgetMode ? budgetVal / modeMultiplier : 0;
  const models = state.compareSelection;

  const headlineGet = m => budgetMode
    ? affordabilityFor(m.pricing, tokens, perSessionBudget) * modeMultiplier
    : costFor(m.pricing, tokens) * modeMultiplier;
  const headlineFmt = v => budgetMode ? fmtAffordability(v) : fmtCost(v);

  const rows = [
    { label: 'Org', getValue: m => esc(orgDisplay(m.org)) },
    { label: 'Provider', getValue: m => esc(providerName(m.provider, m.provider_display)) },
    { label: 'Model', getValue: m => esc(m.name && m.name !== m.id ? m.name : m.id) },
    { label: 'Input $/M', getValue: m => fmtPrice(m.pricing.input), getRaw: m => m.pricing.input, isCost: true },
    { label: 'Output $/M', getValue: m => fmtPrice(m.pricing.output), getRaw: m => m.pricing.output, isCost: true },
    { label: 'Cache Read $/M', getValue: m => fmtPrice(m.pricing.cache_read), getRaw: m => m.pricing.cache_read, isCost: true },
    { label: 'ZDR', getValue: m => (m.zdr ? '<span class="zdr-badge">ZDR</span>' : '—') + (m.subscription ? ' <span class="subscription-badge">Sub</span>' : '') },
    { label: 'Cache Write $/M', getValue: m => fmtPrice(m.pricing.cache_write), getRaw: m => m.pricing.cache_write, isCost: true },
    { label: 'Context', getValue: m => fmtContext(m.context_length) },
    { label: 'Max Output Tokens', getValue: m => m.max_completion_tokens ? m.max_completion_tokens.toLocaleString() : '<span class="missing">—</span>' },
    { label: 'Uptime (30m)', getValue: m => m.uptime_30m != null ? `${m.uptime_30m.toFixed(2)}%` : '<span class="missing">—</span>' },
    { label: 'Discount', getValue: m => m.discount > 0 ? `<span class="promo-badge">${(m.discount * 100).toFixed(0)}% off</span>` : '—' },
    { label: 'Speed', getValue: m => {
        const perf = getPerfData({ model: m });
        const tps = perf?.throughput?.p50;
        if (tps == null) return '<span class="missing">—</span>';
        return `${Math.round(tps * 10) / 10} tps`;
      }, getRaw: m => getPerfData({ model: m })?.throughput?.p50 ?? null, bestHigh: true },
    { label: 'TTFT', getValue: m => {
        const ms = getPerfData({ model: m })?.latency?.p50;
        if (ms == null) return '<span class="missing">—</span>';
        return `${fmtTtftSeconds(ms)} s`;
      }, getRaw: m => getPerfData({ model: m })?.latency?.p50 ?? null, isCost: true },
    { label: 'Blended $/M', getValue: m => {
        const b = blendedCostFor(m.pricing, tokens);
        return b != null ? fmtPrice(b) : '<span class="missing">—</span>';
      }, getRaw: m => blendedCostFor(m.pricing, tokens), isCost: true },
    { label: els.costColumnHeader?.textContent || 'Total Cost', getValue: m => headlineFmt(headlineGet(m)), getRaw: headlineGet, isCost: true, isBudget: budgetMode },
  ];

  // Snapshot: what's being compared (so users don't revert to the page to check basis)
  const monthly = state.costMode === 'monthly';
  const mixStr = `Input ${tokens.inputPct}% · Cached ${tokens.cacheReadPct}% · Output ${tokens.outputPct}%`;
  let snapshot;
  if (budgetMode) {
    const period = monthly ? 'monthly' : 'per session';
    const budgetLabel = monthly ? `Monthly budget $${budgetVal.toLocaleString()}` : `Budget $${budgetVal.toLocaleString()}`;
    snapshot = `<strong>${budgetLabel}</strong> (${period}) · mix: ${mixStr}`;
  } else {
    const totalM = (tokens.total / 1e6);
    const totalLabel = monthly ? `Daily ${totalM.toLocaleString()}M tokens` : `${totalM.toLocaleString()}M tokens`;
    const cw = tokens.cacheWrite > 0 ? ` · cache-write ${(tokens.cacheWrite/1e6).toLocaleString()}M ÷ ${tokens.amortizeN}` : '';
    const period = monthly ? ' (×30 monthly)' : '';
    snapshot = `<strong>${totalLabel}</strong>${period} · mix: ${mixStr}${cw}`;
  }
  const snapshotHtml = `<div class="compare-snapshot"><span class="snapshot-label">Basis:</span> ${snapshot}</div>`;
  const scrollHintHtml = '<p class="compare-scroll-hint" aria-hidden="true">Swipe horizontally to see every model \u2192</p>';
  const tableWidth = 168 + models.length * 160;

  let html = snapshotHtml + scrollHintHtml
    + `<div class="compare-table-scroll" role="region" aria-label="Scrollable model comparison" tabindex="0"><table class="compare-table comparison-grid" style="width:${tableWidth}px"><thead><tr><th>Metric</th>`;
  for (const m of models) {
    const name = m.name && m.name !== m.id ? m.name : m.id;
    html += `<th title="${esc(name)}">${esc(name)}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const row of rows) {
    html += `<tr><td class="compare-label">${row.label}</td>`;
    if ((row.isCost || row.bestHigh) && row.getRaw) {
      const values = models.map(m => row.getRaw(m));
      const nonNull = values.filter(v => v !== null && v !== undefined && (isFinite(v) || !row.isBudget));
      const best = nonNull.length > 0
        ? ((row.isBudget || row.bestHigh) ? Math.max(...nonNull) : Math.min(...nonNull))
        : null;
      for (const m of models) {
        const v = row.getRaw(m);
        const isBest = best !== null && v !== null && v !== undefined && v === best;
        html += `<td class="compare-value num${isBest ? ' compare-cheapest' : ''}">${row.getValue(m)}</td>`;
      }
    } else {
      for (const m of models) {
        html += `<td class="compare-value">${row.getValue(m)}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  els.compareBody.innerHTML = html;
  els.compareModal.style.display = '';
}

function closeCompareModal() {
  els.compareModal.style.display = 'none';
}

function clearCompare() {
  state.compareSelection = [];
  updateCompareTray();
  computeAndRender();
}


// ── Token computation ──────────────────────────────────────────────────────────

function getTokens() {
  const total = Math.max(0, parseFloat(els.totalTokens.value) || 0) * 1e6;
  const inputPct = Math.max(0, parseFloat(els.inputPct.value) || 0);
  const cacheReadPct = Math.max(0, parseFloat(els.cacheReadPct.value) || 0);
  const outputPct = Math.max(0, parseFloat(els.outputPct.value) || 0);
  const cacheWriteTokens = Math.max(0, parseFloat(document.getElementById('cacheWriteTokens').value) || 0) * 1e6;
  const amortizeN = Math.max(1, parseInt(document.getElementById('amortizeN').value, 10) || 100);
  return {
    total, inputPct, cacheReadPct, outputPct, sum: inputPct + cacheReadPct + outputPct,
    input: total * inputPct / 100,
    cacheRead: total * cacheReadPct / 100,
    cacheWrite: cacheWriteTokens,
    amortizeN,
    output: total * outputPct / 100,
  };
}

/** cost = (tokens × $/M) / 1e6  — prices are $/M tokens
 *
 *  Null-price semantics: a model is only filtered out (returns null) if it
 *  lacks an input or output price AND the user requested those token types.
 *  Cache fields are NEVER disqualifiers:
 *  - cache_read null → cached tokens charged at the INPUT rate (no cache discount)
 *  - cache_write null → cache-write component is $0 (provider doesn't charge for it)
 *  This ensures models without published cache pricing still appear in results. */
function costBreakdown(pricing, tokens) {
  const c = (price, tok) => (price != null ? (price * tok) / 1e6 : null);
  const input = c(pricing.input, tokens.input);
  const output = c(pricing.output, tokens.output);
  const cacheRead = c(pricing.cache_read != null ? pricing.cache_read : pricing.input, tokens.cacheRead);
  const cacheWrite = tokens.cacheWrite > 0 && pricing.cache_write != null
    ? (pricing.cache_write * (tokens.cacheWrite / (tokens.amortizeN || 1))) / 1e6
    : 0;
  const excluded = (tokens.input > 0 && input === null) || (tokens.output > 0 && output === null);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: excluded ? null : (input || 0) + (output || 0) + (cacheRead || 0) + cacheWrite,
    excluded,
  };
}

function costFor(pricing, tokens) {
  return costBreakdown(pricing, tokens).total;
}

/** Blended $/M: the effective per-million-token rate at the current input/cache/output mix.
 *  Deliberately excludes cache_write and monthly multiplier — it's a pure
 *  comparison metric so users can see where models stand per 1M tokens.
 *  Uses the same null-price semantics as costFor (cache_read null → input rate). */
function blendedCostFor(pricing, tokens) {
  const inRate   = pricing.input != null ? pricing.input * tokens.inputPct / 100 : null;
  const outRate  = pricing.output != null ? pricing.output * tokens.outputPct / 100 : null;
  const crPrice  = pricing.cache_read != null ? pricing.cache_read : pricing.input;
  const crRate   = crPrice != null ? crPrice * tokens.cacheReadPct / 100 : null;
  if (tokens.inputPct > 0 && inRate === null) return null;
  if (tokens.outputPct > 0 && outRate === null) return null;
  return (inRate || 0) + (outRate || 0) + (crRate || 0);
}

/** Affordability: given a $ budget and the per-session token breakdown shape,
 *  return how many MILLION tokens the budget buys on this offering.
 *  Inverse of costFor: affordable_M = (budget - cwFixed) / effectiveRate
 *  where effectiveRate = Sum(pct_i/100 × price_i) is $ per 1M total-session tokens,
 *  and cwFixed = pricing.cache_write × cacheWriteTokens / amortizeN / 1e6 is the
 *  per-session fixed cache-write charge. Returns Infinity when the per-M rate is 0
 *  (a free offering), null when the offering can't serve the requested token mix,
 *  and -Infinity (caller filters) when the fixed charge alone exceeds the budget. */
function affordabilityFor(pricing, tokens, budget) {
  // effectiveRate: $/1M total tokens. prices are $/M; pct fractions multiply.
  const rate = (price, pct) => (price != null ? price * pct / 100 : null);
  const inRate   = tokens.inputPct    > 0 ? rate(pricing.input,     tokens.inputPct)    : 0;
  const outRate  = tokens.outputPct   > 0 ? rate(pricing.output,    tokens.outputPct)   : 0;
  // Cache-read null → fall back to input rate (model offers no cache discount)
  const crPrice  = pricing.cache_read != null ? pricing.cache_read : pricing.input;
  const crRate   = tokens.cacheReadPct> 0 ? rate(crPrice, tokens.cacheReadPct): 0;
  if (tokens.inputPct    > 0 && inRate  === null) return null;
  if (tokens.outputPct   > 0 && outRate === null) return null;
  // Cache-write: fixed per-session charge, amortized over N requests.
  // If provider has no cache_write price (null), treat as $0 fixed charge — do
  // NOT filter the model out (same semantics as costFor).
  let cwFixed = 0;
  if (tokens.cacheWrite > 0 && pricing.cache_write != null) {
    cwFixed = (pricing.cache_write * (tokens.cacheWrite / (tokens.amortizeN || 1))) / 1e6;
  }
  const effectiveRate = (inRate || 0) + (outRate || 0) + (crRate || 0);
  if (effectiveRate <= 0) {
    // Free per-token offering. Affordable iff the budget covers the fixed charge.
    return budget >= cwFixed ? Infinity : null;
  }
  if (budget <= cwFixed) return null; // can't even cover cache-write setup
  return (budget - cwFixed) / effectiveRate;
}

/** Format affordable millions-of-tokens for display. Mirrors the token-input
 *  convention: raw millions count with thousands separators, no suffixes.
 *  Header "(M)" indicates the unit — same as totalTokens input field.
 *  Infinity (free offering) → "∞" badge; null → "N/A". */
function fmtAffordability(tokens_M) {
  if (tokens_M === null || tokens_M === undefined) return `<span class="missing">N/A</span>`;
  if (!isFinite(tokens_M)) return `<span class="cost-zero" title="Free offering — budget covers unlimited tokens">∞</span>`;
  if (tokens_M === 0) return `<span class="cost-zero">0</span>`;
  if (tokens_M < 1) return tokens_M.toFixed(1);
  return Math.round(tokens_M).toLocaleString();
}

/** Median of a numeric array. Returns null for empty input. */
/** Benchmark bar — dynamic median/mean/range/free strip over the current result
 *  cohort. Recomputed on every render from state.currentRows, so it reflects
 *  whatever the current search/filter/budget selection is. */
function renderBenchmarkBox(rows) {
  const bar = els.benchmarkBar;
  if (!bar) return;
  if (!rows || rows.length === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const budget = state.computeBy === 'budget';
  const vals = rows.map((r) => r.cost).filter((v) => v != null);
  const finite = vals.filter((v) => isFinite(v));
  const free = budget ? vals.filter((v) => !isFinite(v)).length : vals.filter((v) => v === 0).length;

  const noun = rows.length === 1 ? 'offering' : 'offerings';

  // All-free cohort — avoid NaN median; show a clean summary instead.
  if (!finite.length) {
    bar.innerHTML = `<strong>All ${rows.length} ${noun} free</strong>`;
    return;
  }

  const med = median(finite);
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const min = Math.min(...finite);
  const max = Math.max(...vals); // budget mode: Infinity included → renders "∞"
  const fmt = budget ? fmtAffordability : fmtCost;
  const unit = budget ? ' M tokens' : state.costMode === 'monthly' ? '/month' : '/session';

  let html = `<strong>Median ${fmt(med)}${unit}</strong>` +
    ` <span class="bench-sep">·</span> mean ${fmt(mean)}` +
    ` <span class="bench-sep">·</span> range ${fmt(min)}–${fmt(max)}`;
  if (free > 0) html += ` <span class="bench-sep">·</span> ${free} free`;

  // Blended $/M cohort stats (mix-weighted rate — independent of session size)
  const blended = rows.map((r) => r.blended).filter((v) => v != null && isFinite(v));
  if (blended.length) {
    const bMed = median(blended);
    const bMean = blended.reduce((a, b) => a + b, 0) / blended.length;
    html += ` <span class="bench-sep">·</span> Blended $/M median ${fmtPrice(bMed)} · mean ${fmtPrice(bMean)}`;
  }
  bar.innerHTML = html;
}

/** Filter the catalog the same way computeAndRender does, before cost/affordability exclusion.
 *  WebMCP explain_ranking uses this to report mix-unsupported offerings. */
function matchingOfferings() {
  if (!state.data) return [];
  const provSearch = els.providerSearch.value.trim().toLowerCase();
  const modSearch = els.modelSearch.value.trim().toLowerCase();
  const promoOnly = els.promoOnly.checked;
  const zdrOnly = els.zdrOnly?.checked;
  const subscriptionOnly = els.subscriptionOnly?.checked;
  const hideBatch = els.hideBatch ? els.hideBatch.checked : DEFAULTS.hideBatch;
  const cacheOnly = !!els.cacheOnly?.checked;
  const maxBlended = parseFloat(els.maxBlended?.value);
  const minToks = parseFloat(els.minToks?.value);
  const hq = (els.hqFilter?.value || '').trim();
  const minIntelligence = els.minIntelligence ? (parseInt(els.minIntelligence.value, 10) || 0) : 0;
  return state.data.models.filter((m) => {
    if (provSearch) {
      const provName = providerName(m.provider, m.provider_display).toLowerCase();
      if (!provName.includes(provSearch) && !m.provider.toLowerCase().includes(provSearch)) return false;
    }
    if (modSearch) {
      // Normalize spaces and hyphens to the same separator so "glm 5.2"
      // matches "glm-5.2" — users naturally type spaces, IDs use hyphens.
      const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, ' ');
      const q = norm(modSearch);
      const canon = canonicalModelId(m.id);
      const modDisplay = norm(state.modelDisplayName[canon] || canon);
      const rawId = norm(m.id.split('/').slice(-1)[0]);
      if (!modDisplay.includes(q) && !rawId.includes(q)) return false;
    }
    if (zdrOnly && !m.zdr) return false;
    if (subscriptionOnly && !m.subscription) return false;
    if (promoOnly && !(m.discount > 0)) return false;
    if (minIntelligence && !(m.benchmarks?.intelligence_index != null && m.benchmarks.intelligence_index >= minIntelligence)) return false;
    if (hideBatch && isBatchOrFreeId(m.id)) return false;
    if (cacheOnly && m.pricing?.cache_read == null) return false;
    if (Number.isFinite(maxBlended) && maxBlended > 0) {
      const blended = blendedCostFor(m.pricing, getTokens());
      if (blended == null || blended > maxBlended) return false;
    }
    if (Number.isFinite(minToks) && minToks > 0) {
      const tps = getPerfData({ model: m })?.throughput?.p50;
      if (tps == null || tps < minToks) return false;
    }
    if (hq) {
      const country = providerHq(m.provider);
      if (hq === 'unknown') {
        if (country) return false;
      } else if (country !== hq) {
        return false;
      }
    }
    return true;
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function computeAndRender() {
  if (!state.data) return;
  const tokens = getTokens();
  const provSearch = els.providerSearch.value.trim().toLowerCase();
  const modSearch = els.modelSearch.value.trim().toLowerCase();

  // Update breakdown display. In budget mode the total-token count is unknown
  // (that's what we're solving for), so show only the percentage mix.
  const budgetModeBreakdown = state.computeBy === 'budget';
  if (budgetModeBreakdown) {
    els.tokenBreakdown.textContent = `Input: ${tokens.inputPct}% · Cached: ${tokens.cacheReadPct}% · Output: ${tokens.outputPct}%`;
  } else {
    const fmtM = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`;
    els.tokenBreakdown.textContent = `Input: ${fmtM(tokens.input)} · Cached: ${fmtM(tokens.cacheRead)} · Output: ${fmtM(tokens.output)}`;
  }
  const sumPct = tokens.sum;
  if (Math.abs(sumPct - 100) < 0.01) {
    els.pctSum.textContent = '100%';
    els.pctSum.className = 'pct-ok';
  } else {
    els.pctSum.textContent = `${sumPct.toFixed(1)}% (should be 100%)`;
    els.pctSum.className = 'pct-warn';
  }

  const promoOnly = els.promoOnly.checked;
  const zdrOnly = els.zdrOnly?.checked;
  const subscriptionOnly = els.subscriptionOnly?.checked;
  const minIntelligence = els.minIntelligence ? (parseInt(els.minIntelligence.value, 10) || 0) : 0;
  let offerings = matchingOfferings();

  // Build results title
  let title = 'All models across all providers';
  if (modSearch && provSearch) {
    title = `'${modSearch}' from '${provSearch}'`;
  } else if (modSearch) {
    title = `Results for '${modSearch}'`;
  } else if (provSearch) {
    title = `All models from '${provSearch}'`;
  }
  if (zdrOnly) title += ' (ZDR only)';
  if (promoOnly) title += ' (promos only)';
  if (subscriptionOnly) title += ' (subscription only)';
  if (minIntelligence) title += ` (IQ ≥ ${minIntelligence})`;
  if (els.hideBatch && !els.hideBatch.checked) title += ' (incl. batch)';
  if (els.cacheOnly?.checked) title += ' (cache pricing)';
  const maxBlendedTitle = parseFloat(els.maxBlended?.value);
  if (Number.isFinite(maxBlendedTitle) && maxBlendedTitle > 0) title += ` (blended ≤ $${maxBlendedTitle}/M)`;
  const minToksTitle = parseFloat(els.minToks?.value);
  if (Number.isFinite(minToksTitle) && minToksTitle > 0) title += ` (≥ ${minToksTitle} tok/s)`;
  const hqTitle = (els.hqFilter?.value || '').trim();
  if (hqTitle) title += hqTitle === 'unknown' ? ' (HQ unknown)' : ` (HQ ${hqTitle})`;
  els.resultsTitle.textContent = title;
  if (els.popularChips) {
    const q = (els.modelSearch.value || '').trim().toLowerCase();
    els.popularChips.querySelectorAll('.popular-chip').forEach((chip) => {
      chip.classList.toggle('active', !!q && chip.dataset.model === q);
    });
  }

  // Compute the per-row headline value (cost $ in forward mode, affordable
  // tokens in millions in budget mode). Both are positive; sort/comparator
  // treats r.cost uniformly. Monthly mode scales by ×30 in BOTH directions:
  //   forward  → cost is monthly cost = perSessionCost × 30
  //   budget   → affordable tokens = afford(budget/30) × 30  (budget spans 30 sessions)
  const modeMultiplier = state.costMode === 'monthly' ? 30 : 1;
  const budgetMode = state.computeBy === 'budget';
  const budgetVal = budgetMode ? Math.max(0, parseFloat(els.budgetInput?.value) || 0) : 0;
  // Per-session budget = monthly budget / 30 (modeMultiplier), or full budget in per-session mode.
  const perSessionBudget = budgetMode ? budgetVal / modeMultiplier : 0;
  const rows = offerings
    .map((m) => ({
      model: m,
      blended: blendedCostFor(m.pricing, tokens),
      cost: budgetMode
        ? affordabilityFor(m.pricing, tokens, perSessionBudget)
        : costFor(m.pricing, tokens),
    }))
    .filter((r) => r.cost !== null && r.cost !== undefined)
    .map((r) => ({ ...r, cost: r.cost * modeMultiplier }));

  // Sort by current sort column
  sortRows(rows);

  // Update sort indicator on headers (+ aria-sort for screen readers)
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortBy) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });

  // Sync mobile sort dropdown
  els.mobileSort.value = `${state.sortBy}:${state.sortDir}`;

  state.currentRows = rows;
  renderBenchmarkBox(rows);
  renderTable(rows, tokens);
  updateHash();
}

/** Pretty-display an org key: "z-ai" → "Z.ai", "openai" → "OpenAI", "deepseek" → "DeepSeek" */
function orgDisplay(org) {
  // Known proper names
  const known = {
    'z-ai': 'Z.ai',
    'openai': 'OpenAI',
    'deepseek': 'DeepSeek',
    'meta': 'Meta',
    'google': 'Google',
    'anthropic': 'Anthropic',
    'mistral': 'Mistral',
    'moonshot': 'Moonshot',
    'minimax': 'MiniMax',
    'nvidia': 'NVIDIA',
    'bytedance': 'ByteDance',
    'nous': 'Nous',
    'ibm': 'IBM',
    'sao10k': 'Sao10K',
    'stepfun': 'StepFun',
    'xiaomi': 'Xiaomi',
  };
  if (known[org]) return known[org];
  // Title-case fallback: "first-word" → "First-word"
  return org.charAt(0).toUpperCase() + org.slice(1);
}

function providerName(key, display) {
  return display || state.data.providers.find((p) => p.key === key)?.name || key;
}

// Round to 3 decimals — kills IEEE 754 float noise (0.030000000000000002 → 0.03,
// 0.024999999999999998 → 0.025). Per-unit pricing only; aggregate cost uses fmtCost.


function sortValue(r, sortBy) {
  switch (sortBy) {
    case 'org':        return orgDisplay(r.model.org).toLowerCase();
    case 'provider':   return providerName(r.model.provider, r.model.provider_display).toLowerCase();
    case 'model':      return r.model.name?.toLowerCase() || r.model.id.toLowerCase();
    case 'input':      return r.model.pricing.input;
    case 'output':     return r.model.pricing.output;
    case 'cache_read': return r.model.pricing.cache_read;
    case 'context':    return r.model.context_length;
    case 'speed':      return getPerfData(r)?.throughput?.p50 ?? null;
    case 'ttft':       return getPerfData(r)?.latency?.p50 ?? null;
    case 'blended':    return r.blended;
    case 'cost':
    default:           return r.cost;
  }
}

/** Sort rows by the current sort column/direction. Null values always sort to END. */
function sortRows(rows) {
  const { sortBy, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = sortValue(a, sortBy);
    const vb = sortValue(b, sortBy);
    // Null/undefined values always sort to the END, regardless of direction
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

function rankingMetric() {
  const by = state.sortBy;
  let label;
  switch (by) {
    case 'org':        label = 'model creator'; break;
    case 'provider':   label = 'provider'; break;
    case 'model':      label = 'model name'; break;
    case 'input':      label = 'input price'; break;
    case 'output':     label = 'output price'; break;
    case 'cache_read': label = 'cache-read price'; break;
    case 'context':    label = 'context window'; break;
    case 'speed':      label = 'throughput'; break;
    case 'ttft':       label = 'time to first token'; break;
    case 'blended':    label = 'blended rate'; break;
    case 'cost':
    default:           label = state.computeBy === 'budget' ? 'affordable tokens' : (state.costMode === 'monthly' ? 'monthly cost' : 'session cost'); break;
  }
  return { by, dir: state.sortDir, label };
}

function formatRankingValue(value, by) {
  if (value === null || value === undefined) return 'no value';
  if (by === 'cost') {
    return state.computeBy === 'budget'
      ? `${roundMoney(value)}M tokens`
      : `$${roundMoney(value)} ${state.costMode === 'monthly' ? '/month' : '/session'}`;
  }
  if (by === 'blended' || ['input', 'output', 'cache_read'].includes(by)) return `$${roundMoney(value)}/M`;
  if (by === 'speed') return `${roundMoney(value)} tok/s`;
  if (by === 'ttft') return `${fmtTtftSeconds(value)} s`;
  if (by === 'context') return `${Number(value).toLocaleString()} tokens`;
  return String(value);
}

/** Format context length for display: 1000000 → "1M", 262000 → "262K", null → "—" */
function fmtContext(ctx) {
  if (!ctx || ctx <= 0) return `<span class="missing">—</span>`;
  if (ctx >= 1e6) return `${(ctx / 1e6).toFixed(ctx % 1e6 === 0 ? 0 : 1)}M`;
  if (ctx >= 1e3) return `${Math.round(ctx / 1e3)}K`;
  return String(ctx);
}

const HQ_FLAGS = { US:'🇺🇸', SG:'🇸🇬', CN:'🇨🇳', IL:'🇮🇱', FR:'🇫🇷', NL:'🇳🇱', ES:'🇪🇸', ID:'🇮🇩', SE:'🇸🇪', GB:'🇬🇧', DE:'🇩🇪', CA:'🇨🇦', JP:'🇯🇵', KR:'🇰🇷', IN:'🇮🇳' };

function providerMetaHtml(providerKey) {
  const meta = state.data.providers_meta?.[providerKey];
  if (!meta) return '';
  let html = '';
  const hq = meta.headquarters;
  if (hq) {
    const flag = HQ_FLAGS[hq];
    if (flag) {
      html += `<span class="hq-badge" title="Headquartered in ${esc(hq)}">${flag}</span>`;
    } else {
      html += `<span class="hq-badge" title="Headquartered in ${esc(hq)}">${esc(hq)}</span>`;
    }
  }
  if (meta.privacy_policy_url) {
    html += `<a href="${esc(meta.privacy_policy_url)}" target="_blank" rel="noopener" class="meta-link" title="Privacy Policy">🔒</a>`;
  }
  if (meta.terms_of_service_url) {
    html += `<a href="${esc(meta.terms_of_service_url)}" target="_blank" rel="noopener" class="meta-link" title="Terms of Service">📋</a>`;
  }
  if (meta.status_page_url) {
    html += `<a href="${esc(meta.status_page_url)}" target="_blank" rel="noopener" class="meta-link" title="Status Page">📊</a>`;
  }
  return html;
}

/** Shared perf-data lookup — used by renderSpeedCell and sortRows. */
function getPerfData(r) {
  if (!state.perfData) return null;
  const model = r.model || r;
  const key = canonicalModelId(model.id) + '|' + model.provider;
  return state.perfData[key] || null;
}

function isBatchOrFreeId(id) {
  const s = String(id || '').toLowerCase();
  return s.includes(':batch') || s.includes(':free') || s.endsWith('-batch');
}

function providerHq(providerKey) {
  const meta = state.data?.providers_meta || {};
  const slug = meta[providerKey] ? providerKey : (HQ_SLUG_ALIASES[providerKey] || providerKey);
  return meta[slug]?.headquarters || null;
}

/** Latency p50 is stored in milliseconds; the table displays seconds. */
function fmtTtftSeconds(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const sec = ms / 1000;
  return Math.round(sec * 100) / 100;
}

function ttftP50Seconds(r) {
  const ms = getPerfData(r)?.latency?.p50;
  return ms == null ? null : fmtTtftSeconds(ms);
}

function renderProviderCell(r) {
    const name = providerName(r.model.provider, r.model.provider_display);
    const zdrBadge = r.model.zdr ? ' <span class="zdr-badge" title="Zero Data Retention — provider does not store prompts">ZDR</span>' : '';
    const subBadge = r.model.subscription ? ' <span class="subscription-badge" title="This provider offers subscription/coding plans">Sub</span>' : '';
    return '<span class="provider-badge">' + esc(name) + '</span>' + zdrBadge + subBadge + providerMetaHtml(r.model.provider);
  }

/** Render the Speed column cell — throughput only (higher = faster).
 *  TTFT is a separate column (seconds, lower = faster). */
function renderSpeedCell(r) {
    const perf = getPerfData(r);
    const tps = perf?.throughput?.p50;
    if (tps == null) return '<span class="missing">—</span>';
    const t = perf.throughput;
    const r1 = (v) => v != null ? Math.round(v * 10) / 10 : '—';
    const title = `Throughput p50/p75/p90/p99: ${r1(t.p50)}/${r1(t.p75)}/${r1(t.p90)}/${r1(t.p99)} tps`;
    return '<span class="perf-pill" title="' + esc(title) + '">⚡' + esc(String(r1(tps))) + 'tps</span>';
  }

function renderTtftCell(r) {
    const perf = getPerfData(r);
    const ms = perf?.latency?.p50;
    if (ms == null) return '<span class="missing">—</span>';
    const sec = fmtTtftSeconds(ms);
    const l = perf.latency;
    const r1 = (v) => v != null ? fmtTtftSeconds(v) : '—';
    const title = `TTFT p50/p75/p90/p99: ${r1(l.p50)}/${r1(l.p75)}/${r1(l.p90)}/${r1(l.p99)} s`;
    return '<span class="perf-pill" title="' + esc(title) + '">' + esc(String(sec)) + 's</span>';
  }

function globalBestValue(rows) {
  // Highlight the row that's currently "winning" on the cost/affordability column
  // given the sort order: asc + forward → cheapest ($) = min; desc + budget →
  // most-affordable (tokens) = max (Infinity ranks above any finite).
  if (state.sortBy !== 'cost') return null;
  if (state.computeBy === 'budget') {
    if (state.sortDir !== 'desc') return null;
    let best = null;
    for (const r of rows) {
      if (r.cost == null) continue;
      if (best === null || r.cost > best) best = r.cost;
    }
    return best;
  }
  if (state.sortDir !== 'asc') return null;
  const hit = rows.find((r) => r.cost > 0);
  return hit ? hit.cost : null;
}

function renderModelRow(r, rank, groupKey, cheapest) {
  const p = r.model.pricing;
  const promo = r.model.discount > 0
    ? ` <span class="promo-badge" title="${(r.model.discount * 100).toFixed(0)}% off">promo</span>`
    : '';
  const modelDisplay = (r.model.name && r.model.name !== r.model.id) ? r.model.name : r.model.id;
  const groupAttr = groupKey !== undefined ? ` data-group="${esc(groupKey)}"` : '';
  const isSelected = state.compareSelection.some(m => m.id === r.model.id && m.provider === r.model.provider);
  const rowIdx = state.currentRows
    ? state.currentRows.findIndex((x) => x.model.id === r.model.id && x.model.provider === r.model.provider)
    : rank - 1;
  const checkbox = `<input type="checkbox" class="compare-check" data-idx="${rowIdx}" ${isSelected ? 'checked' : ''}${state.compareSelection.length >= 6 && !isSelected ? ' disabled' : ''}>`;
  return `<tr data-idx="${rowIdx}"${groupAttr} tabindex="0" aria-label="Open details">
    <td class="rank" data-label="#">${checkbox} ${rank}${cheapest ? ' 🏆' : ''}</td>
    <td data-label="Org"><span class="org-badge">${esc(orgDisplay(r.model.org))}</span></td>
    <td data-label="Provider">${renderProviderCell(r)}</td>
    <td data-label="Model">${esc(modelDisplay)}${promo}</td>
    <td class="num" data-label="Input $/M">${fmtPrice(p.input)}</td>
    <td class="num" data-label="Output $/M">${fmtPrice(p.output)}</td>
    <td class="num" data-label="Cache $/M">${fmtPrice(p.cache_read)} / ${fmtPrice(p.cache_write)}</td>
    <td class="num" data-label="Context">${fmtContext(r.model.context_length)}</td>
    <td class="num speed-cell" data-label="Speed">${renderSpeedCell(r)}</td>
    <td class="num ttft-cell" data-label="TTFT">${renderTtftCell(r)}</td>
    <td class="num" data-label="Blended $/M">${r.blended != null ? fmtPrice(r.blended) : '<span class="missing">—</span>'}</td>
    <td class="num cost" data-label="${esc(els.costColumnHeader.textContent)}">${state.computeBy === 'budget' ? fmtAffordability(r.cost) : fmtCost(r.cost)}</td>
  </tr>`;
}

function renderFlatTable(rows, tokens) {
  const best = globalBestValue(rows);
  // Cap first paint at ROW_CAP; data-idx is resolved against full state.currentRows
  // so the head slice keeps visible-row indices valid. Grouped view is not capped.
  const capped = !state.showAllRows && rows.length > ROW_CAP;
  const visible = capped ? rows.slice(0, ROW_CAP) : rows;
  let html = visible
    .map((r, i) => {
      const isBest = best !== null && r.cost != null && r.cost === best;
      return renderModelRow(r, i + 1, undefined, isBest);
    })
    .join('');
  if (capped) {
    const colCount = els.showOrg?.checked ? 12 : 11;
    html += `<tr class="show-all-row"><td colspan="${colCount}">
      <button type="button" id="showAllRows">Show all ${rows.length} models</button>
    </td></tr>`;
  }
  els.resultsBody.innerHTML = html;
}
function renderGroupedTable(rows, tokens, groupBy) {
  const best = globalBestValue(rows);
  const budgetMode = state.computeBy === 'budget';
  const groups = new Map();
  for (const r of rows) {
    const key = groupBy === 'org' ? r.model.org : r.model.provider;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const da = groupBy === 'org' ? orgDisplay(a) : providerName(a);
    const db = groupBy === 'org' ? orgDisplay(b) : providerName(b);
    return da.localeCompare(db);
  });

  let html = '';
  let rank = 0;
  for (const key of sortedKeys) {
    const groupRows = groups.get(key);
    const groupName = groupBy === 'org' ? orgDisplay(key) : providerName(key);
    // Per-group best: min($) forward, max(tokens) budget (Infinity ranks above finite)
    const groupBest = groupRows.reduce((acc, r) => {
      if (r.cost == null) return acc;
      if (acc === null) return r.cost;
      return budgetMode ? Math.max(acc, r.cost) : (r.cost > 0 ? Math.min(acc, r.cost) : acc);
    }, null);
    const bestLabel = groupBest !== null
      ? (budgetMode ? `up to ${fmtAffordability(groupBest)}` : `from ${fmtCost(groupBest)}`)
      : '';
    const colCount = els.showOrg?.checked ? 12 : 11;
    html += `<tr class="group-header" data-group="${esc(key)}">
      <td colspan="${colCount}">
        <span class="collapse-arrow">▼</span>
        ${esc(groupName)}
        <span class="group-count">${groupRows.length} model${groupRows.length === 1 ? '' : 's'}</span>
        ${bestLabel ? `<span class="group-cheapest">${bestLabel}</span>` : ''}
      </td>
    </tr>`;
    for (const r of groupRows) {
      rank += 1;
      const isBest = best !== null && r.cost != null && r.cost === best;
      html += renderModelRow(r, rank, key, isBest);
    }
  }
  els.resultsBody.innerHTML = html;
}

// ── Column customization (drag-reorder + hide) ────────────────────────────────

/** Resolve the effective column order (default if state.colOrder is null). */
function effectiveColOrder() {
  return state.colOrder || DEFAULT_COL_ORDER;
}

/** Resolve the effective hidden set (empty if state.colHidden is null). */
function effectiveColHidden() {
  return state.colHidden || new Set();
}

/**
 * Apply the current column order + visibility to the rendered table DOM.
 * Reorders thead <th> and each tbody <td> to match state.colOrder, and toggles
 * the hide-col-* classes per state.colHidden. The # and Total Cost columns are
 * never reordered (they stay first/last) and never hidden.
 */
function applyColumnLayout() {
  const table = document.getElementById('resultsTable');
  if (!table) return;
  const theadRow = table.querySelector('thead tr');
  if (!theadRow) return;

  const order = effectiveColOrder();
  const hidden = effectiveColHidden();

  // Reorder thead <th> (skip index 0 = # and last = Total Cost)
  const ths = Array.from(theadRow.children);
  if (ths.length < 3) return;
  const firstTh = ths[0];
  const lastTh = ths[ths.length - 1];
  const middleThs = ths.slice(1, -1);
  const thByKey = new Map();
  for (const th of middleThs) thByKey.set(th.dataset.sort, th);
  const reordered = order.map((k) => thByKey.get(k)).filter(Boolean);
  // Append any th not in the order (safety) in their existing relative order
  for (const th of middleThs) if (!reordered.includes(th)) reordered.push(th);
  for (const th of reordered) theadRow.insertBefore(th, lastTh);

  // Reorder each tbody <td> (skip index 0 = # and last = Total Cost)
  const bodyRows = table.querySelectorAll('tbody tr');
  for (const tr of bodyRows) {
    // Skip group-header rows (single colspan cell) and show-all rows
    if (tr.classList.contains('group-header') || tr.classList.contains('show-all-row')) continue;
    const tds = Array.from(tr.children);
    if (tds.length < 3) continue;
    const firstTd = tds[0];
    const lastTd = tds[tds.length - 1];
    const middleTds = tds.slice(1, -1);
    const tdByLabel = new Map();
    for (const td of middleTds) tdByLabel.set(td.dataset.label, td);
    const reorderedTds = [];
    for (const k of order) {
      const col = COLUMN_KEYS.find((c) => c.key === k);
      if (col && tdByLabel.has(col.dataLabel)) reorderedTds.push(tdByLabel.get(col.dataLabel));
    }
    for (const td of middleTds) if (!reorderedTds.includes(td)) reorderedTds.push(td);
    for (const td of reorderedTds) tr.insertBefore(td, lastTd);
  }

  // Toggle hide classes
  for (const col of COLUMN_KEYS) {
    table.classList.toggle('hide-col-' + col.key, hidden.has(col.key));
  }
}

/** Build the popover checkbox list from COLUMN_KEYS + current hidden state. */
function renderColPopover() {
  const list = document.getElementById('colPopoverList');
  if (!list) return;
  const hidden = effectiveColHidden();
  list.innerHTML = COLUMN_KEYS.map((c) => {
    const checked = hidden.has(c.key) ? '' : ' checked';
    return `<label><input type="checkbox" class="col-toggle" data-col="${c.key}"${checked}> ${esc(c.label)}</label>`;
  }).join('');
}

/** Toggle the popover open/closed. */
function toggleColPopover(force) {
  const btn = document.getElementById('colConfigBtn');
  const pop = document.getElementById('colPopover');
  if (!btn || !pop) return;
  const open = force !== undefined ? force : pop.hidden;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) renderColPopover();
}

/** Reset column order + visibility to defaults. */
function resetColumns() {
  state.colOrder = null;
  state.colHidden = null;
  applyColumnLayout();
  renderColPopover();
  updateHash();
}

/** Wire drag-to-reorder on the draggable column handles. */
function initColumnDrag() {
  const table = document.getElementById('resultsTable');
  if (!table) return;
  let dragKey = null;
  let dragTh = null;

    table.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.col-handle');
      if (!handle) return;
      const th = handle.closest('th');
      if (!th || !th.dataset.sort) return;
      e.preventDefault();
      // Suppress the click-to-sort that would otherwise fire after the drag
      // (preventDefault on pointerdown does not stop the subsequent click).
      window.__colDragSuppress = Date.now();
      dragKey = th.dataset.sort;
      dragTh = th;
      th.classList.add('col-dragging');
      table.classList.add('col-dragging');
      th.setPointerCapture(e.pointerId);
    });

      table.addEventListener('pointermove', (e) => {
        if (!dragTh) return;
        // setPointerCapture retargets pointer events to dragTh, so e.target is
        // always the dragged header. Resolve the hovered column from coordinates.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const target = el ? el.closest('th') : null;
        // Only highlight draggable columns (exclude locked # and Total Cost).
        if (!target || target === dragTh || !target.dataset.sort || !DEFAULT_COL_ORDER.includes(target.dataset.sort)) return;
        // Clear previous drop targets
        table.querySelectorAll('th.col-drop-target').forEach((t) => t.classList.remove('col-drop-target'));
        target.classList.add('col-drop-target');
      });

    table.addEventListener('pointerup', (e) => {
      if (!dragTh) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const target = el ? el.closest('th') : null;
      table.querySelectorAll('th.col-drop-target').forEach((t) => t.classList.remove('col-drop-target'));
      dragTh.classList.remove('col-dragging');
      table.classList.remove('col-dragging');
      if (target && target !== dragTh && target.dataset.sort) {
        // Reorder state.colOrder: move dragKey to target's position
        const order = effectiveColOrder().slice();
        const from = order.indexOf(dragKey);
        const to = order.indexOf(target.dataset.sort);
        if (from >= 0 && to >= 0) {
          order.splice(from, 1);
          order.splice(to, 0, dragKey);
          state.colOrder = order;
          applyColumnLayout();
          updateHash();
        }
      }
      dragKey = null;
      dragTh = null;
    });

  table.addEventListener('pointercancel', () => {
    if (dragTh) dragTh.classList.remove('col-dragging');
    table.classList.remove('col-dragging');
    table.querySelectorAll('th.col-drop-target').forEach((t) => t.classList.remove('col-drop-target'));
    dragKey = null;
    dragTh = null;
  });
}

function renderTable(rows, tokens) {
  if (rows.length === 0) {
    const colCount = els.showOrg?.checked ? 12 : 11;
    els.resultsBody.innerHTML = `<tr><td colspan="${colCount}" class="empty">No offerings match your criteria. Some providers may not support the token types you entered.</td></tr>`;
    return;
  }
  const groupBy = els.groupBy?.value || 'none';
  state.groupBy = groupBy;
    if (groupBy === 'none') {
      renderFlatTable(rows, tokens);
    } else {
      renderGroupedTable(rows, tokens, groupBy);
    }
    applyColumnLayout();
  }

/** Export current results table to CSV and trigger download. Returns the filename, or null. */
function exportCsv() {
  const rows = state.currentRows;
  if (!rows || rows.length === 0) return null;

  const headers = [
    'Rank', 'Org', 'Provider', 'Model', 'Input $/M', 'Output $/M',
    'Cache Read $/M', 'Cache Write $/M', 'Context', 'Speed (tps p50)', 'TTFT (s p50)',
    'Blended $/M', state.computeBy === 'budget' ? 'Affordable (M tokens)' : 'Total Cost',
    'ZDR', 'Subscription', 'Discount',
  ];

  const escapeCsv = (v) => {
    if (v == null) return '';
    let s = String(v);
    // Prevent formula injection when opened in spreadsheet apps
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(',')];
  rows.forEach((r, i) => {
    const m = r.model;
    const p = m.pricing;
    const tps = getPerfData(r)?.throughput?.p50;
    const headline = r.cost == null ? ''
      : (state.computeBy === 'budget'
          ? (r.cost === Infinity ? 'Infinity' : r.cost)
          : r.cost);
    lines.push([
      i + 1,
      orgDisplay(m.org),
      providerName(m.provider, m.provider_display),
      (m.name && m.name !== m.id) ? m.name : m.id,
      p.input ?? '',
      p.output ?? '',
      p.cache_read ?? '',
      p.cache_write ?? '',
      m.context_length ?? '',
      tps ?? '',
      ttftP50Seconds(r) ?? '',
      r.blended ?? '',
      headline,
      m.zdr ? 'yes' : 'no',
      m.subscription ? 'yes' : 'no',
      m.discount > 0 ? m.discount : '',
    ].map(escapeCsv).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  const filename = `tokenwatch-${stamp}.csv`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return filename;
}

// ── WebMCP façade (window.TWCatalog) ─────────────────────────────────────────
// Site tools in public/webmcp.js call these methods. Cost math stays here —
// never copy costFor / blendedCostFor into webmcp.js. Row identity is
// { provider, id }, never DOM rank. Assigned only after pricing.json loads.

function roundMoney(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}

function mixWarning() {
  const tokens = getTokens();
  if (Math.abs(tokens.sum - 100) <= 0.5) return null;
  return `Mix percentages sum to ${tokens.sum.toFixed(1)}% (should be 100). Ranking still uses the entered mix; the UI shows the same warning.`;
}

function findModel(provider, id) {
  const rows = state.currentRows || [];
  const idx = rows.findIndex((r) => r.model.provider === provider && r.model.id === id);
  if (idx >= 0) return { model: rows[idx].model, row: rows[idx], idx, inView: true };
  const m = (state.data?.models || []).find((x) => x.provider === provider && x.id === id);
  return m ? { model: m, row: null, idx: -1, inView: false } : null;
}

function snapshotRow(r, rank) {
  const m = r.model;
  return {
    rank,
    provider: m.provider,
    id: m.id,
    name: (m.name && m.name !== m.id) ? m.name : m.id,
    org: m.org || null,
    cost: roundMoney(r.cost),
    blended: roundMoney(r.blended),
    zdr: !!m.zdr,
    speedP50: getPerfData(r)?.throughput?.p50 ?? null,
    ttftP50: ttftP50Seconds(r),
  };
}

function getView(input) {
  const n = Math.min(25, Math.max(1, parseInt(input?.limit, 10) || 10));
  const rows = state.currentRows || [];
  const tokens = getTokens();
  const warning = mixWarning();
  const snapshot = {
    page: 'text',
    generated_at: state.data?.generated_at || null,
    workload: {
      computeBy: state.computeBy,
      costMode: state.costMode,
      totalTokensM: parseFloat(els.totalTokens.value) || 0,
      mix: [tokens.inputPct, tokens.cacheReadPct, tokens.outputPct],
      budget: parseFloat(els.budgetInput?.value) || 0,
      cacheWrite: parseFloat(els.cacheWriteTokens?.value) || 0,
      amortizeN: parseInt(els.amortizeN?.value, 10) || 100,
    },
    filters: {
      provider: els.providerSearch.value.trim(),
      model: els.modelSearch.value.trim(),
      zdr: !!els.zdrOnly?.checked,
      sub: !!els.subscriptionOnly?.checked,
      promo: !!els.promoOnly?.checked,
      groupBy: els.groupBy?.value || 'none',
      minIntelligence: els.minIntelligence ? (parseInt(els.minIntelligence.value, 10) || 0) : 0,
      hideBatch: els.hideBatch ? !!els.hideBatch.checked : DEFAULTS.hideBatch,
      cacheOnly: !!els.cacheOnly?.checked,
      maxBlended: parseFloat(els.maxBlended?.value) || 0,
      minToks: parseFloat(els.minToks?.value) || 0,
      hq: els.hqFilter?.value || '',
    },
    sort: {
      by: state.sortBy,
      dir: state.sortDir,
    },
    compare: state.compareSelection.map((m) => ({ provider: m.provider, id: m.id })),
    rowCount: rows.length,
    top: rows.slice(0, n).map((r, i) => snapshotRow(r, i + 1)),
    shareUrl: location.href,
  };
  if (warning) snapshot.warning = warning;
  return snapshot;
}

function getModel(input) {
  if (!input?.provider || !input?.id) return { error: 'provider and id are required (row identity, not rank).' };
  const found = findModel(input.provider, input.id);
  if (!found) return { error: `No offering ${input.provider} / ${input.id} in the catalog.` };
  if (!found.inView) {
    return { error: `${input.provider} / ${input.id} is not in the current view. Call get_view or clear_filters / set_filters first.`, inView: false };
  }
  const m = found.model;
  const r = found.row;
  return {
    provider: m.provider,
    id: m.id,
    name: (m.name && m.name !== m.id) ? m.name : m.id,
    org: m.org || null,
    pricing: m.pricing,
    context_length: m.context_length ?? null,
    max_completion_tokens: m.max_completion_tokens ?? null,
    quantization: m.quantization ?? null,
    zdr: !!m.zdr,
    subscription: !!m.subscription,
    discount: m.discount || 0,
    benchmarks: m.benchmarks || null,
    energy: m.energy || null,
    cost: roundMoney(r.cost),
    blended: roundMoney(r.blended),
    speedP50: getPerfData(r)?.throughput?.p50 ?? null,
    ttftP50: ttftP50Seconds(r),
  };
}

function explainRanking() {
  const rows = state.currentRows || [];
  if (rows.length < 2) {
    return { error: 'Need at least two ranked rows. Widen filters or set_workload, then get_view.' };
  }
  const tokens = getTokens();
  const modeMultiplier = state.costMode === 'monthly' ? 30 : 1;
  const winner = rows[0];
  const runner = rows[1];
  const wBreak = costBreakdown(winner.model.pricing, tokens);
  const rBreak = costBreakdown(runner.model.pricing, tokens);
  const matched = matchingOfferings();
  const excluded = [];
  for (const m of matched) {
    if (costFor(m.pricing, tokens) == null) {
      excluded.push({ provider: m.provider, id: m.id });
      if (excluded.length >= 8) break;
    }
  }
  const excludedCount = matched.filter((m) => costFor(m.pricing, tokens) == null).length;
  const wName = (winner.model.name && winner.model.name !== winner.model.id) ? winner.model.name : winner.model.id;
  const rName = (runner.model.name && runner.model.name !== runner.model.id) ? runner.model.name : runner.model.id;
  const ranking = rankingMetric();
  const winnerValue = sortValue(winner, ranking.by);
  const runnerValue = sortValue(runner, ranking.by);
  const winnerDisplay = formatRankingValue(winnerValue, ranking.by);
  const runnerDisplay = formatRankingValue(runnerValue, ranking.by);
  let why;
  if (winnerValue === runnerValue) {
    why = `#1 ${winner.model.provider}/${wName} ties #2 ${runner.model.provider}/${rName} on ${ranking.label} (${winnerDisplay}); the current row order is a tie.`;
  } else if (['org', 'provider', 'model'].includes(ranking.by)) {
    why = `#1 ${winner.model.provider}/${wName} appears first alphabetically by ${ranking.label} (${winnerDisplay} vs ${runnerDisplay} for #2 ${runner.model.provider}/${rName}).`;
  } else {
    const better = ranking.dir === 'asc' ? 'lower' : 'higher';
    why = `#1 ${winner.model.provider}/${wName} ranks first on ${ranking.label} (${winnerDisplay} vs ${runnerDisplay} for #2 ${runner.model.provider}/${rName}); ${better} is better for this sort.`;
  }
  return {
    metric: ranking.label,
    sort: ranking,
    mix: [tokens.inputPct, tokens.cacheReadPct, tokens.outputPct],
    costMode: state.costMode,
    computeBy: state.computeBy,
    winner: { ...snapshotRow(winner, 1), rankingValue: winnerValue, rankingValueFormatted: winnerDisplay, components: {
      input: roundMoney(wBreak.input),
      output: roundMoney(wBreak.output),
      cacheRead: roundMoney(wBreak.cacheRead),
      cacheWrite: roundMoney(wBreak.cacheWrite),
      sessionTotal: roundMoney(wBreak.total),
      displayed: roundMoney(winner.cost),
      modeMultiplier,
    } },
    runnerUp: { ...snapshotRow(runner, 2), rankingValue: runnerValue, rankingValueFormatted: runnerDisplay, components: {
      input: roundMoney(rBreak.input),
      output: roundMoney(rBreak.output),
      cacheRead: roundMoney(rBreak.cacheRead),
      cacheWrite: roundMoney(rBreak.cacheWrite),
      sessionTotal: roundMoney(rBreak.total),
      displayed: roundMoney(runner.cost),
      modeMultiplier,
    } },
    why,
    excludedForUnsupportedMix: excludedCount,
    excludedSample: excluded,
    warning: mixWarning() || undefined,
  };
}

function listPresets() {
  return {
    presets: Object.entries(PRESETS).map(([name, p]) => ({
      name,
      totalTokensM: p.totalTokens,
      mix: { input: p.inputPct, cache: p.cacheReadPct, output: p.outputPct },
    })),
    note: 'agentic is the default (cache-heavy). apply_preset re-renders the table.',
  };
}

function getShareUrl() {
  updateHash();
  return { shareUrl: location.href, note: 'This hash URL works in any browser — ChatGPT is not required.' };
}

function getCatalogInfo() {
  return {
    page: 'text',
    generated_at: state.data?.generated_at || null,
    catalogSize: state.data?.models?.length || 0,
    providerCount: new Set((state.data?.models || []).map((model) => model.provider).filter(Boolean)).size,
    note: 'generated_at is the pricing snapshot time. Do not invent a fresher date.',
  };
}

function setWorkload(input) {
  input = input || {};
  if (input.mix) {
    const mixIn = Number(input.mix.input);
    const mixCache = Number(input.mix.cache);
    const mixOut = Number(input.mix.output);
    if (![mixIn, mixCache, mixOut].every((n) => Number.isFinite(n))) {
      return { error: 'mix.input, mix.cache, and mix.output must be numbers.' };
    }
    const sum = mixIn + mixCache + mixOut;
    if (Math.abs(sum - 100) > 0.5) {
      return { error: `Mix percentages must sum to 100 (±0.5). Got ${mixIn}+${mixCache}+${mixOut}=${sum}. Will not silently renormalize — adjust the mix and retry.` };
    }
    els.inputPct.value = mixIn;
    els.cacheReadPct.value = mixCache;
    els.outputPct.value = mixOut;
  }
  if (input.totalTokensM != null) {
    const t = Number(input.totalTokensM);
    if (!Number.isFinite(t) || t < 0) return { error: 'totalTokensM must be a non-negative number (millions of tokens).' };
    els.totalTokens.value = t;
  }
  if (input.budget != null) {
    const b = Number(input.budget);
    if (!Number.isFinite(b) || b < 0) return { error: 'budget must be a non-negative number (USD).' };
    els.budgetInput.value = b;
  }
  let rendered = false;
  if (input.costMode) {
    if (input.costMode !== 'perRequest' && input.costMode !== 'monthly') {
      return { error: 'costMode must be "perRequest" or "monthly".' };
    }
    if (input.costMode !== state.costMode) {
      setCostMode(input.costMode);
      rendered = true;
    }
  }
  if (input.computeBy) {
    if (input.computeBy !== 'tokens' && input.computeBy !== 'budget') {
      return { error: 'computeBy must be "tokens" or "budget".' };
    }
    if (input.computeBy !== state.computeBy) {
      setComputeBy(input.computeBy);
      rendered = true;
    }
  }
  if (!rendered) computeAndRender();
  return getView();
}

function applyPresetFromCatalog(name) {
  if (!PRESETS[name]) {
    return { error: `Unknown preset "${name}". Valid: agentic, balanced, heavy-output, no-cache.` };
  }
  applyPreset(name);
  return getView();
}

const SORT_COLUMNS = ['org', 'provider', 'model', 'input', 'output', 'cache_read', 'context', 'speed', 'ttft', 'blended', 'cost'];

function setSort(input) {
  input = input || {};
  if (!SORT_COLUMNS.includes(input.by)) {
    return { error: `by must be one of: ${SORT_COLUMNS.join(', ')}.` };
  }
  if (input.dir !== 'asc' && input.dir !== 'desc') {
    return { error: 'dir must be "asc" or "desc".' };
  }
  state.sortBy = input.by;
  state.sortDir = input.dir;
  computeAndRender();
  return getView();
}

function setCacheWrite(input) {
  input = input || {};
  if (input.tokens != null) {
    const t = Number(input.tokens);
    if (!Number.isFinite(t) || t < 0) return { error: 'tokens must be a non-negative number (millions).' };
    els.cacheWriteTokens.value = t;
  }
  if (input.amortizeN != null) {
    const n = parseInt(input.amortizeN, 10);
    if (!Number.isFinite(n) || n < 1) return { error: 'amortizeN must be an integer ≥ 1.' };
    els.amortizeN.value = n;
  }
  computeAndRender();
  return getView();
}

function setFilters(input) {
  input = input || {};
  if (input.provider != null) els.providerSearch.value = String(input.provider);
  if (input.model != null) els.modelSearch.value = String(input.model);
  if (input.zdr != null) {
    if (els.zdrOnly) els.zdrOnly.checked = !!input.zdr;
  }
  if (input.sub != null) {
    if (els.subscriptionOnly) els.subscriptionOnly.checked = !!input.sub;
  }
  if (input.promo != null) els.promoOnly.checked = !!input.promo;
  if (input.groupBy != null) {
    if (!['none', 'org', 'provider'].includes(input.groupBy)) {
      return { error: 'groupBy must be none, org, or provider.' };
    }
    els.groupBy.value = input.groupBy;
  }
  if (input.minIntelligence != null) {
    const n = parseInt(input.minIntelligence, 10);
    if (!Number.isFinite(n) || n < 0) return { error: 'minIntelligence must be a non-negative integer.' };
    els.minIntelligence.value = n;
  }
  if (input.hideBatch != null && els.hideBatch) els.hideBatch.checked = !!input.hideBatch;
  if (input.cacheOnly != null && els.cacheOnly) els.cacheOnly.checked = !!input.cacheOnly;
  if (input.maxBlended != null) {
    const n = Number(input.maxBlended);
    if (!Number.isFinite(n) || n < 0) return { error: 'maxBlended must be a non-negative number ($/M).' };
    if (els.maxBlended) els.maxBlended.value = n > 0 ? n : '';
  }
  if (input.minToks != null) {
    const n = Number(input.minToks);
    if (!Number.isFinite(n) || n < 0) return { error: 'minToks must be a non-negative number (tok/s).' };
    if (els.minToks) els.minToks.value = n > 0 ? n : '';
  }
  if (input.hq != null && els.hqFilter) {
    els.hqFilter.value = String(input.hq);
  }
  state.showAllRows = false;
  computeAndRender();
  return getView();
}

function clearFilters() {
  els.providerSearch.value = DEFAULTS.providerSearch;
  els.modelSearch.value = DEFAULTS.modelSearch;
  if (els.zdrOnly) els.zdrOnly.checked = DEFAULTS.zdrOnly;
  if (els.subscriptionOnly) els.subscriptionOnly.checked = DEFAULTS.subscriptionOnly;
  els.promoOnly.checked = DEFAULTS.promoOnly;
  els.groupBy.value = DEFAULTS.groupBy;
  if (els.minIntelligence) els.minIntelligence.value = DEFAULTS.minIntelligence;
  if (els.hideBatch) els.hideBatch.checked = DEFAULTS.hideBatch;
  if (els.cacheOnly) els.cacheOnly.checked = DEFAULTS.cacheOnly;
  if (els.maxBlended) els.maxBlended.value = DEFAULTS.maxBlended || '';
  if (els.minToks) els.minToks.value = DEFAULTS.minToks || '';
  if (els.hqFilter) els.hqFilter.value = DEFAULTS.hq;
  state.showAllRows = false;
  computeAndRender();
  return getView();
}

function compareModels(input) {
  input = input || {};
  const action = input.action || 'add';
  if (!['add', 'remove', 'clear', 'set'].includes(action)) {
    return { error: 'action must be add, remove, clear, or set.' };
  }
  if (action === 'clear') {
    clearCompare();
    return getView();
  }
  const refs = Array.isArray(input.models) ? input.models : [];
  if ((action === 'add' || action === 'set' || action === 'remove') && refs.length === 0) {
    return { error: 'models must be a non-empty array of { provider, id }.' };
  }
  const missing = [];
  const notInView = [];
  if (action === 'set') state.compareSelection = [];
  for (const ref of refs) {
    if (!ref?.provider || !ref?.id) {
      missing.push(ref);
      continue;
    }
    const found = findModel(ref.provider, ref.id);
    if (!found) {
      missing.push(ref);
      continue;
    }
    if (!found.inView) notInView.push(`${ref.provider}/${ref.id}`);
    if (action === 'remove') {
      const i = state.compareSelection.findIndex((m) => m.id === found.model.id && m.provider === found.model.provider);
      if (i >= 0) state.compareSelection.splice(i, 1);
    } else {
      if (state.compareSelection.length >= 6) {
        updateCompareTray();
        computeAndRender();
        return { error: 'Compare tray is full (max 6). Remove one first.', ...getView() };
      }
      if (!state.compareSelection.some((m) => m.id === found.model.id && m.provider === found.model.provider)) {
        state.compareSelection.push(found.model);
      }
    }
  }
  updateCompareTray();
  computeAndRender();
  if (input.open) {
    if (state.compareSelection.length < 2) {
      return { error: 'Need at least 2 models to open the compare modal.', ...getView() };
    }
    showCompareModal();
  }
  const result = getView();
  if (missing.length) result.missing = missing;
  if (notInView.length) result.note = `Added from catalog but not in current filtered view: ${notInView.join(', ')}.`;
  return result;
}

function openDetail(input) {
  if (!input?.provider || !input?.id) return { error: 'provider and id are required.' };
  const found = findModel(input.provider, input.id);
  if (!found || !found.inView) {
    return { error: `${input.provider} / ${input.id} is not in the current view. Row identity is { provider, id } from get_view, never a rank number.` };
  }
  showDetailModal(found.idx);
  return { ok: true, opened: { provider: found.model.provider, id: found.model.id }, note: 'Opened the detail modal on the page the human is watching.' };
}

function highlightTradeoff(input) {
  const rows = state.currentRows || [];
  if (!rows.length) return { error: 'No rows in the current view.' };
  const kinds = Array.isArray(input?.kinds) && input.kinds.length
    ? input.kinds
    : ['cheapest', 'fastest', 'zdr_cheapest'];
  const picks = [];
  const add = (r) => {
    if (!r) return;
    if (picks.some((p) => p.model.id === r.model.id && p.model.provider === r.model.provider)) return;
    picks.push(r);
  };
  const finiteCost = rows.filter((r) => r.cost != null && Number.isFinite(r.cost));
  const better = (a, b) => (state.computeBy === 'budget' ? a.cost > b.cost : a.cost < b.cost);
  const cheapest = finiteCost.length
    ? finiteCost.reduce((a, b) => (better(a, b) ? a : b))
    : null;
  const fastest = rows.reduce((best, r) => {
    const tps = getPerfData(r)?.throughput?.p50;
    if (tps == null) return best;
    if (!best) return r;
    return tps > (getPerfData(best)?.throughput?.p50 ?? -Infinity) ? r : best;
  }, null);
  const zdrPool = finiteCost.filter((r) => r.model.zdr);
  const zdrCheapest = zdrPool.length
    ? zdrPool.reduce((a, b) => (better(a, b) ? a : b))
    : null;
  for (const kind of kinds) {
    if (kind === 'cheapest') add(cheapest);
    else if (kind === 'fastest') add(fastest);
    else if (kind === 'zdr_cheapest') add(zdrCheapest);
  }
  if (picks.length < 2) {
    return { error: 'Could not find two distinct tradeoff rows (need cheapest / fastest / ZDR-cheapest with data).', kinds };
  }
  state.compareSelection = picks.slice(0, 6).map((r) => r.model);
  updateCompareTray();
  computeAndRender();
  showCompareModal();
  return getView();
}

function exportCsvView() {
  const filename = exportCsv();
  if (!filename) return { error: 'No rows to export. Broaden filters first.' };
  return {
    ok: true,
    filename,
    rowCount: state.currentRows.length,
    triggeredDownload: true,
    note: 'In-app browsers (including ChatGPT) may block the file download. The ranking is still on screen; use get_share_url as a portable artifact.',
  };
}

async function snapshotCompare() {
  if (state.compareSelection.length < 2) {
    return { error: 'Need at least 2 models in compare. Call compare_models first.' };
  }
  showCompareModal();
  const card = document.querySelector('#compareModal .compare-modal-content');
  if (!card) return { error: 'Compare modal markup missing.' };
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `tokenwatch-compare-${stamp}.png`;
  try {
    const blob = await TW.domToPngBlob(card);
    if (!blob || blob.size === 0) throw new Error('renderer produced an empty image');
    TW.downloadBlob(blob, filename);
    return {
      ok: true,
      filename,
      triggeredDownload: true,
      note: 'PNG download may be blocked inside ChatGPT. Prefer get_share_url if the file does not appear.',
    };
  } catch (err) {
    return { error: err.message || String(err), note: 'PNG capture failed. Use get_share_url instead.' };
  }
}

async function downloadCostCardFor(input) {
  if (!input?.provider || !input?.id) return { error: 'provider and id are required.' };
  const found = findModel(input.provider, input.id);
  if (!found || !found.inView) {
    return { error: `${input.provider} / ${input.id} is not in the current view.` };
  }
  let card = null;
  try {
    card = buildCostCard(found.model);
    document.body.appendChild(card);
    card.offsetWidth;
    const blob = await TW.domToPngBlob(card);
    if (!blob || blob.size === 0) throw new Error('renderer produced an empty image');
    const filename = costCardFilename(found.model);
    TW.downloadBlob(blob, filename);
    return {
      ok: true,
      filename,
      triggeredDownload: true,
      note: 'PNG download may be blocked inside ChatGPT. Use get_share_url as a fallback.',
    };
  } catch (err) {
    return { error: err.message || String(err) };
  } finally {
    if (card && card.parentNode) card.parentNode.removeChild(card);
  }
}

function switchCatalog(page) {
  const path = CATALOG_PAGES[page];
  if (!path) return { error: `Unknown page "${page}". Allowlist: text, image, video, benchmarks.` };
  const url = path === '/' ? `${location.origin}/` : `${location.origin}${path}`;
  location.assign(url);
  return { ok: true, navigatingTo: url, note: 'The destination page registers its own page-specific tools after load.' };
}

function publishTwCatalog() {
  window.TWCatalog = {
    page: 'text',
    ready: true,
    getView,
    getModel,
    explainRanking,
    listPresets,
    getShareUrl,
    getCatalogInfo,
    setWorkload,
    applyPreset: applyPresetFromCatalog,
    setSort,
    setCacheWrite,
    setFilters,
    clearFilters,
    compareModels,
    openDetail,
    highlightTradeoff,
    exportCsv: exportCsvView,
    snapshotCompare,
    downloadCostCard: downloadCostCardFor,
    switchCatalog,
  };
  document.dispatchEvent(new CustomEvent('tw-catalog-ready', { detail: { page: 'text' } }));
}

// ── Boot ───────────────────────────────────────────────────────────────────────
init();
