import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DELIVERY_VARIANTS } from '../shared/normalize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The browser loads public/shared/*.mjs (written by generate-seo.mjs), not
// shared/. A stale copy silently serves old variant rules to the choose page.
test('public/shared modules are byte-identical to shared/', async () => {
  const files = (await readdir(join(ROOT, 'public', 'shared'))).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.includes('normalize.mjs'));
  for (const file of files) {
    const [src, served] = await Promise.all([
      readFile(join(ROOT, 'shared', file), 'utf8'),
      readFile(join(ROOT, 'public', 'shared', file), 'utf8'),
    ]);
    assert.equal(served, src, `public/shared/${file} is stale; run node scripts/generate-seo.mjs`);
  }
});

// app.js is a classic script and cannot import DELIVERY_VARIANTS, so every
// hand-written variant alternation in it must list exactly the shared set.
test('app.js delivery-variant regexes match DELIVERY_VARIANTS', async () => {
  const src = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
  const groups = [...src.matchAll(/\/:\(([a-z|-]+)\)\$\/i?/g)]
    .map((m) => m[1].split('|'))
    .filter((alts) => alts.includes('flex'));
  assert.equal(groups.length, 3, 'expected modelSpellingKey, DELIVERY_SUFFIX_RE and isBatchOrFreeId');
  const want = [...DELIVERY_VARIANTS].sort();
  for (const alts of groups) {
    // isBatchOrFreeId matches ':batch' separately via includes().
    const got = (alts.includes('batch') ? alts : ['batch', ...alts]).sort();
    assert.deepEqual(got, want, `app.js variant list ${alts.join('|')} drifted from DELIVERY_VARIANTS`);
  }
});

test('choose-app.js uses the shared deliveryVariant helper, not its own list', async () => {
  const src = await readFile(join(ROOT, 'public', 'choose-app.js'), 'utf8');
  assert.match(src, /import \{ deliveryVariant \} from '\/shared\/normalize\.mjs'/);
  assert.doesNotMatch(src, /\|flex\|priority/);
});
