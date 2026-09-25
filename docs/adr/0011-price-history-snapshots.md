# ADR 0011 — Price-history snapshots in D1, blended at read time

**Status:** Accepted (local-only implementation; production rollout not approved)

## Context

TokenWatch ships only the current price of each offering. Tracking how prices
move needs durable daily history. Committing history to Git was rejected: a
pruned tracked JSON file does not bound Git's cumulative growth, because old
blobs stay in history forever.

## Decision

Store one row per offering per UTC day in Cloudflare D1 (`PRICE_HISTORY`),
written from the successful refresh's `public/pricing.json` by
`scripts/snapshot-prices.mjs`.

- **Raw components only.** Rows carry input/output/cache-read/cache-write and
  the discount fraction in USD per million. The visitor's cache/input/output
  mix is applied at read time by `GET /api/v1/models/:canonicalId/history`.
  Storing a blended price would freeze one workload into the data.
- **Identity.** `offering_key` = `canonicalId(model id) | provider |
  quantization | sku`, so quantized, batch, and other SKU variants stay distinct
  rows instead of collapsing.
- **Idempotence.** A unique index on `(offering_key, utc_day)` prevents duplicate
  rows, and a day-level claim in `price_snapshot_day` prevents duplicate
  *writes*. The writer claims the UTC day and inserts its rows in one
  transaction; if the day is already claimed it writes nothing. So a retry is
  safe, and a later refresh the same day can neither rewrite that day's prices
  nor append offerings a different catalog did not have. A row-level
  `ON CONFLICT DO UPDATE` alone was not enough: it still let every later
  refresh of the same day overwrite prices, and a row-level `DO NOTHING` would
  still have let a later catalog add newly appearing offerings to the day.
- **Missing means absent.** A day or offering with no row is not offered that
  day. Nothing carries forward and nothing writes 0.
- **Retention.** 90 days, pruned in the same batch as the insert, and on every
  invocation including a no-op retry.
- **Atomic.** Claim, rows, and retention are one transactional D1 batch, so a
  failed run commits nothing. `--force` is an explicit operator repair that
  replaces a day's rows and refreshes its claim in the same transaction; it is
  not a normal crash-recovery path.

## Consequences

- **Enables:** arbitrary-mix history with no re-ingestion; per-day cheapest
  provider; sparse-day gaps that stay visibly distinct from $0 pricing.
- **Costs:** history begins at the first snapshot and cannot be backfilled;
  production needs a real D1 database, bindings, a remote migration, and a CI
  writer step, each requiring separate approval.
- **Binding is runtime config, not a secret**, but it must exist for the
  endpoint to answer; without it the API returns 503 rather than an empty chart.