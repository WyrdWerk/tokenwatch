/**
 * shared/performance.mjs — pure helpers for performance data merging.
 *
 * Imported by scripts/fetch-performance.mjs and test/performance-merge.test.mjs.
 * No `node:` imports — Worker-safe.
 */

/**
 * Merge fresh direct-provider records into existing performance data.
 * Preserves OR records while overwriting direct-provider keys with fresh values.
 *
 * Used when running without OPENROUTER_API_KEY to update direct-provider data
 * without losing the OR-heavy existing file.
 *
 * @param {Record<string, object>} fresh - freshly fetched direct-provider records
 * @param {Record<string, object>} existing - existing performance.json data (may include _meta)
 * @returns {{ merged: Record<string, object>, updatedCount: number }}
 */
export function mergeDirectIntoExisting(fresh, existing) {
  const { _meta: _m, ...existingData } = existing;
  const merged = { ...fresh };
  const freshKeys = new Set(Object.keys(fresh));
  let updatedCount = 0;
  for (const [k, v] of Object.entries(existingData)) {
    if (!freshKeys.has(k)) {
      merged[k] = v;
    } else {
      updatedCount++;
    }
  }
  return { merged, updatedCount };
}
