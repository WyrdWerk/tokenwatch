# Price-history D1 migrations (local only)

This directory holds the versioned SQL migrations for the `PRICE_HISTORY` D1
binding used by `GET /api/v1/models/:canonicalId/history`.

**No remote database is configured in this repository.** `wrangler.toml`
declares a local Pages project plus a placeholder `PRICE_HISTORY` binding; the
placeholder `database_id` is only substituted for `--remote` access, which this
workflow never uses.

## Local workflow

```bash
# Apply migrations to the local (Wrangler .wrangler/state) D1 database.
npx wrangler d1 migrations apply tokenwatch-price-history --local

# Seed the local database from public/pricing.json for one UTC day.
node scripts/snapshot-prices.mjs --local --date 2026-09-14

# Serve the Pages app + Functions against that local database.
npx wrangler pages dev public --port 8788
```

`wrangler pages dev` reads `[[d1_databases]]` from `wrangler.toml`, so the
Functions get `env.PRICE_HISTORY` pointed at `.wrangler/state/v3/d1` with no
Cloudflare credentials and no network access.

## Applying a new migration

1. Add `migrations/000N_<name>.sql`. Never edit an applied migration.
2. `npx wrangler d1 migrations apply tokenwatch-price-history --local`
3. Re-run `npm test` and the snapshot writer's `--dry-run`.

## Not yet wired into CI (deliberate)

`scripts/snapshot-prices.mjs` supports `--local` only. A daily production
snapshot needs all of the following, none of which exist yet:

1. A real D1 database created in the Cloudflare account.
2. A production `PRICE_HISTORY` binding (and ideally a separate preview
   database) with its real `database_id` in `wrangler.toml`.
3. A remote migration applied with explicit approval.
4. A CI step in `.github/workflows/refresh-pricing.yml` that runs the writer
   after a successful refresh, with credentials that can write to that database.

Until then the local workflow above is the whole supported surface, and
`GET /api/v1/models/:canonicalId/history` returns HTTP 503 when no binding is
present rather than reporting a misleading empty history.

The refresh workflow already runs under `concurrency: repo-refresh` with
`cancel-in-progress: false`, so refresh jobs are serialized. That serialization
is a scheduling convenience, not the correctness mechanism: the day-claim
invariant in `price_snapshot_day` is what actually enforces "first successful
refresh after 00:00 UTC wins the day". A later refresh the same day writes
nothing — it cannot rewrite prices and cannot append newly appearing offerings
to a day another catalog already owns.

## Recovery and repair

A day is claimed and written in a single transactional batch, so a failed or
interrupted run commits nothing — it cannot leave a day claimed with no rows.
`--force` therefore is not a normal crash-recovery step. It is an explicit
operator repair, for cases such as:

- manual corruption of a day's rows outside the writer;
- a day that was intentionally claimed without rows (the schema deliberately
  allows `offering_count = 0`, so an empty winning catalog is representable);
- replacing a day's snapshot on purpose after a bad catalog was captured.

```bash
node scripts/snapshot-prices.mjs --local --date <day> --force
```

`--force` replaces the day's rows **and** refreshes its claim row
(`claimed_at`, `offering_count`, `source_generated_at`, `claim_token`) in the
same transaction, so the claim always describes the snapshot that is actually
stored. It affects that day only; no other day's claim is touched.