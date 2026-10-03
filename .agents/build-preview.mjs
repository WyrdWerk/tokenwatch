// Orb-only staging: fewer classic-script requests, unchanged production assets.
import assert from 'node:assert/strict';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';

const source = new URL('../public/', import.meta.url);
const output = new URL('../.amp/preview/', import.meta.url);
const names = ['shared-ui.js', 'price-sparkline.js', 'model-history.js', 'app.js', 'advisor-widget.js', 'webmcp.js'];
const html = await readFile(new URL('index.html', source), 'utf8');
const pattern = /  <script src="\/([^"]+)" defer><\/script>\n/g;
const tags = [...html.matchAll(pattern)];
assert.deepEqual(tags.map(tag => tag[1].split('?')[0]), names,
  'Preview expects the classic scripts in their original deferred order');
const scripts = await Promise.all(names.map(name => readFile(new URL(name, source), 'utf8')));

// These styles use absolute /fonts/ URLs. Inlining preserves their cascade and
// lets the browser discover fonts without waiting for another stylesheet RTT.
let previewHtml = html;
for (const link of html.matchAll(/  <link rel="stylesheet" href="\/([^"]+)" \/>/g)) {
  const css = await readFile(new URL(link[1].split('?')[0], source), 'utf8');
  previewHtml = previewHtml.replace(link[0], `  <style>\n${css}\n  </style>`);
}

await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
// Preserve classic global scope and the absolute /share-snapshot.mjs import.
// The separator also prevents a trailing expression joining the next script.
await writeFile(new URL('preview-text.js', output), scripts.join('\n;\n'));
let first = true;
await writeFile(new URL('index.html', output), previewHtml.replace(pattern, () => {
  if (!first) return '';
  first = false;
  return '  <script src="/preview-text.js" defer></script>\n';
}));
console.log('Orb preview staged in .amp/preview (production public/ unchanged).');
