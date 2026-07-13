import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression test for Umans partial-metric serialization.
 *
 * The Umans status API may return a model with only throughput data (no latency),
 * or only latency data (no throughput). The adapter must serialize the missing
 * metric as `null`, not as a misleading object like {"p75":null,"p90":null,"p99":null}
 * that's missing its p50 key.
 *
 * Root cause: `metrics.latency?.ttft_ms?.p50` returns `undefined` (not `null`)
 * when the path doesn't exist. `!== null` is `true` for `undefined`, so the
 * ternary produces a broken object. `!= null` catches both null and undefined.
 *
 * This test simulates the exact serialization path from fetch-performance.mjs
 * lines 187-193 to verify the contract.
 */

test('Umans throughput-only record: latency serializes as null, not a broken object', () => {
  // Simulate: metrics has throughput but no latency.ttft_ms
  const metrics = {
    output_tokens_per_second: { p50: 56.4 },
    // latency.ttft_ms is absent
  };

  const ttft = metrics.latency?.ttft_ms?.p50; // undefined
  const tps = metrics.output_tokens_per_second?.p50; // 56.4

  // The fix: use != null (catches undefined AND null)
  const record = {
    latency: ttft != null ? { p50: ttft, p75: null, p90: null, p99: null } : null,
    throughput: tps != null ? { p50: tps, p75: null, p90: null, p99: null } : null,
  };

  // Throughput should have p50
  assert.equal(record.throughput.p50, 56.4);

  // Latency must be null — NOT a broken object missing p50
  assert.equal(record.latency, null, 'latency must be null when ttft is undefined');

  // Verify serialization doesn't produce a misleading object
  const serialized = JSON.stringify(record);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.latency, null, 'serialized latency must be null');
  assert.equal(parsed.throughput.p50, 56.4);
});

test('Umans latency-only record: throughput serializes as null', () => {
  const metrics = {
    latency: { ttft_ms: { p50: 1200 } },
    // output_tokens_per_second is absent
  };

  const ttft = metrics.latency?.ttft_ms?.p50; // 1200
  const tps = metrics.output_tokens_per_second?.p50; // undefined

  const record = {
    latency: ttft != null ? { p50: ttft, p75: null, p90: null, p99: null } : null,
    throughput: tps != null ? { p50: tps, p75: null, p90: null, p99: null } : null,
  };

  assert.equal(record.latency.p50, 1200);
  assert.equal(record.throughput, null, 'throughput must be null when tps is undefined');
});

test('old !== null check would have produced a broken object (documents the bug)', () => {
  // This test documents what the OLD code did wrong, to prevent regression.
  const metrics = { output_tokens_per_second: { p50: 56.4 } };
  const ttft = metrics.latency?.ttft_ms?.p50; // undefined

  // OLD check: !== null is TRUE for undefined → produces broken object
  const oldRecord = {
    latency: ttft !== null ? { p50: ttft, p75: null, p90: null, p99: null } : null,
  };

  // The old code produces a truthy object, but p50 is undefined
  assert.notEqual(oldRecord.latency, null, 'old check does NOT produce null');
  assert.equal(oldRecord.latency.p50, undefined, 'old check produces object with undefined p50');

  // JSON.stringify drops undefined values, creating a misleading object
  const serialized = JSON.stringify(oldRecord.latency);
  assert.ok(!serialized.includes('p50'), 'serialized broken object is missing p50');
  assert.ok(serialized.includes('p75'), 'serialized broken object has p75 but not p50');
});

test('fetch-performance.mjs source uses != null (not !== null) for Umans partial metrics', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(__dirname, '..', 'scripts', 'fetch-performance.mjs'), 'utf-8');

  // Scope to the Umans section only — Lilac uses !== null safely (explicit nulls)
  const umansStart = src.indexOf('// ── Umans AI');
  const umansEnd = src.indexOf('const ms =', umansStart);
  assert.ok(umansStart >= 0 && umansEnd > umansStart, 'must find complete Umans section (both markers)');
  const umansBlock = src.slice(umansStart, umansEnd);

  // Must use != null (catches undefined) — NOT !== null (misses undefined)
  assert.match(umansBlock, /ttft != null/, 'Umans latency must use != null (catches undefined)');
  assert.match(umansBlock, /tps != null/, 'Umans throughput must use != null (catches undefined)');
  assert.doesNotMatch(umansBlock, /ttft !== null/, 'Umans must not use !== null (misses undefined)');
  assert.doesNotMatch(umansBlock, /tps !== null/, 'Umans must not use !== null (misses undefined)');
});
