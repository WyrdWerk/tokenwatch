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
};

// Flat-table render cap: first paint shows this many rows + a "Show all" row.
// data-idx is resolved via findIndex against the full state.currentRows, so a
// head slice keeps detail-modal/compare indices correct for visible rows.
const ROW_CAP = 250;

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
  modePerRequest: $('modePerRequest'),
  modeMonthly: $('modeMonthly'),
  totalTokensLabel: $('totalTokensLabel'),
  totalTokensHint: $('totalTokensHint'),
  costColumnHeader: $('costColumnHeader'),
  speedColumnHeader: $('speedColumnHeader'),
  showOrg: $('showOrg'),
  groupBy: $('groupBy'),
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
  if (els.showOrg?.checked) params.set('orgcol', '1');

  const cacheWriteVal = parseFloat(document.getElementById('cacheWriteTokens').value) || 0;
  const amortizeVal = parseInt(document.getElementById('amortizeN').value, 10) || 100;
  if (cacheWriteVal > 0) params.set('cw', document.getElementById('cacheWriteTokens').value);
  if (amortizeVal !== 100) params.set('cwn', String(amortizeVal));

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
  if (els.subscriptionOnly) els.subscriptionOnly.checked = DEFAULTS.subscriptionOnly;
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
  if (params.has('orgcol') && els.showOrg) { els.showOrg.checked = params.get('orgcol') === '1'; document.getElementById('resultsTable').classList.toggle('hide-org', !els.showOrg.checked); }
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

/** Format an ISO timestamp as IST (Asia/Kolkata). Returns — on invalid input. */


// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('pricing.json');
    state.data = await res.json();
  } catch (err) {
    els.resultsBody.innerHTML = `<tr><td colspan="${els.showOrg?.checked ? 10 : 9}" class="empty error-state">
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
  if (els.subscriptionOnly) els.subscriptionOnly.addEventListener('change', onFilterChange);
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

    // Section: Quality (only if benchmark data exists)
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
  parts.push('</div>');

  els.detailTitle.textContent = r.name || r.id;
  els.detailBody.innerHTML = parts.join('');
  els.detailModal.style.display = '';

  // Wire footer actions + copy buttons
  const addBtn = document.getElementById('detailAddCompare');
  if (addBtn) addBtn.addEventListener('click', () => { closeDetailModal(); toggleCompare(r); });
  for (const btn of els.detailBody.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy, btn));
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

  let html = snapshotHtml + '<table class="compare-table"><thead><tr><th>Metric</th>';
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
function costFor(pricing, tokens) {
  const c = (price, tok) => (price != null ? (price * tok) / 1e6 : null);
  const inputCost = c(pricing.input, tokens.input);
  const outputCost = c(pricing.output, tokens.output);
  // Cache-read null → fall back to input price (model offers no cache discount)
  const cacheReadCost = c(pricing.cache_read != null ? pricing.cache_read : pricing.input, tokens.cacheRead);
  // Cache-write null → $0 (do NOT filter the model)
  const cacheWriteCost = tokens.cacheWrite > 0 && pricing.cache_write != null
    ? (pricing.cache_write * (tokens.cacheWrite / (tokens.amortizeN || 1))) / 1e6
    : 0;
  if (tokens.input > 0 && inputCost === null) return null;
  if (tokens.output > 0 && outputCost === null) return null;
  return (inputCost || 0) + (outputCost || 0) + (cacheReadCost || 0) + cacheWriteCost;
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
  bar.innerHTML = html;
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
    if (promoOnly && !(m.discount > 0)) return false;
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
      case 'context':   va = a.model.context_length; vb = b.model.context_length; break;
      case 'speed':     va = getPerfData(a)?.throughput?.p50 ?? null; vb = getPerfData(b)?.throughput?.p50 ?? null; break;
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

/** Shared perf-data lookup — used by renderSpeedCell and sortRows. */
function getPerfData(r) {
  if (!state.perfData) return null;
  const key = canonicalModelId(r.model.id) + '|' + r.model.provider;
  return state.perfData[key] || null;
}

function renderProviderCell(r) {
    const name = providerName(r.model.provider, r.model.provider_display);
    const zdrBadge = r.model.zdr ? ' <span class="zdr-badge" title="Zero Data Retention — provider does not store prompts">ZDR</span>' : '';
    const subBadge = r.model.subscription ? ' <span class="subscription-badge" title="This provider offers subscription/coding plans">Sub</span>' : '';
    return '<span class="provider-badge">' + esc(name) + '</span>' + zdrBadge + subBadge + providerMetaHtml(r.model.provider);
  }

/** Render the Speed column cell — throughput only (higher = faster).
 *  Latency (ms, lower = better) is shown in the detail modal, not the table,
 *  to avoid mixing opposite-direction metrics in one column. */
function renderSpeedCell(r) {
    const perf = getPerfData(r);
    const tps = perf?.throughput?.p50;
    if (tps == null) return '<span class="missing">—</span>';
    const t = perf.throughput;
    const r1 = (v) => v != null ? Math.round(v * 10) / 10 : '—';
    const title = `Throughput p50/p75/p90/p99: ${r1(t.p50)}/${r1(t.p75)}/${r1(t.p90)}/${r1(t.p99)} tps`;
    return '<span class="perf-pill" title="' + esc(title) + '">⚡' + esc(String(r1(tps))) + 'tps</span>';
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
    const colCount = els.showOrg?.checked ? 10 : 9;
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
    const colCount = els.showOrg?.checked ? 10 : 9;
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

function renderTable(rows, tokens) {
  if (rows.length === 0) {
    const colCount = els.showOrg?.checked ? 10 : 9;
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
}

// ── Boot ───────────────────────────────────────────────────────────────────────
init();
