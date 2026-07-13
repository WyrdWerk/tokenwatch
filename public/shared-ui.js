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

  window.TW = { $, esc, median, fmtIST, debounce, round3, makeFormatters, initTheme, applyTheme, modal };
})();
