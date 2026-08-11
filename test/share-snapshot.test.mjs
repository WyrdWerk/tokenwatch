import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SNAPSHOT_LIMITS,
  decodeSnapshot,
  encodeSnapshot,
  renderSnapshotSvg,
  validateSnapshot,
} from '../public/share-snapshot.mjs';
import { onRequest as shareRoute } from '../functions/share.js';

const snapshot = {
  v: 1,
  k: 'comparison',
  t: 'Comparison',
  b: 'Basis: 100M tokens · Input 2.5% · Cached 97% · Output 0.5%',
  c: ['Z.ai: GLM 5.2', 'Model <script>alert(1)</script>'],
  r: [
    ['Provider', ['Crof', 'Example & Co'], []],
    ['Blended $/M', ['$0.012', '$0.019'], [0]],
    ['Speed', ['60 tps', '—'], [0]],
    ['ZDR', ['ZDR', '—'], []],
  ],
  m: 'light',
  d: '2026-08-11',
};

test('snapshot URL codec preserves the exact frozen card values', () => {
  const encoded = encodeSnapshot(snapshot);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeSnapshot(encoded), snapshot);
});

test('cost snapshots require exactly one model column', () => {
  assert.throws(
    () => validateSnapshot({ ...snapshot, k: 'cost' }),
    /cost cards require exactly one value column/,
  );
});

test('snapshot codec rejects malformed and oversized URL payloads', () => {
  assert.throws(() => decodeSnapshot('not_valid!'), /invalid characters/);
  assert.throws(
    () => decodeSnapshot('a'.repeat(SNAPSHOT_LIMITS.maxEncodedChars + 1)),
    /missing or too large/,
  );
});

test('shared SVG escapes snapshot text and aligns labels opposite value columns', () => {
  const svg = renderSnapshotSvg(snapshot);
  assert.match(svg, /^<svg /);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /text-anchor="start"[^>]*>Provider<\/text>/);
  assert.match(svg, /text-anchor="end"[^>]*>Crof<\/text>/);
  assert.match(svg, /fill="#e5f4eb"/);
  assert.match(svg, /Snapshot 2026-08-11 · tokenwatch\.wyrdwerk\.com/);
});

test('share route serves the encoded snapshot directly as an immutable SVG image', async () => {
  const encoded = encodeSnapshot(snapshot);
  const response = await shareRoute({
    request: new Request(`https://tokenwatch.wyrdwerk.com/share?d=${encoded}`),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(response.headers.get('content-disposition'), /tokenwatch-comparison-snapshot\.svg/);
  assert.match(await response.text(), /<svg /);
});

test('share route supports HEAD and rejects invalid snapshots without caching them', async () => {
  const encoded = encodeSnapshot(snapshot);
  const head = await shareRoute({
    request: new Request(`https://tokenwatch.wyrdwerk.com/share?d=${encoded}`, { method: 'HEAD' }),
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const invalid = await shareRoute({
    request: new Request('https://tokenwatch.wyrdwerk.com/share?d=broken'),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('cache-control'), 'no-store');
  assert.equal(await invalid.text(), 'Invalid snapshot payload');
});
