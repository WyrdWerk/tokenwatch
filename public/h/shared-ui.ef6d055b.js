// TokenWatch — shared-ui.js
// Classic script (no ES modules, no build step). Loaded with `defer` BEFORE
// each page's app script, so window.TW exists by the time app code runs.
// Holds only helpers that are byte-identical (or cleanly parameterizable)
// across the Text/Image/Video pages. Page-local, drift-prone, or state-bound
// logic stays in each app file.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** Median of a numeric array. Returns null for empty input. */
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Format an ISO timestamp in IST (Asia/Kolkata). '—' on invalid input. */
  function fmtIST(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  }

  /** Trailing-edge debounce. Delays fn until `wait`ms after the last call. */
  function debounce(fn, wait = 120) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

  /**
   * Build the {fmtPrice, fmtCost} pair for a page. Pages drifted historically:
   *   Text  → round-to-3-decimals, missing cost shows "N/A"
   *   Image/Video → tiered toFixed(4)/toFixed(2), missing cost shows "varies"
   * Output is byte-identical to each page's previous inline formatters.
   * @param {{style:'round3'|'tiered', missingCost:string}} cfg
   */
  function makeFormatters({ style, missingCost }) {
    const money = (n) => style === 'round3'
      ? `$${round3(n)}`
      : (n < 1 ? '$' + n.toFixed(4) : '$' + n.toFixed(2));

    function fmtPrice(p) {
      if (p === null || p === undefined) return '<span class="missing">—</span>';
      if (p === 0) return '<span class="cost-zero">Free</span>';
      return money(p);
    }
    function fmtCost(c) {
      if (c === null) return `<span class="missing">${missingCost}</span>`;
      if (c === 0) return '<span class="cost-zero">$0.00</span>';
      return money(c);
    }
    return { fmtPrice, fmtCost };
  }

  const THEME_COLOR = { light: '#F8F5F0', dark: '#1a1612' };

  /** Apply a theme. Persists to localStorage only when `persist` (explicit choice). */
  function applyTheme(theme, persist = true) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) { try { localStorage.setItem('tw-theme', theme); } catch (e) { /* private mode */ } }
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[theme] || THEME_COLOR.light);
  }

  /**
   * Reconcile with the pre-paint inline script and wire the toggle. A saved
   * choice wins and stays persisted; otherwise we follow the value the
   * pre-paint script derived (localStorage/OS) WITHOUT persisting, so the page
   * keeps tracking the OS until the user makes an explicit choice.
   */
  function initTheme() {
    const saved = localStorage.getItem('tw-theme');
    const current = saved
      || document.documentElement.getAttribute('data-theme')
      || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(current, !!saved);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', () => {
      const now = document.documentElement.getAttribute('data-theme');
      applyTheme(now === 'dark' ? 'light' : 'dark', true); // explicit → persist
    });
  }

  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  /**
   * Accessible modal controller for an overlay element whose visibility is
   * toggled via `display`. Handles Escape, backdrop click, focus save/restore.
   * @param {HTMLElement} el overlay element
   * @param {{onClose?:function}} [opts]
   * @returns {{open:function, close:function, isOpen:function}}
   */
  function modal(el, opts = {}) {
    let lastFocus = null;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onBackdrop = (e) => { if (e.target === el) close(); };
    function open() {
      lastFocus = document.activeElement;
      el.style.display = '';
      document.addEventListener('keydown', onKey);
      el.addEventListener('mousedown', onBackdrop);
      const f = el.querySelector(FOCUSABLE);
      if (f) f.focus();
    }
    function close() {
      el.style.display = 'none';
      document.removeEventListener('keydown', onKey);
      el.removeEventListener('mousedown', onBackdrop);
      if (opts.onClose) opts.onClose();
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    }
    const isOpen = () => el.style.display !== 'none';
    return { open, close, isOpen };
  }

  /** Parse CSS color to canvas-safe string; fallback when transparent. */
  function solidBg(el, fallback = '#F8F5F0') {
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return fallback;
    return bg;
  }

  function cssPx(el, prop, d = 0) {
    const v = parseFloat(getComputedStyle(el).getPropertyValue(prop));
    return Number.isFinite(v) ? v : d;
  }

  /**
   * Zero-dep PNG capture specialized for the comparison card.
   * Walks brand / snapshot / table and paints via canvas (no foreignObject —
   * Chromium taints canvas when drawing SVG foreignObject HTML).
   * @param {HTMLElement} el .compare-modal-content
   * @param {{scale?:number}} [opts]
   * @returns {Promise<Blob>}
   */
  function domToPngBlob(el, opts = {}) {
    const scale = opts.scale || Math.min(2, window.devicePixelRatio || 2);
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const pageBg = theme === 'dark' ? '#1a1612' : '#F8F5F0';
    const textColor = getComputedStyle(el).color || (theme === 'dark' ? '#f0ebe3' : '#1a1612');
    const dimColor = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim()
      || (theme === 'dark' ? '#a3988a' : '#6b635a');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      || '#0d7377';
    const border = getComputedStyle(document.documentElement).getPropertyValue('--border').trim()
      || (theme === 'dark' ? '#3a342c' : '#ddd5c8');
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()
      || (theme === 'dark' ? '#242018' : '#fff');

    const pad = 24;
    const brand = el.querySelector('.compare-brand-link');
    const title = el.querySelector('.compare-modal-header h2');
    const snapshot = el.querySelector('.compare-snapshot');
    const table = el.querySelector('.compare-table');

    // Measure table
    const rows = table ? Array.from(table.querySelectorAll('tr')) : [];
    const grid = rows.map((tr) => Array.from(tr.children).map((cell) => ({
      text: (cell.textContent || '').replace(/\s+/g, ' ').trim(),
      isHead: cell.tagName === 'TH',
      isLabel: cell.classList.contains('compare-label'),
      isNum: cell.classList.contains('num'),
      isBest: cell.classList.contains('compare-cheapest'),
    })));
    const colCount = grid.reduce((m, r) => Math.max(m, r.length), 0) || 1;

    // Column widths from live table when available
    let colWidths = [];
    if (table && table.rows[0]) {
      colWidths = Array.from(table.rows[0].cells).map((c) => Math.ceil(c.getBoundingClientRect().width));
    }
    if (colWidths.length !== colCount) {
      colWidths = Array(colCount).fill(120);
      colWidths[0] = 140;
    }

    const rowH = 32;
    const brandH = 28;
    const titleGap = 8;
    const snapH = snapshot ? 44 : 0;
    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const contentW = Math.max(tableW, 420);
    const width = contentW + pad * 2;
    const height = pad + brandH + titleGap + (title ? 28 : 0) + (snapH ? snapH + 12 : 0) + grid.length * rowH + pad;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // Background + border card
    ctx.fillStyle = solidBg(el, pageBg);
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

    let y = pad;
    // Brand
    ctx.fillStyle = accent;
    ctx.font = 'bold 14px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textBaseline = 'middle';
    const brandText = (brand && brand.textContent.trim()) || 'WyrdWerk';
    ctx.fillText(brandText, pad, y + brandH / 2);
    // Title next to brand
    if (title) {
      const bw = ctx.measureText(brandText).width;
      ctx.fillStyle = textColor;
      ctx.font = '600 18px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText((title.textContent || 'Comparison').trim(), pad + bw + 16, y + brandH / 2);
    }
    y += brandH + titleGap;

    // Snapshot strip
    if (snapshot) {
      ctx.fillStyle = surface;
      ctx.fillRect(pad, y, contentW, snapH);
      ctx.strokeStyle = border;
      ctx.strokeRect(pad + 0.5, y + 0.5, contentW - 1, snapH - 1);
      ctx.fillStyle = textColor;
      ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
      const snapText = (snapshot.textContent || '').replace(/\s+/g, ' ').trim();
      // Simple wrap
      const maxW = contentW - 16;
      const words = snapText.split(' ');
      let line = '';
      let ly = y + 16;
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, pad + 8, ly);
          line = w;
          ly += 16;
          if (ly > y + snapH - 8) break;
        } else line = test;
      }
      if (line && ly <= y + snapH - 8) ctx.fillText(line, pad + 8, ly);
      y += snapH + 12;
    }

    // Table
    let x0 = pad;
    grid.forEach((row, ri) => {
      let x = x0;
      const y0 = y + ri * rowH;
      row.forEach((cell, ci) => {
        const w = colWidths[ci] || 100;
        // cell bg
        if (cell.isHead) ctx.fillStyle = surface;
        else if (cell.isBest) ctx.fillStyle = theme === 'dark' ? 'rgba(13,115,119,0.25)' : 'rgba(13,115,119,0.12)';
        else ctx.fillStyle = solidBg(el, pageBg);
        ctx.fillRect(x, y0, w, rowH);
        ctx.strokeStyle = border;
        ctx.strokeRect(x + 0.5, y0 + 0.5, w - 1, rowH - 1);

        ctx.fillStyle = cell.isLabel || cell.isHead ? dimColor : textColor;
        if (cell.isBest) ctx.fillStyle = accent;
        ctx.font = (cell.isHead || cell.isLabel ? '600 ' : '400 ') + '12px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.textBaseline = 'middle';
        const tx = cell.text;
        const tw = ctx.measureText(tx).width;
        const textX = cell.isNum ? x + w - 8 - Math.min(tw, w - 16) : x + 8;
        // clip
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 4, y0, w - 8, rowH);
        ctx.clip();
        ctx.fillText(tx, textX, y0 + rowH / 2);
        ctx.restore();
        x += w;
      });
    });

    // Footer attribution
    const footY = height - 12;
    ctx.fillStyle = dimColor;
    ctx.font = '10px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText('tokenwatch.wyrdwerk.com', pad, footY);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) reject(new Error('canvas.toBlob failed'));
        else resolve(blob);
      }, 'image/png');
    });
  }

  /** Download a Blob as a file (clipboard fallback). */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Copy element as PNG to clipboard; fall back to file download.
   * @returns {Promise<'copied'|'downloaded'>}
   */
  async function copyElementAsImage(el, filename = 'tokenwatch-compare.png') {
    const blob = await domToPngBlob(el);
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      try {
        // Some Chromium builds require a Promise-valued ClipboardItem map
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob }),
        ]);
        return 'copied';
      } catch (_) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': Promise.resolve(blob) }),
          ]);
          return 'copied';
        } catch (__) {
          /* fall through */
        }
      }
    }
    downloadBlob(blob, filename);
    return 'downloaded';
  }

  /** Wire "Copy as image" on all compare modals (event delegation). */
  function initCompareCapture() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('#compareCopyImage, .compare-copy-btn');
      if (!btn) return;
      e.preventDefault();
      const card = btn.closest('.compare-modal-content');
      if (!card) return;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Copying…';
      try {
        const stamp = new Date().toISOString().slice(0, 10);
        const result = await copyElementAsImage(card, `tokenwatch-compare-${stamp}.png`);
        btn.textContent = result === 'copied' ? 'Copied!' : 'Downloaded';
      } catch (err) {
        console.warn('Compare image capture failed:', err);
        btn.textContent = 'Failed';
      }
      setTimeout(() => {
        btn.textContent = prev;
        btn.disabled = false;
      }, 1600);
    });
  }

  // Auto-wire capture (defer scripts run after DOM parse)
  initCompareCapture();

  window.TW = {
    $, esc, median, fmtIST, debounce, round3, makeFormatters, initTheme, applyTheme, modal,
    domToPngBlob, copyElementAsImage, initCompareCapture,
  };
})();
