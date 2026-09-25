import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('verify-seo exempts public/404.html from the one-canonical-link rule', async () => {
  const src = await readFile(join(ROOT, 'scripts', 'verify-seo.mjs'), 'utf8');
  const html = await readFile(join(ROOT, 'public', '404.html'), 'utf8');
  assert.equal((html.match(/<link rel="canonical"/g) || []).length, 0,
    '404.html is noindex and has no canonical — the verifier must skip it, not require one');
  assert.match(html, /noindex/);
  // Same pattern as the widget demo exemption: skip 404.html by path.
  assert.match(src, /404\.html/,
    'verify-seo.mjs must mention 404.html so the canonical loop does not fail CI');
});

// ── Committed HTML must not reference absent /h/ assets ───────────────────────
//
// bust-cache.mjs rewrites `?v=` refs to content-hashed `/h/*` paths at deploy
// time, and those hashed copies are deliberately NOT committed. A source page
// that keeps a `/h/` ref therefore 404s its stylesheet in a clean checkout —
// which is exactly what shipped once in the sparkline state gallery.

test('no committed HTML references an absent /h/ asset', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await walk(full));
      else files.push(full);
    }
    return files;
  }

  const htmlFiles = (await walk(join(ROOT, 'public'))).filter((f) => f.endsWith('.html'));
  assert.ok(htmlFiles.length > 50, `expected the generated site, found ${htmlFiles.length} HTML files`);

  const offenders = [];
  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/(?:href|src)="(\/h\/[^"]+)"/g)) {
      const target = join(ROOT, 'public', match[1].replace(/^\//, ''));
      if (!existsSync(target)) offenders.push(`${file.slice(ROOT.length + 1)} → ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'source HTML must use the plain ?v= form; /h/* copies are generated at deploy and not committed');
});

test('the sparkline state gallery loads its assets from deploy-safe source paths', async () => {
  const html = await readFile(join(ROOT, 'public', 'docs', 'price-history-states', 'index.html'), 'utf8');
  // Plain source paths, matching the other generated pages.
  assert.match(html, /href="\/styles\.css\?v=dev"/);
  assert.match(html, /src="\/price-sparkline\.js\?v=dev"/);
  assert.match(html, /src="\/model-history\.js\?v=dev"/);
  // And no hashed deploy-only paths.
  assert.doesNotMatch(html, /\/h\//);
});

test('verify-seo guards against absent /h/ references', async () => {
  const src = await readFile(join(ROOT, 'scripts', 'verify-seo.mjs'), 'utf8');
  assert.match(src, /missingHashedAssets/, 'verify-seo.mjs must scan for absent /h/ assets');
  assert.match(src, /absent \/h\/ assets/);
});
