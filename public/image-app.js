// TokenWatch — image-app.js
// Loads image-pricing.json, computes per-unit costs, renders sortable table.
// Handles unit types: image (flat per-image), megapixel (per-MP), token (per-image-token).

const state = {
  data: null,
  providerSearch: '',
  modelSearch: '',
  imageCount: 100,
  variantFilter: '',
  flatOnly: false,
  sortBy: 'cost',
  sortDir: 'asc',
  computeBy: 'tokens',
};

const $ = (id) => document.getElementById(id);
const els = {
  providerSearch: $('providerSearch'),
  modelSearch: $('modelSearch'),
  orgList: $('orgList'),
  modelList: $('modelList'),
  imageCount: $('imageCount'),
  variantFilter: $('variantFilter'),
  flatOnly: $('flatOnly'),
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
};

const DEFAULTS = {
  imageCount: 100,
  budget: '20',
  computeBy: 'tokens',
};

// ── Theme toggle ──────────────────────────────────────────────────────────────
const themeToggle = document.getElementById('themeToggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('tw-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '\u2600' : '\u263E';
}
const savedTheme = localStorage.getItem('tw-theme');
applyTheme(savedTheme || 'light');
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function orgDisplay(org) {
  const known = { 'z-ai':'Z.ai', 'openai':'OpenAI', 'deepseek':'DeepSeek', 'meta':'Meta', 'google':'Google',
    'anthropic':'Anthropic', 'mistral':'Mistral', 'moonshot':'Moonshot', 'minimax':'MiniMax', 'nvidia':'NVIDIA',
    'bytedance':'ByteDance', 'nous':'Nous', 'ibm':'IBM', 'stepfun':'StepFun', 'xiaomi':'Xiaomi',
    'black-forest-labs':'Black Forest Labs', 'kling':'Kling', 'sourceful':'Sourceful', 'recraft':'Recraft',
    'xai':'xAI', 'alibaba':'Alibaba', 'microsoft':'Microsoft' };
  return known[org] || org.charAt(0).toUpperCase() + org.slice(1);
}

function fmtPrice(p) {
  if (p === null || p === undefined) return '<span class="missing">\u2014</span>';
  if (p === 0) return '<span class="cost-zero">Free</span>';
  if (p < 0.01) return '$' + p.toFixed(4);
  if (p < 1) return '$' + p.toFixed(4);
  return '$' + p.toFixed(2);
}

function fmtCost(c) {
  if (c === null) return '<span class="missing">varies</span>';
  if (c === 0) return '<span class="cost-zero">$0.00</span>';
  if (c < 0.01) return '$' + c.toFixed(4);
  if (c < 1) return '$' + c.toFixed(4);
  return '$' + c.toFixed(2);
}

function fmtAffordability(n) {
  if (n === null || n === undefined) return '<span class="missing">N/A</span>';
  if (!isFinite(n)) return '<span class="cost-zero" title="Free offering — budget covers unlimited">∞</span>';
  if (n === 0) return '<span class="cost-zero">0</span>';
  if (n < 1) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}

function costForImage(pricing, imageCount) {
  if (pricing.unit === 'image') return imageCount * pricing.cost_per_unit;
  return null;
}

function affordabilityFor(pricing, budget) {
  const unit = pricing.unit;
  if (unit === 'megapixel' || unit === 'token') return null;
  if (unit !== 'image') return null;
  const costPerImage = pricing.cost_per_unit;
  if (costPerImage == null) return null;
  if (budget <= 0) return null;
  if (costPerImage <= 0) return Infinity;
  return budget / costPerImage;
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
    els.costColumnHeader.textContent = 'Affordable Images';
  } else {
    els.countLabel.textContent = 'Image count';
    els.costColumnHeader.textContent = 'Total Cost';
  }
  const costAscOpt = els.mobileSort.querySelector('option[value="cost:asc"]');
  const costDescOpt = els.mobileSort.querySelector('option[value="cost:desc"]');
  if (costAscOpt) costAscOpt.textContent = budget ? 'Affordable Images ↑' : 'Total Cost ↑';
  if (costDescOpt) costDescOpt.textContent = budget ? 'Affordable Images ↓' : 'Total Cost ↓';
}

// ── Data ──────────────────────────────────────────────────────────────────────
function providerMatchesSearch(m, provSearch) {
  const provName = orgDisplay(m.org).toLowerCase();
  return provName.includes(provSearch) || m.org.toLowerCase().includes(provSearch) || m.provider.toLowerCase().includes(provSearch);
}

function modelMatchesSearch(m, modSearch) {
  const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, ' ');
  const q = norm(modSearch);
  const modDisplay = norm(m.name || m.id);
  const rawId = norm(m.id.split('/').slice(-1)[0]);
  return modDisplay.includes(q) || rawId.includes(q);
}

function buildRows() {
  if (!state.data) return [];
  const provSearch = state.providerSearch.trim().toLowerCase();
  const modSearch = state.modelSearch.trim().toLowerCase();
  const rows = [];
  for (const m of state.data.models) {
    if (provSearch && !providerMatchesSearch(m, provSearch)) continue;
    if (modSearch && !modelMatchesSearch(m, modSearch)) continue;
    for (const p of m.pricing) {
      if (state.variantFilter && p.variant !== state.variantFilter) continue;
      if (state.flatOnly && p.unit === 'token') continue;
      const displayPrice = p.unit === 'token' ? p.cost_per_million : p.cost_per_unit;
      const displayUnit = p.unit === 'token' ? 'token ($/M)' : p.unit;
      rows.push({ model: m, pricing: p, costPerUnit: displayPrice, unit: displayUnit, variant: p.variant, rawUnit: p.unit });
    }
  }
  return rows;
}

function populateVariants() {
  const variants = new Set();
  for (const m of state.data.models) {
    for (const p of m.pricing) { if (p.variant) variants.add(p.variant); }
  }
  els.variantFilter.innerHTML = '<option value="">All variants</option>' +
    [...variants].sort().map(v => `<option value="${v}">${v.toUpperCase()}</option>`).join('');
}

function populateDatalists() {
  const provCounts = {};
  for (const m of state.data.models) {
    const name = orgDisplay(m.org);
    provCounts[name] = (provCounts[name] || 0) + 1;
  }
  els.orgList.innerHTML = Object.keys(provCounts)
    .sort((a, b) => provCounts[b] - provCounts[a])
    .map((name) => `<option value="${name}">${name} (${provCounts[name]})</option>`)
    .join('');

  const modelNames = new Set();
  for (const m of state.data.models) {
    modelNames.add(m.name || m.id);
  }
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
      case 'cost_per_unit':
        // Group by unit type first, then sort within group
        if (a.rawUnit !== b.rawUnit) return (a.rawUnit || '').localeCompare(b.rawUnit || '');
        va = a.costPerUnit; vb = b.costPerUnit;
        break;
      case 'cost': default: va = a.cost; vb = b.cost; break;
    }
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
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
  state.providerSearch = els.providerSearch.value;
  state.modelSearch = els.modelSearch.value;
  state.imageCount = Math.max(1, parseInt(els.imageCount.value, 10) || 100);
  state.variantFilter = els.variantFilter.value;
  state.flatOnly = els.flatOnly.checked;

  const budgetMode = state.computeBy === 'budget';
  const budgetVal = budgetMode ? Math.max(0, parseFloat(els.budgetInput?.value) || 0) : 0;

  let rows = buildRows().map((r) => ({
    ...r,
    cost: budgetMode
      ? affordabilityFor(r.pricing, budgetVal)
      : costForImage(r.pricing, state.imageCount),
  }));
  if (budgetMode) {
    rows = rows.filter((r) => r.cost !== null && r.cost !== undefined);
  }

  sortRows(rows);

  const parts = [];
  if (state.providerSearch) parts.push(`from '${state.providerSearch}'`);
  if (state.modelSearch) parts.push(`matching '${state.modelSearch}'`);
  if (state.flatOnly) parts.push('flat-priced only');
  if (state.variantFilter) parts.push(state.variantFilter.toUpperCase());
  els.resultsTitle.textContent = parts.length > 0
    ? `Image models (${parts.join(', ')}) \u2014 ${rows.length} results`
    : `All image generation models \u2014 ${rows.length} results`;

  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortBy) th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  updateLabelsAndHeaders();
  els.mobileSort.value = `${state.sortBy}:${state.sortDir}`;

  if (rows.length === 0) {
    els.resultsBody.innerHTML = '<tr><td colspan="6" class="empty">No models match your criteria.</td></tr>';
    updateHash();
    return;
  }

  const best = globalBestValue(rows);
  const costLabel = esc(els.costColumnHeader.textContent);
  els.resultsBody.innerHTML = rows.map((r, i) => {
    const isBest = best !== null && r.cost != null && r.cost === best;
    const variantSuffix = r.variant ? ' @' + r.variant.toUpperCase() : '';
    const unitLabel = r.unit + variantSuffix;
    const costCell = budgetMode ? fmtAffordability(r.cost) : fmtCost(r.cost);
    return '<tr>' +
      '<td class="rank" data-label="#">' + (i + 1) + (isBest ? ' \u{1F3C6}' : '') + '</td>' +
      '<td data-label="Org"><span class="org-badge">' + esc(orgDisplay(r.model.org)) + '</span></td>' +
      '<td data-label="Model">' + esc(r.model.name || r.model.id) + '</td>' +
      '<td data-label="Unit">' + esc(unitLabel) + '</td>' +
      '<td class="num" data-label="$/Unit">' + fmtPrice(r.costPerUnit) + '</td>' +
      '<td class="num cost" data-label="' + costLabel + '">' + costCell + '</td>' +
      '</tr>';
  }).join('');

  updateHash();
}

// ── URL hash state ────────────────────────────────────────────────────────────
function updateHash() {
  const params = new URLSearchParams();
  const provider = state.providerSearch.trim();
  const model = state.modelSearch.trim();
  if (provider) params.set('p', provider);
  if (model) params.set('m', model);
  if (state.imageCount !== DEFAULTS.imageCount) params.set('count', state.imageCount);
  if (state.variantFilter) params.set('variant', state.variantFilter);
  if (state.flatOnly) params.set('flat', '1');
  if (state.sortBy !== 'cost' || state.sortDir !== 'asc') params.set('sort', state.sortBy + ':' + state.sortDir);
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
  state.variantFilter = '';
  state.flatOnly = false;
  state.sortBy = 'cost';
  state.sortDir = 'asc';
  state.computeBy = 'tokens';
  els.providerSearch.value = '';
  els.modelSearch.value = '';
  els.imageCount.value = DEFAULTS.imageCount;
  els.budgetInput.value = DEFAULTS.budget;
  els.flatOnly.checked = false;
  els.byTokens?.classList.toggle('active', true);
  els.byBudget?.classList.toggle('active', false);
  els.countField.style.display = '';
  els.budgetField.style.display = 'none';
  updateLabelsAndHeaders();
  if (params.has('p')) {
    state.providerSearch = params.get('p');
    els.providerSearch.value = state.providerSearch;
  }
  if (params.has('m')) {
    state.modelSearch = params.get('m');
    els.modelSearch.value = state.modelSearch;
  }
  const count = parseInt(params.get('count'), 10);
  if (count > 0) { state.imageCount = count; els.imageCount.value = count; }
  const variant = params.get('variant');
  if (variant) { state.variantFilter = variant; }
  if (params.get('flat') === '1') { state.flatOnly = true; els.flatOnly.checked = true; }
  const sort = params.get('sort');
  if (sort) { const parts = sort.split(':'); state.sortBy = parts[0]; state.sortDir = parts[1] || 'asc'; }
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
  els.providerSearch.addEventListener('input', () => computeAndRender());
  els.modelSearch.addEventListener('input', () => computeAndRender());
  els.imageCount.addEventListener('input', () => computeAndRender());
  els.budgetInput?.addEventListener('input', () => computeAndRender());
  els.variantFilter.addEventListener('change', () => computeAndRender());
  els.flatOnly.addEventListener('change', () => computeAndRender());
  els.byTokens?.addEventListener('click', () => setComputeBy('tokens'));
  els.byBudget?.addEventListener('click', () => setComputeBy('budget'));
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sortBy === col) { state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; }
      else { state.sortBy = col; state.sortDir = 'asc'; }
      computeAndRender();
    });
  });
  els.mobileSort.addEventListener('change', () => {
    const [col, dir] = els.mobileSort.value.split(':');
    state.sortBy = col;
    state.sortDir = dir;
    computeAndRender();
  });
  window.addEventListener('hashchange', () => { deserializeState(location.hash.slice(1)); computeAndRender(); });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('image-pricing.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.data = await res.json();
    populateVariants();
    populateDatalists();
    deserializeState(location.hash.slice(1));
    els.variantFilter.value = state.variantFilter;
    els.flatOnly.checked = state.flatOnly;
    attachListeners();
    computeAndRender();
  } catch (err) {
    els.resultsBody.innerHTML = '<tr><td colspan="6" class="empty">Failed to load pricing data: ' + esc(err.message) + '</td></tr>';
  }
}

init();
