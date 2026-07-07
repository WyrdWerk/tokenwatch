// TokenWatch — app.js
// Loads pricing.json, lets the user search by provider (inference host) and/or
// model name, enter token volumes as total + percentage breakdown, and computes
// per-offering cost.

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
  compareSelection: [], // array of model objects (max 4)
  currentRows: null,
};

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
  promoOnly: $('promoOnly'),
  zdrOnly: $('zdrOnly'),
  subscriptionOnly: $('subscriptionOnly'),
  modePerRequest: $('modePerRequest'),
  modeMonthly: $('modeMonthly'),
  totalTokensLabel: $('totalTokensLabel'),
  totalTokensHint: $('totalTokensHint'),
  costColumnHeader: $('costColumnHeader'),
  groupBy: $('groupBy'),
  compareTray: $('compareTray'),
  compareCount: $('compareCount'),
  compareBtn: $('compareBtn'),
  compareClear: $('compareClear'),
  compareModal: $('compareModal'),
  compareClose: $('compareClose'),
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
};


// Theme toggle
const themeToggle = document.getElementById('themeToggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('tw-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '☀' : '☾';
}
const savedTheme = localStorage.getItem('tw-theme');
if (savedTheme) {
  applyTheme(savedTheme);
} else {
  applyTheme('light');
}
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

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
  sortBy: 'cost',
  sortDir: 'asc',
  groupBy: 'none',
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

  const provider = els.providerSearch.value.trim();
  if (provider) params.set('provider', provider);

  const model = els.modelSearch.value.trim();
  if (model) params.set('model', model);
  if (els.zdrOnly?.checked) params.set('zdr', '1');
  if (els.subscriptionOnly?.checked) params.set('sub', '1');

  if (els.promoOnly.checked) params.set('promo', '1');

  if (state.sortBy !== DEFAULTS.sortBy || state.sortDir !== DEFAULTS.sortDir) {
    params.set('sort', `${state.sortBy}:${state.sortDir}`);
  }

  if (state.costMode === 'monthly') params.set('mode', 'monthly');

  if (state.computeBy === 'budget') params.set('by', 'budget');
  const budget = els.budgetInput?.value;
  if (budget && budget !== DEFAULTS.budget) params.set('budget', budget);

  if (els.groupBy.value !== 'none') params.set('group', els.groupBy.value);

  const cacheWriteVal = parseFloat(document.getElementById('cacheWriteTokens').value) || 0;
  const amortizeVal = parseInt(document.getElementById('amortizeN').value, 10) || 1;
  if (cacheWriteVal > 0) params.set('cw', document.getElementById('cacheWriteTokens').value);
  if (amortizeVal !== 1) params.set('cwn', String(amortizeVal));

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
  els.modelSearch.value = DEFAULTS.modelSearch;
  els.promoOnly.checked = DEFAULTS.promoOnly;
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
  document.getElementById('amortizeN').value = '1';

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
  if (params.has('sort')) {
    const [by, dir] = params.get('sort').split(':');
    if (by) state.sortBy = by;
    if (dir === 'asc' || dir === 'desc') state.sortDir = dir;
  }

  const mode = params.get('mode');
  if (mode === 'monthly') setCostMode('monthly');

  const group = params.get('group');
  if (group) els.groupBy.value = group;
  if (params.has('cw')) document.getElementById('cacheWriteTokens').value = params.get('cw');
  if (params.has('budget')) els.budgetInput.value = params.get('budget');
  if (params.get('by') === 'budget') setComputeBy('budget');
  if (params.has('cwn')) document.getElementById('amortizeN').value = params.get('cwn');
}

/** Sync the URL hash to current state without adding history entries. */
function updateHash() {
  const hash = serializeState();
  const current = location.hash.slice(1);
  if (hash === current) return;
  const url = hash ? `#${hash}` : `${location.pathname}${location.search}`;
  history.replaceState(null, '', url);
}


// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('pricing.json');
    state.data = await res.json();
  } catch (err) {
    els.resultsBody.innerHTML = `<tr><td colspan="10" class="empty">Could not load pricing.json. Run <code>node scripts/fetch-pricing.mjs</code> first.</td></tr>`;
    return;
  }

  els.lastUpdated.textContent = `Data updated: ${new Date(state.data.generated_at).toLocaleString()}`;
  populateDatalists();
  deserializeState(location.hash.slice(1));
  attachListeners();
  updateCompareTray();
  computeAndRender();
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
  els.budgetInput?.addEventListener('input', () => computeAndRender());

  els.providerSearch.addEventListener('input', () => computeAndRender());
  els.modelSearch.addEventListener('input', () => computeAndRender());
  els.promoOnly.addEventListener('change', () => computeAndRender());
  if (els.zdrOnly) els.zdrOnly.addEventListener('change', () => computeAndRender());
  if (els.subscriptionOnly) els.subscriptionOnly.addEventListener('change', () => computeAndRender());
  els.groupBy.addEventListener('change', () => computeAndRender());

  els.resultsBody.addEventListener('click', (e) => {
    const header = e.target.closest('.group-header');
    if (!header) return;
    header.classList.toggle('collapsed');
    const group = header.dataset.group;
    const collapsed = header.classList.contains('collapsed');
    els.resultsBody.querySelectorAll(`tr[data-group="${CSS.escape(group)}"]:not(.group-header)`).forEach((row) => {
      row.style.display = collapsed ? 'none' : '';
    });
  });

  for (const id of ['totalTokens', 'inputPct', 'cacheReadPct', 'outputPct', 'cacheWriteTokens', 'amortizeN']) {
    els[id].addEventListener('input', () => computeAndRender());
  }

  document.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  // Sortable column headers
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sortBy === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortBy = col;
        state.sortDir = 'asc';
      }
      computeAndRender();
    });
  });

  // Mobile sort dropdown
  els.mobileSort.addEventListener('change', () => {
    const [col, dir] = els.mobileSort.value.split(':');
    state.sortBy = col;
    state.sortDir = dir;
    computeAndRender();
  });

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

  window.addEventListener('hashchange', () => {
    deserializeState(location.hash.slice(1));
    computeAndRender();
  });
}

function applyPreset(name) {
  const presets = {
    agentic:       { totalTokens: 1000, inputPct: 2.5, cacheReadPct: 97,   outputPct: 0.5 },
    balanced:      { totalTokens: 1000, inputPct: 30,  cacheReadPct: 50,   outputPct: 20 },
    'heavy-output': { totalTokens: 1000, inputPct: 10,  cacheReadPct: 0,    outputPct: 90 },
    'no-cache':     { totalTokens: 1000, inputPct: 70,  cacheReadPct: 0,    outputPct: 30 },
  };
  const p = presets[name];
  if (!p) return;
  for (const [k, v] of Object.entries(p)) els[k].value = v;
  computeAndRender();
}


// Comparison UI (compare-tray, compare-modal)
function toggleCompare(model) {
  const idx = state.compareSelection.findIndex(m => m.id === model.id && m.provider === model.provider);
  if (idx >= 0) {
    state.compareSelection.splice(idx, 1);
  } else {
    if (state.compareSelection.length >= 4) return; // max 4
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
    { label: els.costColumnHeader?.textContent || 'Total Cost', getValue: m => headlineFmt(headlineGet(m)), getRaw: headlineGet, isCost: true, isBudget: budgetMode },
  ];

  let html = '<table class="compare-table"><thead><tr><th>Metric</th>';
  for (const m of models) {
    const name = m.name && m.name !== m.id ? m.name : m.id;
    html += `<th>${esc(name)}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const row of rows) {
    html += `<tr><td class="compare-label">${row.label}</td>`;
    if (row.isCost && row.getRaw) {
      const values = models.map(m => row.getRaw(m));
      const nonNull = values.filter(v => v !== null && v !== undefined && (isFinite(v) || !row.isBudget));
      const best = nonNull.length > 0
        ? (row.isBudget ? Math.max(...nonNull) : Math.min(...nonNull))
        : null;
      for (const m of models) {
        const v = row.getRaw(m);
        const isBest = best !== null && v !== null && v !== undefined && v === best;
        html += `<td class="num${isBest ? ' compare-cheapest' : ''}">${row.getValue(m)}</td>`;
      }
    } else {
      for (const m of models) {
        html += `<td>${row.getValue(m)}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table>';

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
  const amortizeN = Math.max(1, parseInt(document.getElementById('amortizeN').value, 10) || 1);
  return {
    total, inputPct, cacheReadPct, outputPct, sum: inputPct + cacheReadPct + outputPct,
    input: total * inputPct / 100,
    cacheRead: total * cacheReadPct / 100,
    cacheWrite: cacheWriteTokens,
    amortizeN,
    output: total * outputPct / 100,
  };
}

/** cost = (tokens × $/M) / 1e6  — prices are $/M tokens */
function costFor(pricing, tokens) {
  const c = (price, tok) => (price != null ? (price * tok) / 1e6 : null);
  const inputCost = c(pricing.input, tokens.input);
  const outputCost = c(pricing.output, tokens.output);
  const cacheReadCost = c(pricing.cache_read, tokens.cacheRead);
  const cacheWriteCost = tokens.cacheWrite > 0 ? c(pricing.cache_write, tokens.cacheWrite / (tokens.amortizeN || 1)) : 0;
  if (tokens.input > 0 && inputCost === null) return null;
  if (tokens.output > 0 && outputCost === null) return null;
  if (tokens.cacheRead > 0 && cacheReadCost === null) return null;
  if (tokens.cacheWrite > 0 && cacheWriteCost === null) return null;
  return (inputCost || 0) + (outputCost || 0) + (cacheReadCost || 0) + (cacheWriteCost || 0);
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
  const crRate   = tokens.cacheReadPct> 0 ? rate(pricing.cache_read,tokens.cacheReadPct): 0;
  if (tokens.inputPct    > 0 && inRate  === null) return null;
  if (tokens.outputPct   > 0 && outRate === null) return null;
  if (tokens.cacheReadPct> 0 && crRate  === null) return null;
  // Cache-write: fixed per-session charge, amortized over N requests.
  let cwFixed = 0;
  if (tokens.cacheWrite > 0) {
    const cwPrice = pricing.cache_write;
    if (cwPrice == null) return null;
    cwFixed = (cwPrice * (tokens.cacheWrite / (tokens.amortizeN || 1))) / 1e6;
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

  // Filter offerings: AND of provider search + model search + promo filter
  // Provider search matches against inference provider (display name or raw key)
  // Model search matches against canonical model display name
  const promoOnly = els.promoOnly.checked;
  const zdrOnly = els.zdrOnly?.checked;
  const subscriptionOnly = els.subscriptionOnly?.checked;
  let offerings = state.data.models.filter((m) => {
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
    return true;
  });

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
  els.resultsTitle.textContent = title;

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
      cost: budgetMode
        ? affordabilityFor(m.pricing, tokens, perSessionBudget)
        : costFor(m.pricing, tokens),
    }))
    .filter((r) => r.cost !== null && r.cost !== undefined)
    .map((r) => ({ ...r, cost: r.cost * modeMultiplier }));

  // Sort by current sort column
  sortRows(rows);

  // Update sort indicator on headers
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortBy) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });

  // Sync mobile sort dropdown
  els.mobileSort.value = `${state.sortBy}:${state.sortDir}`;

  state.currentRows = rows;
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

function fmtPrice(p) {
  if (p === null || p === undefined) return `<span class="missing">—</span>`;
  if (p === 0) return `<span class="cost-zero">Free</span>`;
  if (p < 0.01) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(2)}`;
}

function fmtCost(c) {
  if (c === null) return `<span class="missing">N/A</span>`;
  if (c === 0) return `<span class="cost-zero">$0.00</span>`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/** Sort rows by the current sort column/direction. Null values always sort to END. */
function sortRows(rows) {
  const { sortBy, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let va, vb;
    switch (sortBy) {
      case 'org':       va = orgDisplay(a.model.org).toLowerCase(); vb = orgDisplay(b.model.org).toLowerCase(); break;
      case 'provider':  va = providerName(a.model.provider, a.model.provider_display).toLowerCase(); vb = providerName(b.model.provider, b.model.provider_display).toLowerCase(); break;
      case 'model':     va = a.model.name?.toLowerCase() || a.model.id.toLowerCase(); vb = b.model.name?.toLowerCase() || b.model.id.toLowerCase(); break;
      case 'input':     va = a.model.pricing.input; vb = b.model.pricing.input; break;
      case 'output':    va = a.model.pricing.output; vb = b.model.pricing.output; break;
      case 'cache_read':va = a.model.pricing.cache_read; vb = b.model.pricing.cache_read; break;
      case 'cache_write': va = a.model.pricing.cache_write; vb = b.model.pricing.cache_write; break;
      case 'context':   va = a.model.context_length; vb = b.model.context_length; break;
      case 'cost':
      default:          va = a.cost; vb = b.cost; break;
    }
    // Null/undefined values always sort to the END, regardless of direction
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
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

function renderProviderCell(r) {
  const name = providerName(r.model.provider, r.model.provider_display);
  const zdrBadge = r.model.zdr ? ' <span class="zdr-badge" title="Zero Data Retention — provider does not store prompts">ZDR</span>' : '';
  const subBadge = r.model.subscription ? ' <span class="subscription-badge" title="This provider offers subscription/coding plans">Sub</span>' : '';
  return `<span class="provider-badge">${esc(name)}</span>${zdrBadge}${subBadge}${providerMetaHtml(r.model.provider)}`;
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
  const checkbox = `<input type="checkbox" class="compare-check" data-idx="${rowIdx}" ${isSelected ? 'checked' : ''}${state.compareSelection.length >= 4 && !isSelected ? ' disabled' : ''}>`;
  return `<tr${groupAttr}>
    <td class="rank" data-label="#">${checkbox} ${rank}${cheapest ? ' 🏆' : ''}</td>
    <td data-label="Org"><span class="org-badge">${esc(orgDisplay(r.model.org))}</span></td>
    <td data-label="Provider">${renderProviderCell(r)}</td>
    <td data-label="Model">${esc(modelDisplay)}${promo}</td>
    <td class="num" data-label="Input $/M">${fmtPrice(p.input)}</td>
    <td class="num" data-label="Output $/M">${fmtPrice(p.output)}</td>
    <td class="num" data-label="Cache Read $/M">${fmtPrice(p.cache_read)}</td>
    <td class="num" data-label="Cache Write $/M">${fmtPrice(p.cache_write)}</td>
    <td class="num" data-label="Context">${fmtContext(r.model.context_length)}</td>
    <td class="num cost" data-label="${esc(els.costColumnHeader.textContent)}">${state.computeBy === 'budget' ? fmtAffordability(r.cost) : fmtCost(r.cost)}</td>
  </tr>`;
}

function renderFlatTable(rows, tokens) {
  const best = globalBestValue(rows);
  els.resultsBody.innerHTML = rows
    .map((r, i) => {
      const isBest = best !== null && r.cost != null && r.cost === best;
      return renderModelRow(r, i + 1, undefined, isBest);
    })
    .join('');
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
    html += `<tr class="group-header" data-group="${esc(key)}">
      <td colspan="10">
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

function renderTable(rows, tokens) {
  if (rows.length === 0) {
    els.resultsBody.innerHTML = `<tr><td colspan="10" class="empty">No offerings match your criteria. Some providers may not support the token types you entered.</td></tr>`;
    return;
  }
  const groupBy = els.groupBy?.value || 'none';
  state.groupBy = groupBy;
  if (groupBy === 'none') {
    renderFlatTable(rows, tokens);
  } else {
    renderGroupedTable(rows, tokens, groupBy);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
init();
