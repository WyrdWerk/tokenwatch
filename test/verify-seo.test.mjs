import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectModelPages, renderModelPage } from '../scripts/seo-pages.mjs';
import * as verifier from '../scripts/verify-seo.mjs';

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

test('all calculator entry points expose model discovery and PNG social metadata', async () => {
  for (const page of ['index', 'image', 'video', 'benchmarks']) {
    const html = await readFile(join(ROOT, 'public', `${page}.html`), 'utf8');
    assert.match(html, /<nav class="tab-nav"[\s\S]*?href="\/models\/">Models<\/a>/, `${page} model discovery`);
    assert.match(html, /href="\/choose\/">Choose<\/a>[\s\S]*?href="\/models\/">Models<\/a>/, `${page} Choose nav order`);
    for (const field of ['property="og:image"', 'name="twitter:image"']) {
      assert.ok(html.includes(`${field} content="https://tokenwatch.wyrdwerk.com/og/og-image.png"`), `${page} ${field}`);
    }
    assert.match(html, /property="og:image:alt"/);
    const description = html.match(/name="description" content="([^"]+)"/)[1];
    assert.ok(html.includes(`property="og:description" content="${description}"`), `${page} social description`);
    assert.ok(html.includes(`name="twitter:description" content="${description}"`), `${page} Twitter description`);
    const schema = html.match(/id="seo-structured-data" type="application\/ld\+json">(.*?)<\/script>/);
    assert.ok(schema, `${page} must expose generated structured data`);
    const data = JSON.parse(schema[1])['@graph'][0];
    assert.equal(data.url, html.match(/rel="canonical" href="([^"]+)"/)[1], `${page} schema URL`);
  }
  const choose = await readFile(join(ROOT, 'public', 'choose', 'index.html'), 'utf8');
  assert.match(choose, /href="\/choose\/" aria-current="page">Choose<\/a>/);
  assert.match(choose, /Which open model should you use, and where\?/);
  assert.match(choose, /name="useCase"/);
  assert.equal((choose.match(/name="useCase"/g) || []).length, 9);
  assert.match(choose, /src="\/choose-app\.js\?v=dev"/);
  const pageScript = await readFile(join(ROOT, 'public', 'choose-app.js'), 'utf8');
  assert.match(pageScript, /from '\/shared\/recommend\.mjs'/);
  assert.match(pageScript, /window\.TW\.initTheme\(\)/, 'choose page must initialize the shared theme toggle');
  for (const module of ['choose-page.mjs', 'recommend.mjs', 'use-cases.mjs', 'cost.mjs', 'normalize.mjs']) {
    await readFile(join(ROOT, 'public', 'shared', module), 'utf8');
  }
  const sitemap = await readFile(join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes('<loc>https://tokenwatch.wyrdwerk.com/choose/</loc>'));
  const png = await readFile(join(ROOT, 'public', 'og', 'og-image.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  const svg = await readFile(join(ROOT, 'public', 'og', 'og-image.svg'), 'utf8');
  assert.doesNotMatch(svg, /\d+ providers|\d+ models/, 'social card copy must not age with the catalog');
});

test('all raw catalog/reference JSON and the widget demo are excluded from search results', async () => {
  const headers = await readFile(join(ROOT, 'public', '_headers'), 'utf8');
  const files = (await readdir(join(ROOT, 'public'))).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 8);
  for (const name of files) {
    assert.ok(headers.includes(`/${name}\n  X-Robots-Tag: noindex`), name);
  }
  const demo = await readFile(join(ROOT, 'public', 'widget', 'demo.html'), 'utf8');
  assert.match(demo, /name="robots" content="noindex/);
});

test('generated landing pages exactly preserve the published URL registry', async () => {
  const registry = JSON.parse(await readFile(join(ROOT, 'data', 'seo-published-pages.json'), 'utf8'));
  const sitemap = await readFile(join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  for (const type of ['providers', 'models']) {
    const entries = await readdir(join(ROOT, 'public', type), { withFileTypes: true });
    const slugs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
    assert.equal(registry[type].length, new Set(registry[type]).size, `${type} registry duplicates`);
    assert.deepEqual(slugs, [...registry[type]].sort(), `${type} must neither disappear nor expand`);
    for (const slug of slugs) assert.ok(sitemap.includes(`<loc>https://tokenwatch.wyrdwerk.com/${type}/${slug}/</loc>`), slug);
  }
});

test('history validation accepts omission but rejects partially wired or misleading panels', () => {
  const [page] = collectModelPages({ pricing: { models: ['a', 'b', 'c'].map((provider) => ({
    id: 'model', name: 'Model', provider, pricing: { input: 1, output: 2, cache_read: 0.1 },
  })) } });
  const disabled = renderModelPage(page, { historyEnabled: false });
  const enabled = renderModelPage(page, { historyEnabled: true });
  assert.doesNotThrow(() => verifier.assertModelHistory(disabled, 'disabled'));
  assert.doesNotThrow(() => verifier.assertModelHistory(enabled, 'enabled'));
  for (const missing of ['data-price-history-chart', 'model-history.js', 'price-sparkline.js', 'Loading price history']) {
    assert.throws(() => verifier.assertModelHistory(enabled.replaceAll(missing, 'removed'), 'broken'), /verify-seo:/, missing);
  }
  assert.throws(() => verifier.assertModelHistory(disabled.replace('</main>', '<p>Retained for up to 90 days</p></main>'), 'misleading'), /verify-seo:/);
});
