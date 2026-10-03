import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);

test('preview preloads pricing as a matching fetch on the resolved homepage only', async () => {
  const config = JSON.parse(await readFile(new URL('.agents/preview-serve.json', root), 'utf8'));
  assert.deepEqual(config.headers, [{
    source: 'index.html',
    headers: [{
      key: 'Link',
      value: '</pricing.json>; rel=preload; as=fetch; crossorigin=anonymous',
    }],
  }]);
});

test('only the orb preview command opts into the generated preview and preload config', async () => {
  const services = await readFile(new URL('.amp/services.yaml', root), 'utf8');
  // serve resolves relative config paths against its served directory, not cwd.
  assert.match(services, /command: node \.agents\/build-preview\.mjs && serve \.amp\/preview -l tcp:\/\/0\.0\.0\.0:"\$PORT" --config "\$PWD\/\.agents\/preview-serve\.json"/);
  const html = await readFile(new URL('public/index.html', root), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.doesNotMatch(html, /preview-text|preview-serve|rel="preload"[^>]*pricing\.json/);
  assert.doesNotMatch(pkg.scripts['build:prod'], /preview/);
});

test('preview combines classic scripts in order without changing production sources or sharing resolution', async () => {
  const names = ['shared-ui.js', 'price-sparkline.js', 'model-history.js', 'app.js', 'advisor-widget.js', 'webmcp.js'];
  const sourceHtml = await readFile(new URL('public/index.html', root), 'utf8');
  const sourceScripts = await Promise.all(names.map(name => readFile(new URL(`public/${name}`, root), 'utf8')));
  execFileSync(process.execPath, [new URL('.agents/build-preview.mjs', root).pathname]);
  const preview = new URL('.amp/preview/', root);
  const html = await readFile(new URL('index.html', preview), 'utf8');
  const bundle = await readFile(new URL('preview-text.js', preview), 'utf8');
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(match => match[1]), ['/preview-text.js']);
  const tags = names.map(name => `  <script src="/${name}?v=dev" defer></script>`).join('\n');
  let restored = html.replace('  <script src="/preview-text.js" defer></script>', tags);
  for (const name of ['styles.css', 'advisor-widget.css']) {
    const css = await readFile(new URL(`public/${name}`, root), 'utf8');
    const inline = `  <style>\n${css}\n  </style>`;
    assert.ok(html.includes(inline), `${name} must be inlined unchanged to avoid a font-discovery round trip`);
    restored = restored.replace(inline, `  <link rel="stylesheet" href="/${name}?v=dev" />`);
  }
  assert.equal(restored, sourceHtml);
  let previousEnd = 0;
  for (const [index, source] of sourceScripts.entries()) {
    const start = bundle.indexOf(source, previousEnd);
    assert.ok(start >= previousEnd, `${names[index]} must retain its exact contents and execution order`);
    previousEnd = start + source.length;
    assert.equal(await readFile(new URL(`public/${names[index]}`, root), 'utf8'), source);
  }
  assert.match(bundle, /import\('\/share-snapshot\.mjs'\)/);
  execFileSync(process.execPath, ['--check', new URL('preview-text.js', preview).pathname]);
  for (const name of ['share-snapshot.mjs', 'pricing.json', 'performance.json', 'styles.css', 'image.html', 'video.html', 'benchmarks.html']) {
    assert.deepEqual(await readFile(new URL(name, preview)), await readFile(new URL(`public/${name}`, root)));
  }
  assert.equal(await readFile(new URL('public/index.html', root), 'utf8'), sourceHtml);
  const ignore = await readFile(new URL('.gitignore', root), 'utf8');
  assert.match(ignore, /^\.amp\/preview\/$/m);
});
