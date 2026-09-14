-- 0002_snapshot_day_claim.sql — day-level claim invariant for daily snapshots.
--
-- 0001 made (offering_key, utc_day) unique, which stops duplicate ROWS but not
-- duplicate WRITES: `ON CONFLICT ... DO UPDATE` still let every later refresh of
-- the same UTC day rewrite that day's prices. That contradicts the documented
-- rule "the first successful refresh after 00:00 UTC wins the day".
--
-- This migration adds the day-level claim that makes the rule real:
--
--   price_snapshot_day  — one row per claimed UTC day. `claimed_at` is the
--                         first successful write's timestamp, `offering_count`
--                         is how many offerings that write contained, and
--                         `source_generated_at` is the catalog timestamp it
--                         came from.
--
-- The writer claims the day and inserts its rows in ONE transaction. If the day
-- is already claimed, the writer writes nothing at all — it never adds newly
-- appearing offerings to a day another catalog already owns, and never rewrites
-- prices. An exact retry of the claiming run is therefore safe, while a
-- different catalog for the same day is correctly ignored.
--
-- A separate table (rather than a column on price_snapshot) is what makes
-- "claimed but zero offerings" representable, which is the correct record for a
-- day whose catalog contained nothing snapshot-worthy.

CREATE TABLE IF NOT EXISTS price_snapshot_day (
  utc_day             TEXT PRIMARY KEY,
  claimed_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  offering_count      INTEGER NOT NULL DEFAULT 0,
  source_generated_at TEXT,
  -- Unique per writer invocation. The claiming run stamps its token here and
  -- every following statement in the same batch tests for it, which is how the
  -- batch knows it owns the day. A re-run's token never matches, so all of its
  -- writes are skipped. SQLite cannot evaluate a cross-statement `changes()`
  -- reliably here: a guarded DELETE that matches zero rows still reports 0 and
  -- would block every later insert.
  claim_token         TEXT,
  CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (offering_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_price_snapshot_day_claimed_at
  ON price_snapshot_day (claimed_at);