import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeWriteJson } from '../scripts/lib.mjs';

test('maybeWriteJson writes when data changed and skips when only generated_at changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-write-'));
  const path = join(dir, 'out.json');
  try {
    // First write: no previous file → writes.
    const first = await maybeWriteJson(path, { generated_at: 'T1', models: [{ id: 'a' }] });
    assert.equal(first, true);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).generated_at, 'T1');

    // Same data, different generated_at → skip; the file keeps the ORIGINAL
    // timestamp so an unchanged refresh never churns generated_at (stable
    // sitemap lastmod) and CI sees a quiet git diff.
    const second = await maybeWriteJson(path, { generated_at: 'T2', models: [{ id: 'a' }] });
    assert.equal(second, false);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).generated_at, 'T1');

    // Data changed → writes with the fresh timestamp.
    const third = await maybeWriteJson(path, { generated_at: 'T3', models: [{ id: 'b' }] });
    assert.equal(third, true);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).generated_at, 'T3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maybeWriteJson creates the output directory when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-write-'));
  const path = join(dir, 'nested', 'dir', 'out.json');
  try {
    assert.equal(await maybeWriteJson(path, { generated_at: 'T', models: [] }), true);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { generated_at: 'T', models: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});