// TokenWatch — video-app.js
// Loads video-pricing.json, computes per-second costs, renders sortable table.

const state = {
  data: null,
  providerSearch: '',
  modelSearch: '',
  videoSeconds: 60,
  resolutionFilter: '',
  audioFilter: '',
  sortBy: 'cost',
  sortDir: 'asc',
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
  if (c === null) return '<span class="missing">\u2014</span>';
  if (c === 0) return '<span class="cost-zero">$0.00</span>';
  if (c < 0.01) return '$' + c.toFixed(4);
  if (c < 1) return '$' + c.toFixed(4);
  return '$' + c.toFixed(2);
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
      if (state.audioFilter !== '' && String(p.audio) !== state.audioFilter) continue;
      const cost = state.videoSeconds * p.cost_per_second;
      rows.push({
        model: m,
        pricing: p,
        cost,
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

// ── Rendering ─────────────────────────────────────────────────────────────────
function computeAndRender() {
  if (!state.data) return;
  state.providerSearch = els.providerSearch.value.trim();
  state.modelSearch = els.modelSearch.value.trim();
  state.videoSeconds = Math.max(1, parseInt(els.videoSeconds.value, 10) || 60);
  state.resolutionFilter = els.resolutionFilter.value;
  state.audioFilter = els.audioFilter.value;

  const rows = buildRows();
  sortRows(rows);

  // Update title
  const parts = [];
  if (state.providerSearch) parts.push(`from '${state.providerSearch}'`);
  if (state.modelSearch) parts.push(`matching '${state.modelSearch}'`);
  if (state.resolutionFilter) parts.push(state.resolutionFilter.toUpperCase());
  if (state.audioFilter === 'true') parts.push('with audio');
  if (state.audioFilter === 'false') parts.push('without audio');
  els.resultsTitle.textContent = parts.length > 0
    ? `Video models (${parts.join(', ')}) \u2014 ${rows.length} results`
    : `All video generation models \u2014 ${rows.length} results`;

  // Update sort indicators
  document.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortBy) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });

  els.mobileSort.value = `${state.sortBy}:${state.sortDir}`;

  if (rows.length === 0) {
    els.resultsBody.innerHTML = '<tr><td colspan="7" class="empty">No models match your criteria.</td></tr>';
    return;
  }

  const cheapest = rows.reduce((min, r) => (r.cost > 0 && r.cost < min) ? r.cost : min, Infinity);
  els.resultsBody.innerHTML = rows.map((r, i) => {
    const isCheapest = r.cost > 0 && r.cost === cheapest;
    return `<tr>
      <td class="rank" data-label="#">${i + 1}${isCheapest ? ' \u{1F3C6}' : ''}</td>
      <td data-label="Org"><span class="org-badge">${esc(orgDisplay(r.model.org))}</span></td>
      <td data-label="Model">${esc(r.model.name || r.model.id)}</td>
      <td data-label="Resolution">${resLabel(r.resolution)}</td>
      <td data-label="Audio">${audioLabel(r.audio)}</td>
      <td class="num" data-label="$/Sec">${fmtPrice(r.pricing.cost_per_second)}</td>
      <td class="num cost" data-label="Total Cost">${fmtCost(r.cost)}</td>
    </tr>`;
  }).join('');

  updateHash();
}

// ── URL hash state ────────────────────────────────────────────────────────────
function updateHash() {
  const params = new URLSearchParams();
  if (state.providerSearch) params.set('p', state.providerSearch);
  if (state.modelSearch) params.set('m', state.modelSearch);
  if (state.videoSeconds !== 60) params.set('sec', state.videoSeconds);
  if (state.resolutionFilter) params.set('res', state.resolutionFilter);
  if (state.audioFilter !== '') params.set('audio', state.audioFilter);
  if (state.sortBy !== 'cost' || state.sortDir !== 'asc') params.set('sort', `${state.sortBy}:${state.sortDir}`);
  const hash = params.toString();
  history.replaceState(null, '', hash ? '#' + hash : window.location.pathname);
}

function deserializeState(hash) {
  const params = new URLSearchParams(hash);
  const prov = params.get('p');
  if (prov) { state.providerSearch = prov; els.providerSearch.value = prov; }
  const mod = params.get('m');
  if (mod) { state.modelSearch = mod; els.modelSearch.value = mod; }
  const sec = parseInt(params.get('sec'), 10);
  if (sec > 0) { state.videoSeconds = sec; els.videoSeconds.value = sec; }
  const res = params.get('res');
  if (res) { state.resolutionFilter = res; els.resolutionFilter.value = res; }
  const audio = params.get('audio');
  if (audio === 'true' || audio === 'false') { state.audioFilter = audio; els.audioFilter.value = audio; }
  const sort = params.get('sort');
  if (sort) { const [by, dir] = sort.split(':'); state.sortBy = by; state.sortDir = dir || 'asc'; }
}

// ── Event listeners ───────────────────────────────────────────────────────────
function attachListeners() {
  els.providerSearch.addEventListener('input', () => computeAndRender());
  els.modelSearch.addEventListener('input', () => computeAndRender());
  els.videoSeconds.addEventListener('input', () => computeAndRender());
  els.resolutionFilter.addEventListener('change', () => computeAndRender());
  els.audioFilter.addEventListener('change', () => computeAndRender());

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

  window.addEventListener('hashchange', () => {
    deserializeState(location.hash.slice(1));
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
