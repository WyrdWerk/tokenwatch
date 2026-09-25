-- 0001_price_history.sql — daily raw price snapshots for the price-history API.
--
-- Design constraints (see docs/adr/0011-price-history-snapshots.md):
--   * Store RAW USD-per-million rate components, never a precomputed effective
--     price. The visitor's cache/input/output mix is applied at read time.
--   * One row per (utc_day, offering_key). The unique index is the idempotency
--     contract: a retried or replayed daily write can only ever upsert.
--   * An offering missing on a day has NO row. There is no carry-forward row
--     and no removal event, so a missing day can never render as $0.
--   * offering_key is the catalog's dedup identity (canonical id + provider +
--     quantization + SKU), so quantization/batch/peak-off-peak variants stay
--     distinct rows instead of collapsing into one.

CREATE TABLE IF NOT EXISTS price_snapshot (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- UTC calendar day of the snapshot, 'YYYY-MM-DD'.
  utc_day           TEXT    NOT NULL,

  -- Catalog dedup identity. `canonical_model` is canonicalId(models[].id);
  -- `provider` is the provider key; `quantization` is the catalog value
  -- ('' when null — SQLite unique indexes treat NULLs as distinct, which would
  -- silently allow duplicate rows for the same offering).
  offering_key      TEXT    NOT NULL,
  canonical_model   TEXT    NOT NULL,
  provider          TEXT    NOT NULL,
  quantization      TEXT    NOT NULL DEFAULT '',
  sku               TEXT    NOT NULL DEFAULT '',

  -- Display fields, copied from the source catalog row.
  model_id          TEXT    NOT NULL,
  model_name        TEXT,
  org               TEXT,

  -- Raw USD per million tokens. NULL means "this offering does not publish
  -- this rate" — never 0. `discount` is the promotional fraction from the
  -- catalog (0 = structural price, > 0 = active promotion).
  input_price       REAL,
  output_price      REAL,
  cache_read        REAL,
  cache_write       REAL,
  discount          REAL    NOT NULL DEFAULT 0,

  -- Provenance: generated_at of the pricing.json the row was sourced from.
  source_generated_at TEXT,

  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (discount >= 0),
  CHECK (input_price  IS NULL OR input_price  >= 0),
  CHECK (output_price IS NULL OR output_price >= 0),
  CHECK (cache_read   IS NULL OR cache_read   >= 0),
  CHECK (cache_write  IS NULL OR cache_write  >= 0)
);

-- Idempotency + the read path's covering index: (offering_key, utc_day) also
-- serves `WHERE offering_key = ? AND utc_day BETWEEN ? AND ? ORDER BY utc_day`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_snapshot_offering_day
  ON price_snapshot (offering_key, utc_day);

-- Model-scoped history reads: WHERE canonical_model = ? AND utc_day >= ?.
CREATE INDEX IF NOT EXISTS idx_price_snapshot_model_day
  ON price_snapshot (canonical_model, utc_day);

-- Retention sweep: DELETE FROM price_snapshot WHERE utc_day < ?.
CREATE INDEX IF NOT EXISTS idx_price_snapshot_day
  ON price_snapshot (utc_day);