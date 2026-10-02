// Structural contracts for the compact-layout markup/CSS workstream.
//
// These pin the HTML/CSS contract shared with the app.js and advisor workers:
// stable element IDs, the closed "More filters" disclosure, the compact results
// header, the optional quantization column, and the shared header/actions
// wrapper. They intentionally assert structure and class hooks, not app logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(ROOT, p), 'utf8');

const PAGES = ['index', 'image', 'video', 'benchmarks'];

/** All id="..." values in document order (duplicates preserved). */
function ids(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

/** Slice of `html` strictly inside the element with id `id` (first match). */
function inside(html, id) {
  const open = html.indexOf(`id="${id}"`);
  assert.ok(open !== -1, `expected an element with id="${id}"`);
  const start = html.lastIndexOf('<', open);
  const end = html.indexOf('</details>', start);
  assert.ok(end !== -1, `expected a closing </details> for #${id}`);
  return html.slice(start, end);
}

test('owned pages keep unique element ids', async () => {
  for (const page of PAGES) {
    const html = await read(`public/${page}.html`);
    const seen = new Set();
    const dupes = [];
    for (const id of ids(html)) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    assert.deepEqual(dupes, [], `${page}.html has duplicate ids: ${dupes.join(', ')}`);
  }
});

test('every owned page wraps header actions in .header-links', async () => {
  for (const page of PAGES) {
    const html = await read(`public/${page}.html`);
    assert.match(html, /class="header-links"/, `${page}.html must expose .header-links for the advisor launcher`);
    const rowStart = html.indexOf('class="header-row"');
    const rowEnd = html.indexOf('</header>', rowStart);
    const row = html.slice(rowStart, rowEnd);
    assert.match(row, /class="header-links"/, `${page}.html .header-links must live inside .header-row`);
    // The theme toggle must sit inside the actions container, not float on its own.
    const linksStart = row.indexOf('class="header-links"');
    const links = row.slice(linksStart);
    assert.match(links, /id="themeToggle"/, `${page}.html theme toggle must live in .header-links`);
  }
});

test('text opening area keeps search + chips primary and moves secondary controls into a closed #moreFilters', async () => {
  const html = await read('public/index.html');

  // Search + popular chips stay outside the disclosure.
  const more = inside(html, 'moreFilters');
  for (const id of ['providerSearch', 'modelSearch', 'popularChips']) {
    assert.ok(!more.includes(`id="${id}"`), `#${id} must stay outside #moreFilters`);
  }

  // Native <details> that starts closed, labelled "More filters".
  const openTag = html.match(/<details[^>]*id="moreFilters"[^>]*>/);
  assert.ok(openTag, 'index.html must contain <details id="moreFilters">');
  assert.ok(!/\sopen(\s|>)/.test(openTag[0]), '#moreFilters must default to closed');
  assert.match(more, /<summary[^>]*>\s*More filters\s*<\/summary>/i, '#moreFilters summary must read "More filters"');

  // Every secondary control id lives inside the disclosure.
  const secondary = [
    'promoOnly', 'zdrOnly', 'subscriptionOnly', 'hideBatch', 'cacheOnly',
    'minIntelligence', 'minCoding', 'minAgentic', 'benchmarkedOnly',
    'maxBlended', 'minToks', 'hqFilter',
  ];
  for (const id of secondary) {
    assert.ok(more.includes(`id="${id}"`), `#${id} must live inside #moreFilters`);
  }

  // Preserve input types/attributes that app.js depends on.
  assert.match(html, /<input type="checkbox" id="hideBatch" checked \/>/, '#hideBatch must stay a checked checkbox');
  assert.match(html, /<input type="checkbox" id="cacheOnly" \/>/, '#cacheOnly must stay a checkbox');
  assert.match(html, /<input type="number" id="maxBlended"[^>]*step="0\.01"/, '#maxBlended numeric step preserved');
  assert.match(html, /<input type="number" id="minToks"[^>]*step="1"/, '#minToks numeric step preserved');
  assert.match(html, /<select id="hqFilter">/, '#hqFilter must stay a select');
});

test('#activeFilters (aria-live) and #clearFiltersBtn sit outside #moreFilters', async () => {
  const html = await read('public/index.html');
  const more = inside(html, 'moreFilters');

  assert.match(html, /id="activeFilters"[^>]*aria-live="polite"/, '#activeFilters must be an aria-live region');
  assert.ok(html.includes('id="clearFiltersBtn"'), 'index.html must include #clearFiltersBtn');
  assert.ok(!more.includes('id="activeFilters"'), '#activeFilters must sit outside #moreFilters');
  assert.ok(!more.includes('id="clearFiltersBtn"'), '#clearFiltersBtn must sit outside #moreFilters');

  // Both live after the disclosure so they stay reachable without expanding it.
  const close = html.indexOf('</details>', html.indexOf('id="moreFilters"'));
  assert.ok(html.indexOf('id="activeFilters"') > close, '#activeFilters must follow #moreFilters');
  assert.ok(html.indexOf('id="clearFiltersBtn"') > close, '#clearFiltersBtn must follow #moreFilters');
});

test('text page explains exact selection vs broad browsing', async () => {
  const html = await read('public/index.html');
  const help = html.match(/<p class="search-help">([\s\S]*?)<\/p>/);
  assert.ok(help, 'index.html must carry a .search-help explanation');
  assert.match(help[1], /exact/i, 'search help must mention exact model selection');
  assert.match(help[1], /brows/i, 'search help must mention broad browsing');
});

test('presets use concise names above the grid with one active description', async () => {
  const html = await read('public/index.html');
  const presetsIdx = html.indexOf('class="presets"');
  const gridIdx = html.indexOf('class="usage-grid"');
  assert.ok(presetsIdx !== -1 && gridIdx !== -1, 'index.html must contain .presets and .usage-grid');
  assert.ok(presetsIdx < gridIdx, '.presets must appear above .usage-grid');

  assert.ok(html.includes('id="presetDescription"'), 'index.html must include #presetDescription');
  for (const [preset, label] of [['agentic', 'Agentic'], ['balanced', 'Balanced'], ['heavy-output', 'Output-heavy'], ['no-cache', 'No cached reads']]) {
    assert.match(html, new RegExp(`<button data-preset="${preset}">${label}</button>`), `preset ${preset} must have a concise name`);
  }
  const presetsBlock = html.slice(presetsIdx, gridIdx);
  assert.match(presetsBlock, /id="presetDescription">[^<]*cache-heavy[^<]*<\/p>/,
    'the active preset must explain the mix once, below the named choices');
});

test('results area keeps #modelSummary before the table and adds #resultsBasis + #rankingExplanation', async () => {
  const html = await read('public/index.html');
  const summaryIdx = html.indexOf('id="modelSummary"');
  const tableIdx = html.indexOf('id="resultsTable"');
  assert.ok(summaryIdx !== -1 && tableIdx !== -1, 'index.html must keep #modelSummary and #resultsTable');
  assert.ok(summaryIdx < tableIdx, '#modelSummary must stay before the results table');

  assert.match(html, /id="resultsBasis"[^>]*aria-live="polite"/, '#resultsBasis must be an aria-live region');
  assert.ok(html.includes('id="rankingExplanation"'), 'index.html must include #rankingExplanation');
  const headingIdx = html.indexOf('id="resultsTitle"');
  assert.ok(html.indexOf('id="resultsBasis"') > headingIdx, '#resultsBasis must sit near the results heading');
  assert.ok(html.indexOf('id="rankingExplanation"') > headingIdx, '#rankingExplanation must sit near the results heading');
});

test('quantization column and mobile sort entries are present', async () => {
  const html = await read('public/index.html');
  const theadStart = html.indexOf('<thead>', html.indexOf('id="resultsTable"'));
  const thead = html.slice(theadStart, html.indexOf('</thead>', theadStart));

  assert.match(thead, /data-sort="quantization"[^>]*>[\s\S]*?Quantization/, 'Quantization must be a sortable header');
  assert.match(html, /value="quantization:asc"/, 'mobile sort must include quantization asc');
  assert.match(html, /value="quantization:desc"/, 'mobile sort must include quantization desc');

  // Skeleton colspan must match the header column count (locked # + middle + Total Cost).
  const thCount = (thead.match(/<th\b/g) || []).length;
  assert.equal(thCount, 14, 'results table must expose 14 columns (incl. Quantization)');
  assert.match(html, /<td colspan="14">/, 'skeleton rows must span every column');
});

test('Columns trigger and Blended $/M cache-write explanation are present', async () => {
  const html = await read('public/index.html');
  const btn = html.match(/<button[^>]*id="colConfigBtn"[^>]*>([^<]*)<\/button>/);
  assert.ok(btn, 'index.html must keep #colConfigBtn');
  assert.equal(btn[1].trim(), 'Columns', 'column trigger must be labelled "Columns"');

  const blendedTh = html.match(/<th[^>]*data-sort="blended"[^>]*>/);
  assert.ok(blendedTh, 'index.html must keep the Blended $/M header');
  assert.match(blendedTh[0], /title="[^"]*higher published cache-write rates for fresh input/i);
  assert.doesNotMatch(blendedTh[0], /excluding one-time cache-write/);
});

// ── WCAG contrast for status text on its own tinted background ──────────────
function srgbChannel(hex, i) {
  const v = parseInt(hex.replace('#', '').substr(i * 2, 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  return 0.2126 * srgbChannel(hex, 0) + 0.7152 * srgbChannel(hex, 1) + 0.0722 * srgbChannel(hex, 2);
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** color-mix(in srgb, fg p, transparent) composited over an opaque bg. */
function tint(fg, bg, p) {
  const f = fg.replace('#', '');
  const b = bg.replace('#', '');
  const out = [0, 1, 2].map((i) =>
    Math.round(parseInt(f.substr(i * 2, 2), 16) * p + parseInt(b.substr(i * 2, 2), 16) * (1 - p)));
  return '#' + out.map((x) => x.toString(16).padStart(2, '0')).join('');
}
function themeVar(css, block, name) {
  const start = css.indexOf(block);
  assert.ok(start !== -1, `styles.css must define ${block}`);
  const end = css.indexOf('}', start);
  const scope = css.slice(start, end);
  const m = scope.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `styles.css must define --${name} in ${block}`);
  return m[1];
}

test('status text tokens meet WCAG AA contrast in both themes', async () => {
  const css = await read('public/styles.css');
  const light = {
    green: themeVar(css, ':root {', 'green'),
    yellow: themeVar(css, ':root {', 'yellow'),
    blue: themeVar(css, ':root {', 'blue'),
    accent: themeVar(css, ':root {', 'accent'),
    onAccent: themeVar(css, ':root {', 'on-accent'),
    accentText: themeVar(css, ':root {', 'accent-text'),
  };
  const dark = {
    green: themeVar(css, '[data-theme="dark"] {', 'green'),
    yellow: themeVar(css, '[data-theme="dark"] {', 'yellow'),
    blue: themeVar(css, '[data-theme="dark"] {', 'blue'),
    accent: themeVar(css, '[data-theme="dark"] {', 'accent'),
    onAccent: themeVar(css, '[data-theme="dark"] {', 'on-accent'),
    accentText: themeVar(css, '[data-theme="dark"] {', 'accent-text'),
  };

  const checks = [
    ['light pct-ok green on surface', light.green, '#FFFFFF', 4.5],
    ['light pct-warn yellow on surface', light.yellow, '#FFFFFF', 4.5],
    ['light promo badge text on tint', light.yellow, tint(light.yellow, '#FFFFFF', 0.2), 4.5],
    ['light zdr badge text on tint', light.green, tint(light.green, '#FFFFFF', 0.2), 4.5],
    ['light subscription badge text on tint', light.blue, tint(light.blue, '#FFFFFF', 0.2), 4.5],
    ['light subscription badge on background tint', light.blue, tint(light.blue, '#F8F5F0', 0.2), 4.5],
    ['light selected chip on accent', light.onAccent, light.accent, 4.5],
    ['light accent text on surface', light.accentText, '#FFFFFF', 4.5],
    ['dark green on surface', dark.green, '#242020', 4.5],
    ['dark yellow on surface', dark.yellow, '#242020', 4.5],
    ['dark promo badge text on tint', dark.yellow, tint(dark.yellow, '#242020', 0.2), 4.5],
    ['dark zdr badge text on tint', dark.green, tint(dark.green, '#242020', 0.2), 4.5],
    ['dark subscription badge text on tint', dark.blue, tint(dark.blue, '#242020', 0.2), 4.5],
    ['dark selected chip on accent', dark.onAccent, dark.accent, 4.5],
    ['dark accent text on surface', dark.accentText, '#242020', 4.5],
    ['dark accent text on bg', dark.accentText, '#1a1612', 4.5],
  ];
  for (const [label, fg, bg, min] of checks) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= min, `${label}: ${fg} on ${bg} is ${ratio.toFixed(2)} (< ${min})`);
  }
});

test('history error text meets AA and its already-dim detail is not faded again', async () => {
  const css = await read('public/styles.css');
  const error = css.match(/\.tw-spark\[data-state="error"\] \.tw-spark-message \{([\s\S]*?)\}/)[1];
  const color = error.match(/\bcolor:\s*(#[a-f0-9]{6})/i)[1];
  assert.ok(contrast(color, '#F3F7FB') >= 4.5, 'light error text must clear 4.5:1');
  const detail = css.match(/\.tw-spark-detail \{([\s\S]*?)\}/)[1];
  assert.doesNotMatch(detail, /opacity:\s*0\./, 'opacity must not reduce caption contrast');
});

test('styles.css supports the compact layout contracts', async () => {
  const css = await read('public/styles.css');

  // Header actions + filters + active filter chips.
  assert.match(css, /\.header-links\s*\{/, 'styles.css must style .header-links');
  assert.match(css, /\.more-filters\s*\{/, 'styles.css must style .more-filters');
  assert.match(css, /\.active-filters\b/, 'styles.css must style #activeFilters');
  assert.match(css, /\.clear-filters-btn\b/, 'styles.css must style #clearFiltersBtn');
  assert.match(css, /\.repo-link\s*\{[\s\S]*?color: var\(--accent-text\)/, 'header links must use the contrast-safe accent text token');
  assert.match(css, /\.clear-filters-btn\s*\{[\s\S]*?color: var\(--accent-text\)/, 'clear filters must use the contrast-safe accent text token');
  assert.match(css, /\.search-help\b/, 'styles.css must style .search-help');
  assert.match(css, /\.preset-description\b/, 'styles.css must style .preset-description');

  // Compact summary + native details distribution.
  assert.match(css, /\.model-summary\s+details/, 'styles.css must style the native summary distribution');
  assert.match(css, /\.model-summary-distribution\b/, 'styles.css must style .model-summary-distribution');

  // Quantization hide/reorder support on desktop and mobile.
  assert.match(css, /#resultsTable\.hide-col-quantization th\[data-sort="quantization"\]/, 'hide-col-quantization header rule');
  assert.match(css, /#resultsTable td\[data-label="Quantization"\]/, 'mobile quantization label rule');

  // Mobile model title readability.
  assert.match(css, /#resultsTable td\[data-label="Model"\][\s\S]*?display:\s*block/, 'mobile Model cell must render full-width');
});
