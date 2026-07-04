// PAYG Inference Calculator — app.js
// Loads pricing.json, lets the user search by provider (org) and/or model name,
// enter token volumes as total + percentage breakdown, and computes per-offering cost.

const state = {
  data: null,             // { generated_at, providers, models }
  providerSearch: '',     // org name filter text
  modelSearch: '',        // canonical model name filter text
  orgDisplayName: {},     // org key → pretty display name (e.g. "z-ai" → "Z.ai")
  modelDisplayName: {},   // canonical → display name
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
};

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('pricing.json');
    state.data = await res.json();
  } catch (err) {
    els.resultsBody.innerHTML = `<tr><td colspan="8" class="empty">Could not load pricing.json. Run <code>node scripts/fetch-pricing.mjs</code> first.</td></tr>`;
    return;
  }

  els.lastUpdated.textContent = `Data updated: ${new Date(state.data.generated_at).toLocaleString()}`;
  populateDatalists();
  attachListeners();
  computeAndRender();
}

/** Build a canonical model key for cross-provider matching.
 *  Strips provider prefix, suffixes (:free, dates like -2024-08-06,
 *  -preview, -preview-05-06, :thinking), and lowercases.
 *  Used for MATCHING only — display ID stays as-is.
 *  Turbo variants kept separate (different SKUs). */
function canonicalModelId(id) {
  let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
  k = k.replace(/:free$/, '')
       .replace(/:thinking$/, '')
       .replace(/-(\d{4})-\d{2}-\d{2}$/, '')
       .replace(/-preview-\d{2}-\d{2}$/, '')
       .replace(/-preview$/, '')
       .toLowerCase().trim();
  return k;
}

// ── Selectors ──────────────────────────────────────────────────────────────────

function populateDatalists() {
  // Build org display names and populate org datalist
  const orgCounts = {};
  for (const m of state.data.models) {
    orgCounts[m.org] = (orgCounts[m.org] || 0) + 1;
  }
  state.orgDisplayName = {};
  els.orgList.innerHTML = Object.keys(orgCounts)
    .sort((a, b) => orgCounts[b] - orgCounts[a])  // most models first
    .map((org) => {
      const display = orgDisplay(org);
      state.orgDisplayName[org] = display;
      return `<option value="${display}">`;
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
function attachListeners() {
  els.providerSearch.addEventListener('input', () => computeAndRender());
  els.modelSearch.addEventListener('input', () => computeAndRender());

  for (const id of ['totalTokens', 'inputPct', 'cacheReadPct', 'outputPct']) {
    els[id].addEventListener('input', () => computeAndRender());
  }

  document.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
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

// ── Token computation ──────────────────────────────────────────────────────────

function getTokens() {
  const total = Math.max(0, parseFloat(els.totalTokens.value) || 0) * 1e6; // millions → tokens
  const inputPct = Math.max(0, parseFloat(els.inputPct.value) || 0);
  const cacheReadPct = Math.max(0, parseFloat(els.cacheReadPct.value) || 0);
  const outputPct = Math.max(0, parseFloat(els.outputPct.value) || 0);
  const sum = inputPct + cacheReadPct + outputPct;
  return {
    total,
    inputPct,
    cacheReadPct,
    outputPct,
    sum,
    input: total * inputPct / 100,
    cacheRead: total * cacheReadPct / 100,
    cacheWrite: 0, // not exposed in percentage model
    output: total * outputPct / 100,
  };
}

/** cost = (tokens × $/M) / 1e6  — prices are $/M tokens */
function costFor(pricing, tokens) {
  const c = (price, tok) => (price !== null ? (price * tok) / 1e6 : null);
  const parts = [
    c(pricing.input, tokens.input),
    c(pricing.output, tokens.output),
    c(pricing.cache_read, tokens.cacheRead),
    c(pricing.cache_write, tokens.cacheWrite),
  ];
  // If a component is null (unsupported), treat as 0 IF tokens for it are 0;
  // otherwise the offering can't serve that usage → exclude.
  if (parts.some((p, i) => p === null && [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite][i] > 0)) {
    return null; // this offering doesn't support requested token types
  }
  return parts.reduce((a, b) => a + (b || 0), 0);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function computeAndRender() {
  if (!state.data) return;
  const tokens = getTokens();
  const provSearch = els.providerSearch.value.trim().toLowerCase();
  const modSearch = els.modelSearch.value.trim().toLowerCase();

  // Update breakdown display
  const fmtM = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`;
  els.tokenBreakdown.textContent = `Input: ${fmtM(tokens.input)} · Cached: ${fmtM(tokens.cacheRead)} · Output: ${fmtM(tokens.output)}`;
  const sumPct = tokens.sum;
  if (Math.abs(sumPct - 100) < 0.01) {
    els.pctSum.textContent = '100%';
    els.pctSum.className = 'pct-ok';
  } else {
    els.pctSum.textContent = `${sumPct.toFixed(1)}% (should be 100%)`;
    els.pctSum.className = 'pct-warn';
  }

  // Filter offerings: AND of provider search + model search
  // Provider search matches against org (display name or raw key)
  // Model search matches against canonical model display name
  let offerings = state.data.models.filter((m) => {
    if (provSearch) {
      const orgDisplay = (state.orgDisplayName[m.org] || m.org).toLowerCase();
      if (!orgDisplay.includes(provSearch) && !m.org.toLowerCase().includes(provSearch)) return false;
    }
    if (modSearch) {
      const canon = canonicalModelId(m.id);
      const modDisplay = (state.modelDisplayName[canon] || canon).toLowerCase();
      const rawId = m.id.split('/').slice(-1)[0].toLowerCase();
      if (!modDisplay.includes(modSearch) && !rawId.includes(modSearch)) return false;
    }
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
  els.resultsTitle.textContent = title;

  // Compute costs
  const rows = offerings
    .map((m) => ({ model: m, cost: costFor(m.pricing, tokens) }))
    .filter((r) => r.cost !== null);

  // Sort cheapest first
  rows.sort((a, b) => a.cost - b.cost);

  renderTable(rows, tokens);
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

function renderTable(rows, tokens) {
  if (rows.length === 0) {
    els.resultsBody.innerHTML = `<tr><td colspan="9" class="empty">No offerings match your criteria. Some providers may not support the token types you entered.</td></tr>`;
    return;
  }

  els.resultsBody.innerHTML = rows
    .map((r, i) => {
      const p = r.model.pricing;
      const cheapest = i === 0 && r.cost > 0;
      const quant = r.model.quantization && r.model.quantization !== 'unknown'
        ? `<span class="quant">${esc(r.model.quantization)}</span>`
        : '<span class="quant quant-none">—</span>';
      const promo = r.model.discount > 0
        ? ` <span class="promo-badge" title="${(r.model.discount * 100).toFixed(0)}% off">promo</span>`
        : '';
      return `<tr>
        <td class="rank">${i + 1}${cheapest ? ' 🏆' : ''}</td>
        <td><span class="org-badge">${esc(orgDisplay(r.model.org))}</span></td>
        <td><span class="provider-badge">${esc(providerName(r.model.provider, r.model.provider_display))}</span></td>
        <td>${quant}</td>
        <td>${esc(r.model.id)}${promo}</td>
        <td class="num">${fmtPrice(p.input)}</td>
        <td class="num">${fmtPrice(p.output)}</td>
        <td class="num">${fmtPrice(p.cache_read)}</td>
        <td class="num cost">${fmtCost(r.cost)}</td>
      </tr>`;
    })
    .join('');
}

// ── Boot ───────────────────────────────────────────────────────────────────────
init();
