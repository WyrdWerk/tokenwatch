// TokenWatch — shared-ui.js
// Classic script (no ES modules, no build step). Loaded with `defer` BEFORE
// each page's app script, so window.TW exists by the time app code runs.
// Holds only helpers that are byte-identical (or cleanly parameterizable)
// across the Text/Image/Video pages. Page-local, drift-prone, or state-bound
// logic stays in each app file.
(function () {
  'use strict';
  // Absolute URL is required because deployed app scripts execute from /h/.
  // Preload at startup so Web Share keeps its click activation.
  const snapshotCodecPromise = import('/share-snapshot.mjs');

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
    const rootStyle = getComputedStyle(document.documentElement);
    const textColor = getComputedStyle(el).color || (theme === 'dark' ? '#f0ebe3' : '#1a1612');
    const dimColor = rootStyle.getPropertyValue('--text-dim').trim()
      || (theme === 'dark' ? '#a3988a' : '#6b635a');
    const accent = rootStyle.getPropertyValue('--accent').trim() || '#0d7377';
    const bestColor = rootStyle.getPropertyValue('--green').trim() || '#2d8a5a';
    const bestBg = theme === 'dark' ? '#183b2b' : '#e5f4eb';
    const border = rootStyle.getPropertyValue('--border').trim()
      || (theme === 'dark' ? '#3a342c' : '#ddd5c8');
    const surface = rootStyle.getPropertyValue('--surface').trim()
      || (theme === 'dark' ? '#242018' : '#fff');

    const pad = 24;
    const inset = 12;
    const brand = el.querySelector('.compare-brand-link');
    const title = el.querySelector('.compare-modal-header h2');
    const snapshot = el.querySelector('.compare-snapshot');
    const table = el.querySelector('.compare-table');
    const rows = table ? Array.from(table.querySelectorAll('tr')) : [];
    const grid = rows.map((tr) => Array.from(tr.children).map((cell, ci) => {
      const style = getComputedStyle(cell);
      return {
        text: (cell.textContent || '').replace(/\s+/g, ' ').trim(),
        isHead: cell.tagName === 'TH',
        isLabel: cell.classList.contains('compare-label'),
        isValue: ci > 0,
        isBest: cell.classList.contains('compare-cheapest'),
        font: `${style.fontWeight || 400} ${style.fontSize || '12px'} ${style.fontFamily || 'system-ui'}`,
        fontSize: parseFloat(style.fontSize) || 12,
      };
    }));
    const colCount = grid.reduce((max, row) => Math.max(max, row.length), 0) || 1;

    let colWidths = [];
    if (table && table.rows[0]) {
      colWidths = Array.from(table.rows[0].cells).map((cell) => Math.ceil(cell.getBoundingClientRect().width));
    }
    if (colWidths.length !== colCount || colWidths.some((width) => width < 1)) {
      colWidths = Array(colCount).fill(160);
      colWidths[0] = 168;
    }
    const rowHeights = rows.map((row) => Math.max(38, Math.ceil(row.getBoundingClientRect().height) || 38));

    const brandH = 30;
    const titleGap = 8;
    const snapH = snapshot ? Math.max(44, Math.ceil(snapshot.getBoundingClientRect().height) || 44) : 0;
    const tableW = colWidths.reduce((sum, width) => sum + width, 0);
    const contentW = Math.max(tableW, 420);
    const width = contentW + pad * 2;
    const height = pad + brandH + titleGap + (snapH ? snapH + 12 : 0)
      + rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0) + pad;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    function wrapLines(text, maxWidth, maxLines) {
      if (!text) return [''];
      const words = [];
      for (const word of text.split(/\s+/)) {
        if (ctx.measureText(word).width <= maxWidth) {
          words.push(word);
          continue;
        }
        let part = '';
        for (const char of word) {
          if (part && ctx.measureText(part + char).width > maxWidth) {
            words.push(part);
            part = char;
          } else {
            part += char;
          }
        }
        if (part) words.push(part);
      }
      const lines = [];
      let line = '';
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      if (line) lines.push(line);
      if (lines.length <= maxLines) return lines;
      const kept = lines.slice(0, maxLines);
      let last = kept[maxLines - 1];
      while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      kept[maxLines - 1] = `${last.trimEnd()}…`;
      return kept;
    }

    function drawLines(lines, x, y, rowHeight, align, lineHeight) {
      const firstY = y + (rowHeight - lines.length * lineHeight) / 2 + lineHeight / 2;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      lines.forEach((line, index) => ctx.fillText(line, x, firstY + index * lineHeight));
    }

    ctx.fillStyle = solidBg(el, pageBg);
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

    let y = pad;
    ctx.fillStyle = accent;
    ctx.font = '700 14px Inter, system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const brandText = (brand && brand.textContent.trim()) || 'TokenWatch';
    ctx.fillText(brandText, pad, y + brandH / 2);
    if (title) {
      const brandWidth = ctx.measureText(brandText).width;
      ctx.fillStyle = textColor;
      ctx.font = '650 18px Inter, system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText((title.textContent || 'Comparison').trim(), pad + brandWidth + 16, y + brandH / 2);
    }
    y += brandH + titleGap;

    if (snapshot) {
      ctx.fillStyle = surface;
      ctx.fillRect(pad, y, contentW, snapH);
      ctx.strokeStyle = border;
      ctx.strokeRect(pad + 0.5, y + 0.5, contentW - 1, snapH - 1);
      ctx.fillStyle = textColor;
      ctx.font = '500 12px Inter, system-ui, -apple-system, Segoe UI, sans-serif';
      const snapshotText = (snapshot.textContent || '').replace(/\s+/g, ' ').trim();
      const lineHeight = 16;
      const maxLines = Math.max(1, Math.floor((snapH - 16) / lineHeight));
      drawLines(wrapLines(snapshotText, contentW - inset * 2, maxLines), pad + inset, y, snapH, 'left', lineHeight);
      y += snapH + 12;
    }

    grid.forEach((row, rowIndex) => {
      let x = pad;
      const rowHeight = rowHeights[rowIndex] || 38;
      row.forEach((cell, cellIndex) => {
        const cellWidth = colWidths[cellIndex] || 160;
        ctx.fillStyle = cell.isBest ? bestBg : (cell.isHead || cell.isLabel ? surface : solidBg(el, pageBg));
        ctx.fillRect(x, y, cellWidth, rowHeight);
        ctx.strokeStyle = border;
        ctx.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, rowHeight - 1);

        ctx.fillStyle = cell.isBest ? bestColor : (cell.isHead || cell.isLabel ? dimColor : textColor);
        ctx.font = cell.isBest
          ? cell.font.replace(/^\d+/, '600')
          : cell.font;
        const lineHeight = Math.max(16, Math.ceil(cell.fontSize + 4));
        const maxLines = Math.max(1, Math.floor((rowHeight - 12) / lineHeight));
        const lines = wrapLines(cell.text, cellWidth - inset * 2, maxLines);
        drawLines(
          lines,
          cell.isValue ? x + cellWidth - inset : x + inset,
          y,
          rowHeight,
          cell.isValue ? 'right' : 'left',
          lineHeight,
        );
        x += cellWidth;
      });
      y += rowHeight;
    });

    ctx.fillStyle = dimColor;
    ctx.font = '400 10px Inter, system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText('tokenwatch.wyrdwerk.com', pad, height - 12);

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

  /** Freeze the exact visible values of a cost/comparison card for a share URL. */
  function snapshotFromCard(card, kind) {
    const table = card && card.querySelector('.compare-table');
    const header = table && table.tHead && table.tHead.rows[0];
    if (!table || !header || header.cells.length < 2) throw new Error('snapshot card is missing its comparison table');
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const columns = Array.from(header.cells).slice(1).map((cell) => clean(cell.textContent));
    const rows = Array.from(table.tBodies[0]?.rows || []).map((row) => {
      const cells = Array.from(row.cells);
      const values = cells.slice(1).map((cell) => clean(cell.textContent));
      const best = cells.slice(1).flatMap((cell, index) => cell.classList.contains('compare-cheapest') ? [index] : []);
      return [clean(cells[0]?.textContent), values, best];
    });
    return {
      v: 1,
      k: kind,
      t: clean(card.querySelector('.compare-modal-header h2')?.textContent) || (kind === 'cost' ? 'Cost card' : 'Comparison'),
      b: clean(card.querySelector('.compare-snapshot')?.textContent),
      c: columns,
      r: rows,
      m: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
      d: new Date().toISOString().slice(0, 10),
    };
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand && document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('clipboard is unavailable');
  }

  /** Share a direct image URL containing an immutable snapshot payload. */
  async function shareElementAsUrl(card, kind) {
    const { encodeSnapshot } = await snapshotCodecPromise;
    const encoded = encodeSnapshot(snapshotFromCard(card, kind));
    const url = new URL('/share', window.location.origin);
    url.searchParams.set('d', encoded);
    const shareUrl = url.toString();
    const title = kind === 'cost' ? 'TokenWatch cost card' : 'TokenWatch comparison';

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text: `${title} snapshot`, url: shareUrl });
        return { result: 'shared', url: shareUrl };
      } catch (error) {
        if (error && error.name === 'AbortError') return { result: 'cancelled', url: shareUrl };
        // Web Share may exist but reject URLs in desktop/headless environments.
      }
    }
    await copyText(shareUrl);
    return { result: 'copied', url: shareUrl };
  }

  /** Wire image copy and immutable URL sharing on comparison modals. */
  function initCompareCapture() {
    document.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest && e.target.closest('#compareCopyImage, .compare-copy-btn');
      const shareBtn = e.target.closest && e.target.closest('#compareShareImage, .compare-share-btn');
      const btn = shareBtn || copyBtn;
      if (!btn) return;
      e.preventDefault();
      const card = btn.closest('.compare-modal-content');
      if (!card) return;
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = shareBtn ? 'Sharing…' : 'Copying…';
      try {
        if (shareBtn) {
          const { result } = await shareElementAsUrl(card, 'comparison');
          btn.textContent = result === 'shared' ? 'Shared!' : result === 'copied' ? 'URL copied!' : 'Cancelled';
        } else {
          const stamp = new Date().toISOString().slice(0, 10);
          const result = await copyElementAsImage(card, `tokenwatch-compare-${stamp}.png`);
          btn.textContent = result === 'copied' ? 'Copied!' : 'Downloaded';
        }
      } catch (err) {
        console.warn(shareBtn ? 'Compare URL sharing failed:' : 'Compare image capture failed:', err);
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
    domToPngBlob, downloadBlob, copyElementAsImage, snapshotFromCard, shareElementAsUrl, initCompareCapture,
  };
})();
