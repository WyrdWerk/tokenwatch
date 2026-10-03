# Price-history D1 migrations

This directory holds the versioned SQL migrations for the `PRICE_HISTORY` D1
binding used by `GET /api/v1/models/:canonicalId/history`.

Production uses the existing `tokenwatch-price-history-prod` database:

- Account: `04679cba466d1d41d88325944b461c18`
- Database UUID: `980879e7-cc90-489b-9203-d81cf3ef265e`
- Pages project: `payg-inference-calculator`, production binding `PRICE_HISTORY`

The user created the database and dashboard binding on 2026-09-14 and approved
migrations, daily writes, and deployment on 2026-10-03. Before applying remote
migrations, the database metadata and both the configured and deployed Pages
binding were verified against this UUID. The database had no application tables
or migration ledger. Migrations 0001–0003 were then applied in order.

`wrangler.history.toml` is explicitly selected for remote operations; Pages does
not auto-discover it. **The production binding remains dashboard-managed.**
Local development uses a **gitignored copy** of `wrangler.d1.toml` named `wrangler.toml`.
`wrangler.d1.toml` must never be committed under a name Wrangler
auto-discovers (`wrangler.toml`/`wrangler.json[c]`): Wrangler treats a
discovered config as the source of truth for Pages bindings on every
`wrangler pages deploy`, so a root `wrangler.toml` with a placeholder binding
would break CI deploys. CI checkouts never contain that local file and preserve
the production dashboard binding.

## Local workflow

```bash
# One-time: create the gitignored local config from the committed template.
cp wrangler.d1.toml wrangler.toml

# Apply migrations to the local (Wrangler .wrangler/state) D1 database.
npx wrangler d1 migrations apply tokenwatch-price-history --local

# Seed the local database from public/pricing.json for one UTC day.
node scripts/snapshot-prices.mjs --local --date 2026-09-14

# Serve the Pages app + Functions against that local database.
npx wrangler pages dev public --port 8788
```

`wrangler pages dev` reads `[[d1_databases]]` from the local `wrangler.toml`,
so the Functions get `env.PRICE_HISTORY` pointed at `.wrangler/state/v3/d1`
with no Cloudflare credentials and no network access.

**Before any manual `wrangler pages deploy` (e.g. the recovery command in
AGENTS.md): remove the local file (`rm wrangler.toml`) or the deploy will
attempt to bind the placeholder `PRICE_HISTORY` database to production.**

## Applying a new migration

1. Add `migrations/000N_<name>.sql`. Never edit an applied migration.
2. `npx wrangler d1 migrations apply tokenwatch-price-history --local`
3. Re-run `npm test` and the snapshot writer's `--dry-run`.

Migration `0003_snapshot_input_billing.sql` preserves the optional default
fresh-input billing rule alongside raw prices. Apply it before using the updated
snapshot writer or history route against an existing local database. Existing
rows get `NULL` and keep their original cost semantics; no prices are rewritten.

## Production workflow

Keep the existing `CLOUDFLARE_D1_TOKEN` (Account → D1 → Edit) in GitHub Actions
secrets and, for approved operator work, the orb's secure project secrets. Do not
paste tokens into terminal commands, issues, or conversations. The writer maps
that token to Wrangler's API-token environment variable; the Pages deploy token
is not used for history writes.

```bash
# The account ID is configuration, not a credential. Wrangler 4.147.0's
# migrations-list command needs this even though it is also in the TOML.
export CLOUDFLARE_ACCOUNT_ID=04679cba466d1d41d88325944b461c18

# Inspect pending migrations, then apply only after approval.
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_D1_TOKEN" npx --yes wrangler@4.147.0 d1 migrations list PRICE_HISTORY --remote --config wrangler.history.toml
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_D1_TOKEN" npx --yes wrangler@4.147.0 d1 migrations apply PRICE_HISTORY --remote --config wrangler.history.toml

node scripts/snapshot-prices.mjs --remote --dry-run
node scripts/snapshot-prices.mjs --remote
```

The writer requires exactly one of `--local` or `--remote`. It pins Wrangler
4.147.0 and submits the whole day as one SQL file. Remote failures retry up to
three times, with 1s/2s waits and the same file/claim token. Remote file-import
rollback was verified before seeding: an insert followed by an invalid statement
left no day claim after failure. Recheck that property when upgrading Wrangler.

The initial real snapshot is 2026-10-03. History accumulates from that date;
retention of up to 90 days does not mean 90 days of data exist on day one.

`.github/workflows/refresh-pricing.yml` runs the writer after a successful refresh,
**outside the changed/force deployment gate**. A failed update must not block the
normal price commit or deploy: both snapshot and failure-report steps use
`continue-on-error`. After retries are exhausted, the reporter opens one issue
with the run link and bounded, token-redacted error output, or comments on the
existing open issue carrying `<!-- tokenwatch-price-history-failure -->`.
The entire refresh job is restricted to `refs/heads/main`: a feature-branch
dispatch cannot fetch, write production history, push data, or deploy Pages.
Operator identity checks and approved migrations use the explicit D1 commands
above, never a feature-branch pricing refresh. Production deployment follows
the normal merge-to-main path.
The refresh job alone has `issues: write`; serialized refreshes prevent duplicate
issue creation races. If GitHub reporting itself fails, the workflow log remains
the fallback and normal deployment still proceeds. Close the issue after recovery.

No preview database is configured. Preview/local environments without a binding
return 503 rather than pretending to have empty history. Generated model pages
mount the chart; text-calculator summary wiring is a separate feature.

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
