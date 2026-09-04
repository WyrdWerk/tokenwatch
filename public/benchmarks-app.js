/**
 * public/benchmarks-app.js — Benchmarks page app.
 *
 * Use-case tabs → hand-picked score columns per use case → sortable table with
 * cheapest-provider blended $/M + a value bar (score per dollar, relative).
 * Detail modal shows every source score for the model grouped by use case,
 * and deep-links to the Text tab (#q=<id>) for the full provider breakdown.
 *
 * Data: public/benchmarks.json (built by scripts/fetch-benchmarks.mjs).
 */

(() => {
  'use strict';

  const state = {
    data: null,
    uc: 'agentic',
    search: '',
    sort: 'score',      // 'score' | 'value' | 'price' | 'name' | 'org' | score column key
    dir: 'desc',
    org: '',            // '' = all orgs
    valueKey: null,     // selected benchmark driving Value (null = tab default = first column)
    mix: { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 }, // replaced at boot from Text page
    restoreFocus: null, // element to refocus when the detail modal closes
  };

  // Mirror of shared/cost.mjs blendedRate (classic script — no ESM imports).
  // Parity pinned by test/benchmarks-page.test.mjs.
  function blendedRate(pricing, mix) {
    const inRate = pricing.input != null ? pricing.input * mix.inputPct / 100 : null;
    const outRate = pricing.output != null ? pricing.output * mix.outputPct / 100 : null;
    const crPrice = pricing.cache_read != null ? pricing.cache_read : pricing.input;
    const crRate = crPrice != null ? crPrice * mix.cacheReadPct / 100 : null;
    if (mix.inputPct > 0 && inRate === null) return null;
    if (mix.outputPct > 0 && outRate === null) return null;
    return (inRate || 0) + (outRate || 0) + (crRate || 0);
  }

  // The mix is sourced from the Text calculator (same origin): its usage
  // text boxes persist to localStorage['tw-mix']. This page may override via
  // its own #mix= hash. Defaults to the agentic mix.
  function loadMix() {
    const fallback = { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 };
    try {
      const raw = location.hash.match(/mix=([\d.]+),([\d.]+),([\d.]+)/);
      const src = raw ? raw[0].slice(4) : localStorage.getItem('tw-mix');
      if (!src) return fallback;
      const parts = src.split(',').map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite) && parts.every((v) => v >= 0)) {
        return { inputPct: parts[0], cacheReadPct: parts[1], outputPct: parts[2] };
      }
    } catch (e) { /* non-fatal */ }
    return fallback;
  }

  // Cheapest provider AT THE CURRENT MIX (recomputed every render).
  function cheapestAtMix(m) {
    let best = null;
    for (const o of m.offerings || []) {
      const rate = blendedRate(o, state.mix);
      if (rate == null) continue;
      if (!best || rate < best.rate) best = { provider: o.provider, rate };
    }
    return best;
  }

  // Use-case taxonomy → columns shown in that tab.
  // valueFrom: the score used for the value bar (primary metric of the tab).
  const USE_CASES = {
    agentic: {
      label: 'Agentic Coding',
      columns: [
        { key: 'aa_agentic', label: 'AA Agentic', scale: '0–100' },
        { key: 'livebench_agentic_coding', label: 'LiveBench Agentic', scale: '0–100' },
        { key: 'aa_coding', label: 'AA Coding', scale: '0–100' },
        { key: 'design_arena_elo', label: 'Design Arena Elo', scale: 'Elo' },
      ],
      // Sort/value fallbacks stay within the 0-100 scale — Elo (1300+) must never
      // outrank index scores. Models without any 0-100 metric sink to the bottom.
      valueFrom: (s) => s.aa_agentic ?? s.livebench_agentic_coding ?? s.aa_coding,
    },
    reasoning: {
      label: 'Reasoning & Knowledge',
      columns: [
        { key: 'aa_intelligence', label: 'AA Intelligence', scale: '0–100' },
        { key: 'livebench_reasoning', label: 'LiveBench Reasoning', scale: '0–100' },
        { key: 'livebench_math', label: 'LiveBench Math', scale: '0–100' },
      ],
      valueFrom: (s) => s.aa_intelligence ?? s.livebench_reasoning,
    },
    knowledge: {
      label: 'Knowledge Work',
      columns: [
        { key: 'livebench_data_analysis', label: 'LiveBench Data Analysis', scale: '0–100' },
        { key: 'livebench_instruction_following', label: 'LiveBench Instr. Following', scale: '0–100' },
        { key: 'livebench_language', label: 'LiveBench Language', scale: '0–100' },
      ],
      valueFrom: (s) => s.livebench_data_analysis ?? s.livebench_instruction_following ?? s.livebench_language,
    },
    ui_quality: {
      label: 'Chat & UI Quality',
      columns: [
        { key: 'design_arena_elo', label: 'Design Arena Elo', scale: 'Elo' },
        { key: 'aa_intelligence', label: 'AA Intelligence', scale: '0–100' },
      ],
      valueFrom: (s) => s.design_arena_elo,
    },
  };

  const $ = (id) => document.getElementById(id);

  // ── Data load ──────────────────────────────────────────────────────────────

  async function boot() {
    try {
      const resp = await fetch('/benchmarks.json');
      state.data = await resp.json();
    } catch (err) {
      console.error(err);
      document.getElementById('benchBody').innerHTML =
        `<tr><td colspan="9" class="dim">Failed to load benchmarks: ${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    state.mix = loadMix();
    renderMixNote();
    buildDatalist();
    renderTabs();
    computeAndRender();
    publishTwCatalog();
    wireEvents();
    // Hash: #uc=<usecase>
    const m = location.hash.match(/uc=([a-z_]+)/);
    if (m && USE_CASES[m[1]]) { state.uc = m[1]; renderTabs(); computeAndRender(); }
  }

  function buildDatalist() {
    $('modelList').innerHTML = state.data.models
      .map((m) => `<option value="${escapeHtml(m.name)}">`).join('');
    const orgs = [...new Set(state.data.models.map((m) => m.org).filter(Boolean))].sort();
    $('orgFilter').innerHTML = '<option value="">All organizations</option>' +
      orgs.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  // The benchmark driving Value/sort: user-selected via dropdown, else the tab default.
  // '__any__' = no benchmark filter — every model in the catalog is shown, Value
  // and score cells render as "—" (no models are locked out of the page).
  const ANY = '__any__';
  function activeValueKey() {
    const uc = USE_CASES[state.uc];
    if (state.valueKey === ANY) return ANY;
    return state.valueKey && uc.columns.some((c) => c.key === state.valueKey)
      ? state.valueKey
      : uc.columns[0].key;
  }

  function visibleModels() {
    const uc = USE_CASES[state.uc];
    const valueKey = activeValueKey();
    let rows = valueKey === ANY
      ? state.data.models.slice()
      : state.data.models.filter((m) => uc.columns.some((c) => m.scores[c.key] != null));
    if (state.search) {
      const q = state.search.toLowerCase();
      rows = rows.filter((m) => m.name.toLowerCase().includes(q) || (m.org || '').includes(q));
    }
    if (state.org) rows = rows.filter((m) => m.org === state.org);

    // Value = primary score per dollar, NORMALIZED 0-100 against the best row in
    // view. Raw score/price ratios are scale-dependent (Elo vs 0-100 indices) and
    // span orders of magnitude — meaningless as a printed number, so only the
    // normalized bar + rank order is shown.
    const raw = rows.map((m) => {
      const score = valueKey === ANY ? null : m.scores[valueKey];
      const cheap = cheapestAtMix(m);
      const price = cheap ? Math.round(cheap.rate * 1000) / 1000 : null;
      return {
        m,
        score,
        price,
        cheapest: cheap,
        ratio: score != null && price != null && price > 0 ? score / price : null,
      };
    });
    const maxRatio = Math.max(...raw.map((r) => r.ratio ?? 0), 0);
    const valued = raw.map((r) => ({ ...r, value: r.ratio != null && maxRatio > 0 ? (r.ratio / maxRatio) * 100 : null }));

    // Column accessors for sorting (asc/desc toggleable on every column)
    const colVal = (r, key) => {
      if (key === 'name') return r.m.name.toLowerCase();
      if (key === 'org') return (r.m.org || 'zzz').toLowerCase();
      if (key === 'price') return r.price ?? Number.MAX_SAFE_INTEGER;
      if (key === 'value') return r.value ?? -1;
      if (key === 'score') return r.score ?? -1;
      return r.m.scores[key] ?? null;
    };
    valued.sort((a, b) => {
      const va = colVal(a, state.sort), vb = colVal(b, state.sort);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;   // missing values always sink
      if (vb == null) return -1;
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return state.dir === 'asc' ? cmp : -cmp;
    });
    return valued;
  }

  // Provenance sentence between the controls and the tabs + value explainer.
  // Mix values are live — sourced from the Text calculator's usage boxes.
  function renderMixNote() {
    const { inputPct, cacheReadPct, outputPct } = state.mix;
    const el = document.getElementById('mixNote');
    if (el) {
      el.innerHTML =
        `Blended $/M = the cheapest provider's effective rate at your token mix from the ` +
        `<a href="/#mix=${inputPct},${cacheReadPct},${outputPct}">Text calculator</a> ` +
        `(${inputPct}% input / ${cacheReadPct}% cached input / ${outputPct}% output). ` +
        `<strong>Value</strong> = the tab's primary score divided by that blended price, ` +
        `scaled so the best model in the current view = 100 — a relative capability-per-dollar ` +
        `ranking within this tab, not an absolute number.`;
    }
  }

  function renderTabs() {
    $('ucTabs').innerHTML = Object.entries(USE_CASES).map(([k, uc]) =>
      `<button class="uc-tab${k === state.uc ? ' active' : ''}" data-uc="${k}" role="tab" aria-selected="${k === state.uc}">${uc.label}</button>`
    ).join('');
    // Populate the value-benchmark dropdown for the active tab.
    const uc = USE_CASES[state.uc];
    const current = activeValueKey();
    $('valueKeySelect').innerHTML =
      `<option value="${ANY}"${current === ANY ? ' selected' : ''}>No filter — all models</option>` +
      uc.columns.map((c) =>
        `<option value="${c.key}"${c.key === current ? ' selected' : ''}>${c.label} (${c.scale})</option>`
      ).join('');
  }

  function render() {
    const uc = USE_CASES[state.uc];
    const rows = visibleModels();
    const maxValue = Math.max(...rows.map((r) => r.value ?? 0), 0);

    // Header — every column sorts; arrow shows current sort + direction
    const arrow = (key) => state.sort === key ? (state.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = (key, label, extra = '') =>
      `<th class="sortable${/\$|Value|^#/.test(label) ? ' num' : ''}" data-col="${key}" title="${extra}" tabindex="0" role="button" aria-sort="${state.sort === key ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${label}${arrow(key)}</th>`;
    $('benchHead').innerHTML =
      th('rank', '#') +
      th('name', 'Model') +
      th('org', 'Org') +
      uc.columns.map((c) => th(c.key, c.label, c.scale)).join('') +
      th('price', 'From $/M', 'Cheapest provider blended rate at the agentic mix') +
      th('value', 'Value', 'Capability per dollar, normalized to the best model in view (100)');

    // Body
    const fmt = (v) => v == null ? '<span class="dim">—</span>' : (Math.round(v * 10) / 10);
    $('benchBody').innerHTML = rows.map((r, i) => {
      const { m } = r;
      const cells = uc.columns.map((c) => {
        const v = m.scores[c.key];
        return `<td class="num" data-label="${c.label}">${fmt(v)}</td>`;
      }).join('');
      const barW = r.value != null ? Math.max(3, r.value) : 0;
      return `<tr data-id="${escapeHtml(m.id)}" tabindex="0" aria-label="Open model details">
        <td class="num" data-label="#">${i + 1}</td>
        <td data-label="Model">${escapeHtml(m.name)}</td>
        <td data-label="Org">${m.org ? `<span class="org-badge">${escapeHtml(m.org)}</span>` : '—'}</td>
        ${cells}
        <td class="num" data-label="From $/M">${r.price != null ? '$' + r.price : '—'}<span class="dim" style="font-size:.72rem"> · ${r.cheapest ? escapeHtml(r.cheapest.provider) : ''}</span></td>
        <td class="num value-cell" data-label="Value"><span class="value-bar" style="width:${barW}%"></span><span class="value-num">${r.value != null ? r.value.toFixed(1) : '—'}</span></td>
      </tr>`;
    }).join('') || '<tr><td colspan="9" class="dim" style="padding:1rem">No models match.</td></tr>';

    $('benchNote').textContent =
      `${rows.length} models · ${uc.label} · From $/M = cheapest provider at ${state.mix.inputPct}/${state.mix.cacheReadPct}/${state.mix.outputPct} mix · ${activeValueKey() === ANY ? 'No benchmark filter — Value disabled' : 'Value = ' + (uc.columns.find((c) => c.key === activeValueKey())?.label) + ' per dollar, best-in-view = 100'}`
  }

  // ── Detail modal ───────────────────────────────────────────────────────────

  function openDetail(id) {
    const m = state.data.models.find((x) => x.id === id);
    if (!m) return;
    state.restoreFocus = document.activeElement;
    $('detailTitle').textContent = m.name;
    $('detailSub').textContent =
      `${m.org || 'unknown org'} · hosted by ${m.providers} provider${m.providers > 1 ? 's' : ''} · from $${m.from.blended_per_m}/M blended (${m.from.provider})`;
    const groups = {
      'Agentic & Coding': ['aa_agentic', 'aa_coding', 'livebench_agentic_coding', 'livebench_coding'],
      'Reasoning & Knowledge': ['aa_intelligence', 'livebench_reasoning', 'livebench_math'],
      'Knowledge Work': ['livebench_data_analysis', 'livebench_instruction_following', 'livebench_language'],
      'UI & Design': ['design_arena_elo'],
    };
    const LABELS = {
      aa_agentic: 'AA Agentic Index', aa_coding: 'AA Coding Index', aa_intelligence: 'AA Intelligence Index',
      livebench_agentic_coding: 'LiveBench Agentic Coding', livebench_coding: 'LiveBench Coding',
      livebench_reasoning: 'LiveBench Reasoning', livebench_math: 'LiveBench Mathematics',
      livebench_data_analysis: 'LiveBench Data Analysis', livebench_instruction_following: 'LiveBench Instruction Following',
      livebench_language: 'LiveBench Language', design_arena_elo: 'Design Arena Elo',
    };
    let html = '';
    for (const [group, keys] of Object.entries(groups)) {
      const items = keys.filter((k) => m.scores[k] != null);
      if (!items.length) continue;
      html += `<h4>${group}</h4><ul>` +
        items.map((k) => `<li><span>${LABELS[k]}</span><span>${Math.round(m.scores[k] * 10) / 10}</span></li>`).join('') +
        '</ul>';
    }
    if (m.scores.design_arena_category) {
      html += `<p style="font-size:.78rem;opacity:.7">Design Arena best category: ${escapeHtml(m.scores.design_arena_category)}</p>`;
    }
    $('detailBody').innerHTML = html || '<p class="dim">No scores.</p>';
    $('detailPricingLink').href = `/#q=${encodeURIComponent(m.id)}`;
    $('detailModal').hidden = false;
    $('detailClose').focus();
  }

  function closeDetail() {
    $('detailModal').hidden = true;
    const prev = state.restoreFocus;
    state.restoreFocus = null;
    if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
  }


  function computeAndRender() {
    render();
  }

  function roundBench(n) {
    if (n == null || !Number.isFinite(n)) return n;
    return Math.round(n * 1000) / 1000;
  }

  function snapshotRow(r, rank) {
    const m = r.m;
    return {
      rank,
      id: m.id,
      name: m.name,
      org: m.org || null,
      providers: m.providers,
      from: r.cheapest ? { provider: r.cheapest.provider, blended_per_m: roundBench(r.cheapest.rate) } : null,
      score: r.score,
      value: r.value == null ? null : roundBench(r.value),
      scores: m.scores,
    };
  }

  function getView(input) {
    const n = Math.min(25, Math.max(1, parseInt(input?.limit, 10) || 10));
    const rows = visibleModels();
    return {
      page: 'benchmarks',
      generated_at: state.data?.generated_at || null,
      useCase: state.uc,
      valueKey: activeValueKey(),
      mix: state.mix,
      filters: { search: state.search, org: state.org, valueKey: activeValueKey() },
      sort: { by: state.sort, dir: state.dir },
      rowCount: rows.length,
      top: rows.slice(0, n).map((r, i) => snapshotRow(r, i + 1)),
      shareUrl: location.href,
      note: 'Identity is canonical model id. Do not pass {provider, id} from the text page. Value is best-in-view = 100, not an absolute score/price.',
    };
  }

  function getCatalogInfo() {
    return {
      page: 'benchmarks',
      generated_at: state.data?.generated_at || null,
      catalogSize: state.data?.models?.length || 0,
      modelCount: state.data?.model_count || state.data?.models?.length || 0,
      sources: state.data?.sources || null,
      note: 'generated_at is the benchmarks.json snapshot time. Models are canonical, not provider offerings.',
    };
  }

  function getModel(input) {
    if (!input?.id) return { error: 'id is required (canonical model id from get_view, not {provider, id}).' };
    const rows = visibleModels();
    const hit = rows.find((r) => r.m.id === input.id);
    if (!hit) {
      const exists = (state.data?.models || []).some((m) => m.id === input.id);
      if (!exists) return { error: `No canonical model ${input.id} in the benchmarks catalog.` };
      return { error: `${input.id} is not in the current view. Call get_view or set_filters / set_use_case first.`, inView: false };
    }
    return {
      id: hit.m.id,
      name: hit.m.name,
      org: hit.m.org || null,
      providers: hit.m.providers,
      from: hit.cheapest ? { provider: hit.cheapest.provider, blended_per_m: roundBench(hit.cheapest.rate) } : null,
      offerings: hit.m.offerings,
      scores: hit.m.scores,
      score: hit.score,
      value: hit.value == null ? null : roundBench(hit.value),
      inView: true,
    };
  }

  const BENCH_SORT = new Set(['score', 'value', 'price', 'name', 'org', 'rank']);

  function setSort(input) {
    input = input || {};
    const uc = USE_CASES[state.uc];
    const scoreKeys = uc.columns.map((c) => c.key);
    if (!BENCH_SORT.has(input.by) && !scoreKeys.includes(input.by)) {
      return { error: `by must be one of: score, value, price, name, org, ${scoreKeys.join(', ')}.` };
    }
    if (input.dir !== 'asc' && input.dir !== 'desc') {
      return { error: 'dir must be "asc" or "desc".' };
    }
    state.sort = input.by === 'rank' ? 'score' : input.by;
    state.dir = input.dir;
    const sel = document.getElementById('sortSelect');
    if (sel && ['score', 'value', 'price', 'name'].includes(state.sort)) sel.value = state.sort;
    computeAndRender();
    return getView();
  }

  function setUseCase(input) {
    const uc = input?.uc;
    if (!USE_CASES[uc]) return { error: 'uc must be agentic, reasoning, knowledge, or ui_quality.' };
    state.uc = uc;
    if (state.valueKey !== ANY && !USE_CASES[state.uc].columns.some((c) => c.key === state.valueKey)) state.valueKey = null;
    const scoreKeys = USE_CASES[state.uc].columns.map((c) => c.key);
    if (!['score', 'value', 'price', 'name', 'org'].includes(state.sort) && !scoreKeys.includes(state.sort)) {
      state.sort = 'score';
      state.dir = 'desc';
    }
    history.replaceState(null, '', `#uc=${state.uc}`);
    renderTabs();
    computeAndRender();
    return getView();
  }

  function setFilters(input) {
    input = input || {};
    if (input.search != null) {
      state.search = String(input.search);
      const el = document.getElementById('modelSearch');
      if (el) el.value = state.search;
    }
    if (input.org != null) {
      state.org = String(input.org);
      const el = document.getElementById('orgFilter');
      if (el) el.value = state.org;
    }
    if (input.valueKey != null) {
      state.valueKey = String(input.valueKey);
      const el = document.getElementById('valueKeySelect');
      if (el) el.value = state.valueKey;
      if (state.valueKey !== ANY) {
        state.sort = state.valueKey;
        state.dir = 'desc';
      }
    }
    computeAndRender();
    return getView();
  }

  function publishTwCatalog() {
    window.TWCatalog = {
      page: 'benchmarks',
      ready: true,
      getView,
      getCatalogInfo,
      getModel,
      setSort,
      setUseCase,
      setFilters,
    };
    document.dispatchEvent(new CustomEvent('tw-catalog-ready', { detail: { page: 'benchmarks' } }));
  }


  // ── Events ─────────────────────────────────────────────────────────────────

  function sortByCol(col) {
    const key = col === 'rank' ? 'score' : col;
    if (state.sort === key) {
      state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort = key;
      state.dir = (key === 'name' || key === 'org') ? 'asc' : 'desc';
    }
    $('sortSelect').value = ['score', 'value', 'price', 'name'].includes(state.sort) ? state.sort : 'score';
    render();
  }

  function wireEvents() {
    $('modelSearch').addEventListener('input', (e) => { state.search = e.target.value; render(); });
    $('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
    $('orgFilter').addEventListener('change', (e) => { state.org = e.target.value; render(); });
    $('valueKeySelect').addEventListener('change', (e) => {
      state.valueKey = e.target.value;
      // Sort by the newly chosen benchmark so the table follows the selection.
      state.sort = e.target.value; state.dir = 'desc';
      $('sortSelect').value = 'score';
      render();
    });
    $('ucTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.uc-tab');
      if (!btn) return;
      state.uc = btn.dataset.uc;
      if (state.valueKey !== ANY && !USE_CASES[state.uc].columns.some((c) => c.key === state.valueKey)) state.valueKey = null;
      if (!['score', 'value', 'price', 'name', 'org'].includes(state.sort) && !USE_CASES[state.uc].columns.some((c) => c.key === state.sort)) {
        state.sort = 'score';
        state.dir = 'desc';
      }
      history.replaceState(null, '', `#uc=${state.uc}`);
      renderTabs(); render();
    });
    $('benchBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) openDetail(tr.dataset.id);
    });
    $('benchBody').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-id]');
      if (tr) { e.preventDefault(); openDetail(tr.dataset.id); }
    });
    $('benchHead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      sortByCol(th.dataset.col);
    });
    $('benchHead').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      e.preventDefault();
      sortByCol(th.dataset.col);
    });
    $('detailClose').addEventListener('click', closeDetail);
    $('detailModal').addEventListener('click', (e) => { if (e.target === $('detailModal')) closeDetail(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('detailModal').hidden) closeDetail(); });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  boot().catch((err) => {
    console.error(err);
    document.getElementById('benchBody').innerHTML =
      `<tr><td colspan="9" class="dim">Failed to load benchmarks: ${escapeHtml(err.message)}</td></tr>`;
  });
})();
