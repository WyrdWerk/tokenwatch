import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { baseAssetName, bustHtml, findHtmlFiles } from '../scripts/bust-cache.mjs';

test('findHtmlFiles discovers nested generated pages and skips hashed/temp directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tokenwatch-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, 'providers', 'alpha'), { recursive: true }),
    mkdir(join(root, 'docs', 'api'), { recursive: true }),
    mkdir(join(root, 'h'), { recursive: true }),
    mkdir(join(root, '.providers-temp'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'index.html'), '<html></html>'),
    writeFile(join(root, 'providers', 'alpha', 'index.html'), '<html></html>'),
    writeFile(join(root, 'docs', 'api', 'index.html'), '<html></html>'),
    writeFile(join(root, 'h', 'ignored.html'), '<html></html>'),
    writeFile(join(root, '.providers-temp', 'ignored.html'), '<html></html>'),
  ]);

  const files = (await findHtmlFiles(root)).map((file) => relative(root, file));
  assert.deepEqual(files, ['docs/api/index.html', 'index.html', 'providers/alpha/index.html']);
});

test('bustHtml writes root-relative assets and rehashes nested-page references idempotently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tokenwatch-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'index.html');
  await writeFile(file, '<link rel="stylesheet" href="/styles.css?v=dev"><script src="/h/app.11111111.js"></script>');

  const first = new Map([['styles.css', 'aaaaaaaa'], ['app.js', 'bbbbbbbb']]);
  assert.equal(await bustHtml(file, first), 2);
  assert.equal(await readFile(file, 'utf8'), '<link rel="stylesheet" href="/h/styles.aaaaaaaa.css"><script src="/h/app.bbbbbbbb.js"></script>');

  const second = new Map([['styles.css', 'cccccccc'], ['app.js', 'dddddddd']]);
  assert.equal(await bustHtml(file, second), 2);
  assert.equal(await readFile(file, 'utf8'), '<link rel="stylesheet" href="/h/styles.cccccccc.css"><script src="/h/app.dddddddd.js"></script>');
  assert.equal(baseAssetName('/h/styles.cccccccc.css'), 'styles.css');
});
