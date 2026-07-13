// TokenWatch — video-app.js
// Loads video-pricing.json, computes per-second costs, renders sortable table.

// Shared helpers live in shared-ui.js (window.TW), loaded before this script.
const { esc, median, debounce } = window.TW;
const { fmtPrice, fmtCost } = window.TW.makeFormatters({ style: 'tiered', missingCost: '—' });

const state = {
  data: null,
  providerSearch: '',
  modelSearch: '',
  videoSeconds: 60,
  resolutionFilter: '',
  audioFilter: '',
  sortBy: 'cost',
  sortDir: 'asc',
  computeBy: 'tokens',
  compareSelection: [], // row objects ({ model, pricing, resolution, audio }), not bare models
  currentRows: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  providerSearch: $('providerSearch'),
  modelSearch: $('modelSearch'),
  orgList: $('orgList'),
  modelList: $('modelList'),
  videoSeconds: $('videoSeconds'),
  resolutionFilter: $('resolutionFilter'),
  audioFilter: $('audioFilter'),
  resultsBody: $('resultsBody'),
  resultsTitle: $('resultsTitle'),
  mobileSort: $('mobileSort'),
  byTokens: $('byTokens'),
  byBudget: $('byBudget'),
  budgetInput: $('budgetInput'),
  budgetField: $('budgetField'),
  countField: $('countField'),
  countLabel: $('countLabel'),
  budgetLabel: $('budgetLabel'),
  costColumnHeader: $('costColumnHeader'),
  compareTray: $('compareTray'),
  compareCount: $('compareCount'),
  compareBtn: $('compareBtn'),
  compareClear: $('compareClear'),
  compareModal: $('compareModal'),
  compareClose: $('compareClose'),
  compareBody: $('compareBody'),
  benchmarkBar: $('benchmarkBar'),
};

const DEFAULTS = {
  videoSeconds: 60,
  budget: '20',
  computeBy: 'tokens',
};

// ── Theme toggle ──────────────────────────────────────────────────────────────
TW.initTheme();

// ── Helpers ───────────────────────────────────────────────────────────────────
function orgDisplay(org) {
  const known = { 'z-ai':'Z.ai', 'openai':'OpenAI', 'deepseek':'DeepSeek', 'meta':'Meta', 'google':'Google',
    'anthropic':'Anthropic', 'mistral':'Mistral', 'moonshot':'Moonshot', 'minimax':'MiniMax', 'nvidia':'NVIDIA',
    'bytedance':'ByteDance', 'nous':'Nous', 'ibm':'IBM', 'stepfun':'StepFun', 'xiaomi':'Xiaomi',
    'black-forest-labs':'Black Forest Labs', 'kling':'Kling', 'sourceful':'Sourceful', 'recraft':'Recraft',
    'xai':'xAI', 'alibaba':'Alibaba', 'microsoft':'Microsoft' };
  return known[org] || org.charAt(0).toUpperCase() + org.slice(1);
}

function fmtAffordability(n) {
  if (n === null || n === undefined) return '<span class="missing">N/A</span>';
  if (!isFinite(n)) return '<span class="cost-zero" title="Free offering — budget covers unlimited">∞</span>';
  if (n === 0) return '<span class="cost-zero">0</span>';
  if (n < 1) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}


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

  const noun = rows.length === 1 ? 'model' : 'models';

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
  const unit = budget ? ' sec' : '/sec';

  let html = `<strong>Median ${fmt(med)}${unit}</strong>` +
    ` <span class="bench-sep">·</span> mean ${fmt(mean)}` +
    ` <span class="bench-sep">·</span> range ${fmt(min)}–${fmt(max)}`;
  if (free > 0) html += ` <span class="bench-sep">·</span> ${free} free`;
  bar.innerHTML = html;
}

function costFor(pricing, seconds) {
  return seconds * pricing.cost_per_second;
}

function affordabilityFor(pricing, budget) {
  const costPerSecond = pricing.cost_per_second;
  if (costPerSecond === null || costPerSecond === undefined) return null;
  if (budget <= 0) return null;
  if (costPerSecond <= 0) return Infinity;
  return budget / costPerSecond;
}

function setComputeBy(mode) {
  state.computeBy = mode;
  els.byTokens?.classList.toggle('active', mode === 'tokens');
  els.byBudget?.classList.toggle('active', mode === 'budget');
  const showBudget = mode === 'budget';
  els.countField.style.display = showBudget ? 'none' : '';
  els.budgetField.style.display = showBudget ? '' : 'none';
  if (state.sortBy === 'cost') {
    state.sortDir = mode === 'budget' ? 'desc' : 'asc';
  }
  updateLabelsAndHeaders();
  computeAndRender();
}

function updateLabelsAndHeaders() {
  const budget = state.computeBy === 'budget';
  if (budget) {
    els.budgetLabel.textContent = 'Budget';
    els.costColumnHeader.textContent = 'Affordable Seconds';
  } else {
    els.countLabel.textContent = 'Video duration (seconds)';
    els.costColumnHeader.textContent = 'Total Cost';
  }
  const costAscOpt = els.mobileSort.querySelector('option[value="cost:asc"]');
  const costDescOpt = els.mobileSort.querySelector('option[value="cost:desc"]');
  if (costAscOpt) costAscOpt.textContent = budget ? 'Affordable Seconds ↑' : 'Total Cost ↑';
  if (costDescOpt) costDescOpt.textContent = budget ? 'Affordable Seconds ↓' : 'Total Cost ↓';
}

function resLabel(r) { return r ? r.toUpperCase() : '\u2014'; }
function audioLabel(a) {
  if (a === true) return '\uD83D\uDD0A Yes';
  if (a === false) return '\uD83D\uDD07 No';
  return '\u2014';
}

// ── Data ──────────────────────────────────────────────────────────────────────
function buildRows() {
  if (!state.data) return [];
  const provSearch = state.providerSearch.toLowerCase();
  const modSearch = state.modelSearch.toLowerCase();
  const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, ' ');
  const rows = [];
  for (const m of state.data.models) {
    if (provSearch) {
      const orgName = orgDisplay(m.org).toLowerCase();
      if (!orgName.includes(provSearch) && !m.org.toLowerCase().includes(provSearch) &&
          !(m.provider && m.provider.toLowerCase().includes(provSearch))) continue;
    }
    if (modSearch) {
      const q = norm(modSearch);
      const modDisplay = norm(m.name || m.id);
      const rawId = norm(m.id.split('/').slice(-1)[0]);
      if (!modDisplay.includes(q) && !rawId.includes(q)) continue;
    }
    for (const p of m.pricing) {
      if (state.resolutionFilter && p.resolution !== state.resolutionFilter) continue;
      // Audio filter: "With audio" = strictly audio===true; "Without / no audio"
      // = anything not strictly true (includes null + false). null means the SKU
      // has no audio dimension — it survives "Without / no audio" so models like
      // Sora 2 Pro, Grok Imagine, Wan 2.6/2.7 don't vanish from the catalog.
      if (state.audioFilter === 'true' && p.audio !== true) continue;
      if (state.audioFilter === 'false' && p.audio === true) continue;
      rows.push({
        model: m,
        pricing: p,
        resolution: p.resolution,
        audio: p.audio,
      });
    }
  }
  return rows;
}

function populateFilters() {
  const resolutions = new Set();
  const hasAudioTrue = { found: false };
  const hasAudioFalse = { found: false };
  for (const m of state.data.models) {
    for (const p of m.pricing) {
      if (p.resolution) resolutions.add(p.resolution);
      if (p.audio === true) hasAudioTrue.found = true;
      if (p.audio === false) hasAudioFalse.found = true;
    }
  }
  els.resolutionFilter.innerHTML = '<option value="">All resolutions</option>' +
    [...resolutions].sort().map(r => `<option value="${r}">${r.toUpperCase()}</option>`).join('');

  // Audio filter already has static options in HTML, just show/hide
}

function populateDatalists() {
  const orgCounts = {};
  const modelNames = new Set();
  for (const m of state.data.models) {
    const name = orgDisplay(m.org);
    orgCounts[name] = (orgCounts[name] || 0) + 1;
    modelNames.add(m.name || m.id);
  }
  els.orgList.innerHTML = Object.keys(orgCounts)
    .sort((a, b) => orgCounts[b] - orgCounts[a])
    .map((name) => `<option value="${name}">${name} (${orgCounts[name]})</option>`)
    .join('');
  els.modelList.innerHTML = [...modelNames].sort()
    .map((name) => `<option value="${name}">`)
    .join('');
}

// ── Sorting ───────────────────────────────────────────────────────────────────
function sortRows(rows) {
  const { sortBy, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let va, vb;
    switch (sortBy) {
      case 'org': va = a.model.org; vb = b.model.org; break;
      case 'model': va = (a.model.name || a.model.id).toLowerCase(); vb = (b.model.name || b.model.id).toLowerCase(); break;
      case 'resolution': va = a.resolution || ''; vb = b.resolution || ''; break;
      case 'audio': va = a.audio === true ? 1 : a.audio === false ? 0 : -1; vb = b.audio === true ? 1 : b.audio === false ? 0 : -1; break;
      case 'cost_per_second': va = a.pricing.cost_per_second; vb = b.pricing.cost_per_second; break;
      case 'cost':
      default: va = a.cost; vb = b.cost; break;
    }
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}


function rowCompareKey(r) {
  // Key the pricing row — same model can have multiple resolution/audio variants
  return `${r.model.id}\0${r.model.provider || ''}\0${r.resolution || ''}\0${String(r.audio)}`;
}

function syncCompareSelectionFromRows(rows) {
  if (state.compareSelection.length === 0) return;
  state.compareSelection = state.compareSelection.map((sel) => {
    const key = rowCompareKey(sel);
    return rows.find((r) => rowCompareKey(r) === key) || sel;
  });
}

// Comparison UI (compare-tray, compare-modal)
function toggleCompare(row) {
  const key = rowCompareKey(row);
  const idx = state.compareSelection.findIndex((r) => rowCompareKey(r) === key);
  if (idx >= 0) {
    state.compareSelection.splice(idx, 1);
  } else {
    if (state.compareSelection.length >= 6) return;
    state.compareSelection.push(row);
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
  const budgetMode = state.computeBy === 'budget';
  const budgetVal = budgetMode ? Math.max(0, parseFloat(els.budgetInput?.value) || 0) : 0;
  const secondsVal = Math.max(1, parseInt(els.videoSeconds?.value, 10) || state.videoSeconds || 60);
  const selected = state.compareSelection;

  const headlineGet = (r) => budgetMode
    ? affordabilityFor(r.pricing, budgetVal)
    : costFor(r.pricing, secondsVal);
  const headlineFmt = (v) => budgetMode ? fmtAffordability(v) : fmtCost(v);

  const metricRows = [
    { label: 'Org', getValue: (r) => esc(orgDisplay(r.model.org)) },
    { label: 'Model', getValue: (r) => esc(r.model.name || r.model.id) },
    { label: 'Resolution', getValue: (r) => resLabel(r.resolution) },
    { label: 'Audio', getValue: (r) => audioLabel(r.audio) },
    { label: '$/Sec', getValue: (r) => fmtPrice(r.pricing.cost_per_second), getRaw: (r) => r.pricing.cost_per_second, isCost: true },
    { label: els.costColumnHeader?.textContent || 'Total Cost', getValue: (r) => headlineFmt(headlineGet(r)), getRaw: headlineGet, isCost: true, isBudget: budgetMode },
  ];

  const snapshot = budgetMode
    ? `<strong>Budget $${budgetVal.toLocaleString()}</strong>`
    : `<strong>${secondsVal.toLocaleString()} seconds</strong>`;
  const snapshotHtml = `<div class="compare-snapshot"><span class="snapshot-label">Basis:</span> ${snapshot}</div>`;

  let html = snapshotHtml + '<table class="compare-table"><thead><tr><th>Metric</th>';
  for (const r of selected) {
    const name = r.model.name || r.model.id;
    const variantSuffix = r.resolution ? ` · ${resLabel(r.resolution)}` : '';
    const audioSuffix = r.audio === true ? ' · audio' : r.audio === false ? ' · no audio' : '';
    html += `<th>${esc(name + variantSuffix + audioSuffix)}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const row of metricRows) {
    html += `<tr><td class="compare-label">${row.label}</td>`;
    if (row.isCost && row.getRaw) {
      const values = selected.map((r) => row.getRaw(r));
      const nonNull = values.filter((v) => v != null && (row.isBudget ? v === Infinity || isFinite(v) : isFinite(v)));
      const best = nonNull.length > 0
        ? (row.isBudget ? Math.max(...nonNull) : Math.min(...nonNull))
        : null;
      for (const r of selected) {
        const v = row.getRaw(r);
        const isBest = best !== null && v != null && v !== undefined && v === best;
        html += `<td class="num${isBest ? ' compare-cheapest' : ''}">${row.getValue(r)}</td>`;
      }
    } else {
      for (const r of selected) {
        html += `<td>${row.getValue(r)}</td>`;
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

function renderModelRow(r, rank, isBest) {
  const budgetMode = state.computeBy === 'budget';
  const costLabel = esc(els.costColumnHeader.textContent);
  const costCell = budgetMode ? fmtAffordability(r.cost) : fmtCost(r.cost);
  const isSelected = state.compareSelection.some((x) => rowCompareKey(x) === rowCompareKey(r));
  const rowIdx = state.currentRows
    ? state.currentRows.findIndex((x) => rowCompareKey(x) === rowCompareKey(r))
    : rank - 1;
  const checkbox = `<input type="checkbox" class="compare-check" data-idx="${rowIdx}" ${isSelected ? 'checked' : ''}${state.compareSelection.length >= 6 && !isSelected ? ' disabled' : ''}>`;
  return `<tr>
    <td class="rank" data-label="#">${checkbox} ${rank}${isBest ? ' \u{1F3C6}' : ''}</td>
    <td data-label="Org"><span class="org-badge">${esc(orgDisplay(r.model.org))}</span></td>
    <td data-label="Model">${esc(r.model.name || r.model.id)}</td>
    <td data-label="Resolution">${resLabel(r.resolution)}</td>
    <td data-label="Audio">${audioLabel(r.audio)}</td>
    <td class="num" data-label="$/Sec">${fmtPrice(r.pricing.cost_per_second)}</td>
    <td class="num cost" data-label="${costLabel}">${costCell}</td>
  </tr>`;
}

function globalBestValue(rows) {
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

// ── Rendering ─────────────────────────────────────────────────────────────────
function computeAndRender() {
  if (!state.data) return;
  state.providerSearch = els.providerSearch.value.trim();
  state.modelSearch = els.modelSearch.value.trim();
  state.videoSeconds = Math.max(1, parseInt(els.videoSeconds.value, 10) || 60);
  state.resolutionFilter = els.resolutionFilter.value;
  state.audioFilter = els.audioFilter.value;

  const budgetMode = state.computeBy === 'budget';
  const budgetVal = budgetMode ? Math.max(0, parseFloat(els.budgetInput?.value) || 0) : 0;

  let rows = buildRows().map((r) => ({
    ...r,
    cost: budgetMode
      ? affordabilityFor(r.pricing, budgetVal)
      : costFor(r.pricing, state.videoSeconds),
  }));
  if (budgetMode) {
    rows = rows.filter((r) => r.cost !== null && r.cost !== undefined);
  }

  sortRows(rows);
  syncCompareSelectionFromRows(rows);

  const parts = [];
  if (state.providerSearch) parts.push(`from '${state.providerSearch}'`);
  if (state.modelSearch) parts.push(`matching '${state.modelSearch}'`);
  if (state.resolutionFilter) parts.push(state.resolutionFilter.toUpperCase());
  if (state.audioFilter === 'true') parts.push('with audio');
  else if (state.audioFilter === 'false') parts.push('without/no audio');
  els.resultsTitle.textContent = parts.length > 0
    ? `Video models (${parts.join(', ')}) \u2014 ${rows.length} results`
    : `All video generation models \u2014 ${rows.length} results`;

  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortBy) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });

  updateLabelsAndHeaders();
  els.mobileSort.value = `${state.sortBy}:${state.sortDir}`;

  state.currentRows = rows;
  renderBenchmarkBox(rows);

  if (rows.length === 0) {
    els.resultsBody.innerHTML = '<tr><td colspan="7" class="empty">No models match your criteria.</td></tr>';
    updateHash();
    return;
  }

  const best = globalBestValue(rows);
  els.resultsBody.innerHTML = rows
    .map((r, i) => {
      const isBest = best !== null && r.cost != null && r.cost === best;
      return renderModelRow(r, i + 1, isBest);
    })
    .join('');

  updateHash();
}

// ── URL hash state ────────────────────────────────────────────────────────────
function updateHash() {
  const params = new URLSearchParams();
  if (state.providerSearch) params.set('p', state.providerSearch);
  if (state.modelSearch) params.set('m', state.modelSearch);
  if (state.videoSeconds !== DEFAULTS.videoSeconds) params.set('sec', state.videoSeconds);
  if (state.resolutionFilter) params.set('res', state.resolutionFilter);
  if (state.audioFilter !== '') params.set('audio', state.audioFilter);
  if (state.sortBy !== 'cost' || state.sortDir !== 'asc') params.set('sort', `${state.sortBy}:${state.sortDir}`);
  if (state.computeBy === 'budget') params.set('by', 'budget');
  const budget = els.budgetInput?.value;
  if (budget && budget !== DEFAULTS.budget) params.set('budget', budget);
  const hash = params.toString();
  history.replaceState(null, '', hash ? '#' + hash : window.location.pathname);
}

function deserializeState(hash) {
  const params = new URLSearchParams(hash);
  state.providerSearch = '';
  state.modelSearch = '';
  state.videoSeconds = DEFAULTS.videoSeconds;
  state.resolutionFilter = '';
  state.audioFilter = '';
  state.sortBy = 'cost';
  state.sortDir = 'asc';
  state.computeBy = 'tokens';
  els.providerSearch.value = '';
  els.modelSearch.value = '';
  els.videoSeconds.value = DEFAULTS.videoSeconds;
  els.budgetInput.value = DEFAULTS.budget;
  els.byTokens?.classList.toggle('active', true);
  els.byBudget?.classList.toggle('active', false);
  els.countField.style.display = '';
  els.budgetField.style.display = 'none';
  updateLabelsAndHeaders();

  const prov = params.get('p');
  if (prov) { state.providerSearch = prov; els.providerSearch.value = prov; }
  const mod = params.get('m');
  if (mod) { state.modelSearch = mod; els.modelSearch.value = mod; }
  const sec = parseInt(params.get('sec'), 10);
  if (sec > 0) { state.videoSeconds = sec; els.videoSeconds.value = sec; }
  const res = params.get('res');
  if (res) { state.resolutionFilter = res; }
  const audio = params.get('audio');
  if (audio === 'true' || audio === 'false') { state.audioFilter = audio; }
  const sort = params.get('sort');
  if (sort) { const [by, dir] = sort.split(':'); state.sortBy = by; state.sortDir = dir || 'asc'; }
  if (params.has('budget')) els.budgetInput.value = params.get('budget');
  if (params.get('by') === 'budget') {
    state.computeBy = 'budget';
    els.byTokens?.classList.toggle('active', false);
    els.byBudget?.classList.toggle('active', true);
    els.countField.style.display = 'none';
    els.budgetField.style.display = '';
    if (state.sortBy === 'cost') state.sortDir = 'desc';
    updateLabelsAndHeaders();
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
function attachListeners() {
  const debouncedRender = debounce(() => computeAndRender());
  els.providerSearch.addEventListener('input', debouncedRender);
  els.modelSearch.addEventListener('input', debouncedRender);
  els.videoSeconds.addEventListener('input', debouncedRender);
  els.budgetInput?.addEventListener('input', debouncedRender);
  els.resolutionFilter.addEventListener('change', () => computeAndRender());
  els.audioFilter.addEventListener('change', () => computeAndRender());
  els.byTokens?.addEventListener('click', () => setComputeBy('tokens'));
  els.byBudget?.addEventListener('click', () => setComputeBy('budget'));

  document.querySelectorAll('th.sortable').forEach(th => {
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
  els.mobileSort.addEventListener('change', () => {
    const [col, dir] = els.mobileSort.value.split(':');
    state.sortBy = col;
    state.sortDir = dir;
    computeAndRender();
  });

  els.resultsBody.addEventListener('change', (e) => {
    if (!e.target.classList.contains('compare-check')) return;
    const idx = parseInt(e.target.dataset.idx, 10);
    const row = state.currentRows?.[idx];
    if (row) toggleCompare(row);
  });
  els.compareBtn.addEventListener('click', showCompareModal);
  els.compareClose.addEventListener('click', closeCompareModal);
  els.compareClear.addEventListener('click', clearCompare);
  els.compareModal.addEventListener('click', (e) => {
    if (e.target === els.compareModal) closeCompareModal();
  });

  window.addEventListener('hashchange', () => {
    deserializeState(location.hash.slice(1));
    els.resolutionFilter.value = state.resolutionFilter;
    els.audioFilter.value = state.audioFilter;
    computeAndRender();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('video-pricing.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    populateFilters();
    populateDatalists();
    deserializeState(location.hash.slice(1));
    els.resolutionFilter.value = state.resolutionFilter;
    els.audioFilter.value = state.audioFilter;
    attachListeners();
    computeAndRender();
  } catch (err) {
    els.resultsBody.innerHTML = `<tr><td colspan="7" class="empty">Failed to load pricing data: ${esc(err.message)}</td></tr>`;
  }
}

init();
