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
