import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDirectIntoExisting } from '../shared/performance.mjs';

/**
 * Regression test for the no-OR-key merge branch in fetch-performance.mjs.
 *
 * When OPENROUTER_API_KEY is not set, the script fetches only direct-provider
 * records (Umans/Lilac/Crof ~30 records). Without the merge logic, the 15%
 * coverage-drop guard would see 30 vs 780 existing records and bail, leaving
 * stale direct-provider data forever. The merge folds fresh direct-provider
 * records into the existing file's data so OR records are preserved while
 * direct-provider keys get updated with current values.
 */

test('mergeDirectIntoExisting: preserves OR records, overwrites direct-provider keys with fresh data', () => {
  // Simulate existing performance.json (OR-heavy, with stale direct-provider data)
  const existing = {
    'gpt-5.6-luna-pro|openai': { latency: { p50: 6281 }, throughput: { p50: 154 } },
    'gpt-5.6-luna|azure': { latency: { p50: 1521 }, throughput: { p50: 59 } },
    'umans-glm-5.2|umans': { latency: { p50: 9999 }, throughput: { p50: 1.0 } }, // stale
    'umans-flash|umans': { latency: { p50: 9999 }, throughput: { p50: 1.0 } },   // stale
    'crof-model|crof': { latency: { p50: 500 }, throughput: { p50: 50 } },
    _meta: { generated_at: '2026-07-13T00:00:00Z' },
  };

  // Simulate fresh perfData from direct-only fetch (no OR key)
  const fresh = {
    'umans-glm-5.2|umans': { latency: { p50: 2070 }, throughput: { p50: 78.5 } },  // fresh
    'umans-flash|umans': { latency: { p50: 1500 }, throughput: { p50: 297.8 } },   // fresh
    'crof-model|crof': { latency: { p50: 480 }, throughput: { p50: 55 } },         // fresh
  };

  const { merged, updatedCount } = mergeDirectIntoExisting(fresh, existing);

  // OR records must be preserved
  assert.equal(merged['gpt-5.6-luna-pro|openai'].latency.p50, 6281, 'OR record preserved');
  assert.equal(merged['gpt-5.6-luna|azure'].latency.p50, 1521, 'OR record preserved');

  // Direct-provider records must have fresh values (not stale)
  assert.equal(merged['umans-glm-5.2|umans'].latency.p50, 2070, 'Umans latency updated to fresh value');
  assert.equal(merged['umans-glm-5.2|umans'].throughput.p50, 78.5, 'Umans throughput updated to fresh value');
  assert.equal(merged['umans-flash|umans'].latency.p50, 1500, 'Umans flash latency updated');
  assert.equal(merged['umans-flash|umans'].throughput.p50, 297.8, 'Umans flash throughput updated');
  assert.equal(merged['crof-model|crof'].latency.p50, 480, 'Crof record updated');

  // Stale values must NOT survive
  assert.notEqual(merged['umans-glm-5.2|umans'].latency.p50, 9999, 'stale Umans value must not survive');
  assert.notEqual(merged['umans-flash|umans'].throughput.p50, 1.0, 'stale Umans value must not survive');

  // Count: 2 OR + 3 direct (overwritten) = 5 total
  assert.equal(updatedCount, 3, '3 direct-provider keys were updated');
  assert.equal(Object.keys(merged).length, 5, '5 total records (2 OR preserved + 3 direct)');
});

test('mergeDirectIntoExisting: _meta excluded from merged data', () => {
  const existing = {
    'or-model|openai': { latency: { p50: 100 }, throughput: { p50: 50 } },
    _meta: { generated_at: '2026-07-13T00:00:00Z' },
  };
  const fresh = {
    'umans-glm-5.2|umans': { latency: { p50: 2070 }, throughput: { p50: 78.5 } },
  };

  const { merged } = mergeDirectIntoExisting(fresh, existing);

  // _meta must NOT appear in merged data
  assert.equal(merged._meta, undefined, '_meta must not leak into merged data');
  assert.ok(merged['or-model|openai'], 'OR record preserved');
  assert.ok(merged['umans-glm-5.2|umans'], 'direct record present');
});

test('mergeDirectIntoExisting: fresh keys not in existing are preserved', () => {
  const existing = {
    'or-model|openai': { latency: { p50: 100 }, throughput: { p50: 50 } },
  };
  const fresh = {
    'new-direct-model|umans': { latency: { p50: 200 }, throughput: { p50: 80 } },
  };

  const { merged, updatedCount } = mergeDirectIntoExisting(fresh, existing);

  assert.equal(updatedCount, 0, 'no keys were updated (new model, not in existing)');
  assert.ok(merged['new-direct-model|umans'], 'fresh key preserved');
  assert.ok(merged['or-model|openai'], 'OR record preserved');
  assert.equal(Object.keys(merged).length, 2, '2 total records');
});

test('mergeDirectIntoExisting: empty existing returns fresh unchanged', () => {
  const existing = {};
  const fresh = {
    'umans-flash|umans': { latency: { p50: 1500 }, throughput: { p50: 297.8 } },
  };

  const { merged, updatedCount } = mergeDirectIntoExisting(fresh, existing);

  assert.equal(updatedCount, 0);
  assert.equal(Object.keys(merged).length, 1);
  assert.equal(merged['umans-flash|umans'].throughput.p50, 297.8);
});

test('mergeDirectIntoExisting: empty fresh preserves all existing (minus _meta)', () => {
  const existing = {
    'or-model|openai': { latency: { p50: 100 }, throughput: { p50: 50 } },
    _meta: { generated_at: '2026-07-13T00:00:00Z' },
  };
  const fresh = {};

  const { merged, updatedCount } = mergeDirectIntoExisting(fresh, existing);

  assert.equal(updatedCount, 0);
  assert.ok(merged['or-model|openai'], 'existing record preserved');
  assert.equal(merged._meta, undefined, '_meta excluded');
});
