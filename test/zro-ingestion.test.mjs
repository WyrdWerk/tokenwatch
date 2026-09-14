import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getZroCatalogRows,
  fetchZroSnapshot,
  readZroSnapshot,
  writeZroSnapshot,
  ZRO_SNAPSHOT_PATH,
} from '../scripts/fetch-zro.mjs';
import { parseZroPricingHtml, ZRO_MIN_ROWS } from '../scripts/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'zro-pricing.html');
const fixture = await readFile(fixturePath, 'utf8');

/** A fetch stub that returns the fixture HTML once. */
function htmlFetch(html = fixture) {
  return async () => new Response(html, { status: 200 });
}

/** Drop named Flight chunks (used to simulate a partial render). */
function dropPriceChunks(html, ids) {
  let out = html;
  for (const id of ids) {
    out = out.replace(new RegExp(`<script>self\\.__next_f\\.push\\(\\[1,"${id}:.*?\\]\\)</script>`, 's'), '');
  }
  return out;
}

async function tempSnapshotPath() {
  const dir = await mkdtemp(join(tmpdir(), 'tw-zro-'));
  return { dir, path: join(dir, 'zro-pricing.json') };
}

// ── fresh path ────────────────────────────────────────────────────────────────

test('getZroCatalogRows returns fresh catalog rows and writes the snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const { rows, source } = await getZroCatalogRows({ fetchImpl: htmlFetch(), snapshotPath: path, log: () => {} });
    assert.equal(source, 'fresh');
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.provider, 'zro');
      assert.equal(row.quantization, null);
      assert.ok(row.pricing.input > 0 && row.pricing.output > 0);
      assert.equal(row.pricing.cache_write, null);
    }
    const snapshot = await readZroSnapshot(path);
    assert.ok(snapshot, 'snapshot written');
    assert.equal(snapshot.source_url, 'https://zro.moonmath.ai/pricing');
    assert.ok(Number.isFinite(Date.parse(snapshot.fetched_at)));
    assert.equal(snapshot.models.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getZroCatalogRows normalizes promotions into discount on catalog rows', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const { rows } = await getZroCatalogRows({ fetchImpl: htmlFetch(), snapshotPath: path, log: () => {} });
    const promo = rows.find((r) => r.id === 'deepseek-v4.1-flash');
    assert.equal(promo.discount, 0.5);
    assert.equal(promo.pricing.input, 0.15);
    const plain = rows.find((r) => r.id === 'glm-5.3');
    assert.equal(plain.discount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── TTL reuse ─────────────────────────────────────────────────────────────────

test('getZroCatalogRows reuses a snapshot younger than 24h without fetching', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const rows = parseZroPricingHtml(fixture);
    await writeZroSnapshot({ source_url: 'x', fetched_at: new Date().toISOString(), models: rows }, path);
    let called = 0;
    const { rows: out, source } = await getZroCatalogRows({
      fetchImpl: async () => { called++; return new Response(fixture, { status: 200 }); },
      snapshotPath: path,
      log: () => {},
    });
    assert.equal(called, 0, 'fresh snapshot must skip the network');
    assert.equal(source, 'snapshot');
    assert.equal(out.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getZroCatalogRows refetches when the snapshot is stale (>24h)', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const rows = parseZroPricingHtml(fixture);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeZroSnapshot({ source_url: 'x', fetched_at: stale, models: rows }, path);
    let called = 0;
    const { source } = await getZroCatalogRows({
      fetchImpl: async () => { called++; return new Response(fixture, { status: 200 }); },
      snapshotPath: path,
      log: () => {},
    });
    assert.equal(called, 1, 'stale snapshot must trigger a refetch');
    assert.equal(source, 'fresh');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── fallback path ─────────────────────────────────────────────────────────────

test('getZroCatalogRows falls back to last-good rows on fetch failure', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const rows = parseZroPricingHtml(fixture);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeZroSnapshot({ source_url: 'x', fetched_at: stale, models: rows }, path);
    const { rows: out, source, reason } = await getZroCatalogRows({
      fetchImpl: async () => { throw new Error('network down'); },
      snapshotPath: path,
      log: () => {},
    });
    assert.equal(source, 'snapshot');
    assert.match(reason, /network down/);
    assert.equal(out.length, 5, 'fallback rows must still be ordinary catalog records');
    assert.equal(out[0].provider, 'zro');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getZroCatalogRows falls back to last-good rows when the fresh parse is partial', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const rows = parseZroPricingHtml(fixture);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeZroSnapshot({ source_url: 'x', fetched_at: stale, models: rows }, path);
    // A page whose per-row price chunks failed to render must not replace the
    // snapshot — the loader returns the last-good rows instead.
    const partial = dropPriceChunks(fixture, ['16', '17', '18', '19']);
    assert.equal(parseZroPricingHtml(partial).length, 1, 'fixture must actually be partial');
    const { rows: out, source } = await getZroCatalogRows({
      fetchImpl: htmlFetch(partial),
      snapshotPath: path,
      log: () => {},
    });
    assert.equal(source, 'snapshot', 'partial parse must fall back, never publish a slice');
    assert.equal(out.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getZroCatalogRows returns no rows (not free models) when fetch fails with no snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const { rows, source } = await getZroCatalogRows({
      fetchImpl: async () => { throw new Error('offline'); },
      snapshotPath: path,
      log: () => {},
    });
    assert.equal(source, 'none');
    assert.deepEqual(rows, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchZroSnapshot rejects a page that lost the API panel', async () => {
  const stripped = fixture.replace(/"id":"api"/g, '"id":"not-api"').replace(/apiModelIds/g, 'otherIds');
  const result = await fetchZroSnapshot({ fetchImpl: htmlFetch(stripped) });
  assert.equal(result.ok, false);
});

test('fetchZroSnapshot enforces the minimum row floor', async () => {
  assert.ok(ZRO_MIN_ROWS >= 5);
  const partial = dropPriceChunks(fixture, ['16', '17', '18', '19']);
  const result = await fetchZroSnapshot({ fetchImpl: htmlFetch(partial) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /minimum|floor/i);
});

test('readZroSnapshot rejects a corrupt or partial committed snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    // Write raw JSON directly — writeZroSnapshot() now refuses to persist an
    // invalid snapshot, so this simulates on-disk corruption/truncation.
    const raw = async (models) => writeFile(path, JSON.stringify({
      source_url: 'x',
      fetched_at: new Date().toISOString(),
      models,
    }));

    // A truncated snapshot (below the row floor) must not be reused or
    // fallback-published — the "never partial" invariant applies to the
    // on-disk last-good copy too, not just fresh fetches.
    await raw(parseZroPricingHtml(fixture).slice(0, 1));
    assert.equal(await readZroSnapshot(path), null, 'sub-floor snapshot must be rejected');

    // Duplicate ids and non-positive prices are equally invalid.
    const rows = parseZroPricingHtml(fixture);
    await raw([...rows, { ...rows[0] }]);
    assert.equal(await readZroSnapshot(path), null, 'duplicate-id snapshot must be rejected');

    await raw(rows.map((r, i) => (i ? r : { ...r, output: 0 })));
    assert.equal(await readZroSnapshot(path), null, 'non-positive-price snapshot must be rejected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeZroSnapshot refuses to persist an invalid snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const rows = parseZroPricingHtml(fixture);
    await assert.rejects(
      () => writeZroSnapshot({ source_url: 'x', fetched_at: new Date().toISOString(), models: rows.slice(0, 1) }, path),
      /floor|minimum/i,
    );
    await assert.rejects(
      () => writeZroSnapshot({ source_url: 'x', fetched_at: new Date().toISOString(), models: [] }, path),
      /floor|minimum/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getZroCatalogRows never publishes a corrupt snapshot as partial catalog rows', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const rows = parseZroPricingHtml(fixture);
    // Simulate on-disk truncation (writeZroSnapshot refuses invalid input).
    await writeFile(path, JSON.stringify({
      source_url: 'x',
      fetched_at: new Date().toISOString(),
      models: rows.slice(0, 1),
    }));
    const { rows: out, source } = await getZroCatalogRows({
      fetchImpl: async () => { throw new Error('offline'); },
      snapshotPath: path,
      log: () => {},
    });
    assert.equal(source, 'none', 'a corrupt snapshot must not be published');
    assert.deepEqual(out, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getZroCatalogRows ignores a corrupt snapshot and still uses a valid fresh fetch', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    await writeFile(path, JSON.stringify({ source_url: 'x', fetched_at: new Date().toISOString(), models: [] }));
    const { rows, source } = await getZroCatalogRows({
      fetchImpl: htmlFetch(),
      snapshotPath: path,
      log: () => {},
    });
    assert.equal(source, 'fresh');
    assert.equal(rows.length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── committed snapshot ────────────────────────────────────────────────────────

test('the committed data/zro-pricing.json snapshot is present and well-formed', async () => {
  const snapshot = JSON.parse(await readFile(join(__dirname, '..', ZRO_SNAPSHOT_PATH), 'utf8'));
  assert.equal(snapshot.source_url, 'https://zro.moonmath.ai/pricing');
  assert.ok(Number.isFinite(Date.parse(snapshot.fetched_at)));
  assert.ok(Array.isArray(snapshot.models) && snapshot.models.length >= ZRO_MIN_ROWS);
  for (const model of snapshot.models) {
    assert.ok(model.id, 'snapshot row must have an id');
    assert.ok(model.input > 0 && model.output > 0, 'snapshot rows must be positively priced');
  }
});