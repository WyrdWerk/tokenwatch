#!/usr/bin/env node
/**
 * scripts/snapshot-prices.mjs — deterministic, idempotent daily price snapshot
 * writer.
 *
 * Reads `public/pricing.json` and writes ONE row per priced offering for one UTC
 * day into the `price_snapshot` table (D1 binding `PRICE_HISTORY`).
 *
 * Contract (see docs/adr/0011-price-history-snapshots.md):
 *   - Raw USD-per-million components only. The visitor mix is applied at read
 *     time by the API, never baked into a stored row.
 *   - **First successful refresh after 00:00 UTC wins the day.** The day is
 *     claimed in `price_snapshot_day` in the same transaction that inserts its
 *     rows. If the day is already claimed, the writer does nothing at all: it
 *     neither rewrites that day's prices nor appends newly appearing offerings
 *     to a day another catalog already owns. A retry of the claiming run, or a
 *     later refresh the same day, is therefore a safe no-op.
 *   - Atomic per day: the claim, the row inserts, and the retention delete are
 *     one `wrangler d1 execute --file` batch, which D1 applies transactionally
 *     (verified by fault injection: a batch whose second statement is invalid
 *     exits non-zero and leaves no claim row). A batch that fails therefore
 *     commits nothing, so there is no "claimed but empty" outcome from a normal
 *     crash and no partial day to repair.
 *   - Missing offerings stay missing: rows are only written for offerings
 *     present in the winning catalog. Nothing carries forward and nothing
 *     writes 0.
 *   - Retention: rows older than the retention window are deleted in the same
 *     batch. Retention runs on every invocation, including a no-op retry.
 *
 * Usage:
 *   node scripts/snapshot-prices.mjs --local [--date 2026-09-14] [--dry-run]
 *   node scripts/snapshot-prices.mjs --remote   # requires CLOUDFLARE_D1_TOKEN
 *   node scripts/snapshot-prices.mjs --local --force   # operator repair: replace
 *                                                      # an already claimed day
 *
 * Remote operations explicitly select wrangler.history.toml, leaving Pages'
 * dashboard binding intact. Failed remote operations retry up to three times
 * with the same SQL file; a completed day's claim keeps retries idempotent.
 */

import { readFile } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RETENTION_DAYS,
  retentionCutoff,
  toSnapshotRow,
  utcDay,
} from '../shared/price-history.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DB_NAME = 'tokenwatch-price-history';

const COLUMNS = [
  'utc_day', 'offering_key', 'canonical_model', 'provider', 'quantization', 'sku',
  'model_id', 'model_name', 'org', 'input_price', 'output_price', 'cache_read',
  'cache_write', 'input_billing', 'discount', 'source_generated_at',
];

/** Monotonic counter making claim tokens unique even within one millisecond. */
let claimSequence = 0;

/**
 * Build the SQL batch for one day.
 *
 * The batch is gated on the day claim:
 *
 *   1. `INSERT OR IGNORE INTO price_snapshot_day ...` — claim the day, stamping
 *      this run's unique `claim_token`. `OR IGNORE` means an already-claimed day
 *      keeps its original claim, so this run's token never lands.
 *   2. `DELETE FROM price_snapshot WHERE utc_day = <day> AND <owned>` — clear
 *      rows from a previous *unclaimed* attempt. Guarded, so a re-run leaves the
 *      claimed day's rows untouched.
 *   3. One `INSERT OR REPLACE` per offering, each guarded by `<owned>`.
 *   4. An unguarded retention delete, which must fire on every run.
 *
 * `<owned>` is true only when the day row carries THIS run's token, so a re-run
 * writes nothing at all. A cross-statement `changes()` cannot express this: a
 * guarded DELETE that matches zero rows still reports `changes() = 0` and would
 * block every later insert. The whole batch is one transaction. `--force`
 * replaces `<owned>` with `1 = 1` for explicit recovery.
 *
 * Exported so tests can assert first-success immutability, retry safety, and
 * retention at the statement level without a database.
 */
export function buildSnapshotStatements(models, day, generatedAt, retentionDays = RETENTION_DAYS, { force = false } = {}) {
  const rows = [];
  for (const model of models || []) {
    const row = toSnapshotRow(model, day, generatedAt);
    if (row) rows.push(row);
  }
  // Deterministic statement order keeps the batch reproducible and makes a
  // partial-failure test meaningful (the Nth statement is always the same row).
  rows.sort((a, b) => a.offering_key.localeCompare(b.offering_key));

  const statements = [];

  // The batch is gated on whether THIS run owns the day. A bare `changes()`
  // cannot be used across statements — a guarded DELETE matching zero rows still
  // reports changes()=0 and would block every later insert. Instead the claim
  // stamps the day row with this run's unique token, and each following
  // statement tests for that token: it is present only in the run that created
  // the claim. `--force` bypasses the test for recovery.
  const claimToken = `${day}#${process.pid}.${Date.now()}.${++claimSequence}`;
  const owned = `(SELECT COUNT(*) FROM price_snapshot_day WHERE utc_day = '${day}' AND claim_token = '${claimToken}') > 0`;

  statements.push({
    // Under `--force` the claim is REPLACED, so the day's metadata describes the
    // snapshot that is actually stored after this run. Without that, a forced
    // replacement would leave `offering_count`/`source_generated_at` describing
    // the superseded catalog. A normal run still uses OR IGNORE so the first
    // successful catalog keeps the day.
    sql: force
      ? `INSERT OR REPLACE INTO price_snapshot_day (utc_day, claimed_at, offering_count, source_generated_at, claim_token) `
        + `VALUES ('${day}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${rows.length}, ${sqlLiteral(generatedAt)}, '${claimToken}')`
      : `INSERT OR IGNORE INTO price_snapshot_day (utc_day, offering_count, source_generated_at, claim_token) `
        + `VALUES ('${day}', ${rows.length}, ${sqlLiteral(generatedAt)}, '${claimToken}')`,
    phase: 'claim',
  });

  const guard = force ? '1 = 1' : owned;

  // 2. Clear rows from a prior *unclaimed* attempt for this day. Guarded on
  //    ownership, so a re-run leaves the already-claimed day's rows untouched.
  statements.push({
    sql: `DELETE FROM price_snapshot WHERE utc_day = '${day}' AND ${guard}`,
    phase: 'reset',
  });

  // 3. One insert per offering, guarded on the claim. `INSERT OR REPLACE` with a
  //    `SELECT` source is used so the guard can be appended as a WHERE clause;
  //    the row is only inserted when this run actually owns the day.
  for (const row of rows) {
    const values = COLUMNS.map((column) => sqlLiteral(row[column]));
    statements.push({
      sql: `INSERT OR REPLACE INTO price_snapshot (${COLUMNS.join(', ')}) `
        + `SELECT ${values.join(', ')} WHERE ${guard}`,
      offering_key: row.offering_key,
      phase: 'insert',
    });
  }

  // 4. Retention is NOT guarded by the claim: it must run on every invocation,
  //    including a no-op retry. Pruning old days is independent of whether this
  //    run owns today's snapshot.
  const cutoff = retentionCutoff(day, retentionDays);
  statements.push({
    sql: `DELETE FROM price_snapshot WHERE utc_day < '${cutoff}'`,
    retention: true,
    phase: 'retention',
  });

  return { day, rowCount: rows.length, cutoff, statements };
}

/** Render a JS value as a SQL literal for the generated batch. */
function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite numeric value: ${value}`);
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Run a D1 read or import; pin the Wrangler version whose rollback is verified. */
export async function runD1(extraArgs, {
  remote = false, cwd = ROOT, env = process.env, execute = spawnSync, wait = delay,
} = {}) {
  if (remote && !env.CLOUDFLARE_D1_TOKEN) throw new Error('CLOUDFLARE_D1_TOKEN is required for --remote');
  const args = ['--yes', 'wrangler@4.147.0', 'd1', 'execute', remote ? 'PRICE_HISTORY' : DB_NAME,
    remote ? '--remote' : '--local', '--yes', '--json',
    ...(remote ? ['--config', 'wrangler.history.toml'] : []), ...extraArgs];
  const attempts = remote ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = execute('npx', args, {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      // The Pages deploy token is not the history writer credential.
      env: remote ? { ...env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_D1_TOKEN } : env,
    });
    if (!result.error && result.status === 0) return result.stdout;
    if (attempt === attempts) {
      throw new Error(`wrangler d1 execute failed after ${attempt} attempt(s): ${result.error?.message || result.stderr || result.stdout}`);
    }
    await wait(1000 * 2 ** (attempt - 1));
  }
}

/** Import the complete day's SQL file, never separate claim/row transactions. */
export async function runSnapshotBatch(statements, { cwd = ROOT, log = () => {}, ...options } = {}) {
  const sql = statements
    .map((statement) => `${statement.sql.replace(/;\s*$/, '')};`)
    .join('\n');
  // wrangler has no stdin mode for `d1 execute`, so the batch is staged as a
  // temp file inside the (gitignored) .wrangler directory and removed after.
  const tmpDir = join(cwd, '.wrangler', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, `snapshot-${process.pid}-${Date.now()}.sql`);
  writeFileSync(file, sql, 'utf8');
  try {
    const output = await runD1(['--file', file], { cwd, ...options });
    log(output.trim());
    return output;
  } finally {
    rmSync(file, { force: true });
  }
}

/** True when the day already has a claim row. */
export async function readDayClaim(day, options = {}) {
  const output = await runD1(['--command',
    `SELECT utc_day, offering_count, source_generated_at, claimed_at FROM price_snapshot_day WHERE utc_day = ${sqlLiteral(day)}`], options);
  const parsed = JSON.parse(output);
  return parsed?.[0]?.results?.[0] || null;
}

export function parseArgs(argv) {
  const args = { local: false, remote: false, dryRun: false, force: false, date: null, pricing: join(ROOT, 'public', 'pricing.json') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--local') args.local = true;
    else if (arg === '--remote') args.remote = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--date') args.date = argv[++i];
    else if (arg === '--pricing') args.pricing = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.local === args.remote) throw new Error('choose exactly one of --local or --remote');
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const day = args.date || utcDay(new Date());
  const pricing = JSON.parse(await readFile(args.pricing, 'utf8'));
  const batch = buildSnapshotStatements(pricing.models, day, pricing.generated_at, RETENTION_DAYS, { force: args.force });

  if (args.dryRun) {
    console.log(`snapshot-prices: dry run — ${batch.rowCount} rows for ${day}, retention cutoff ${batch.cutoff}`);
    return batch;
  }

  const options = { remote: args.remote, log: (out) => process.stdout.write(out + '\n') };
  const claim = await readDayClaim(day, options);
  if (claim && !args.force) {
    // The day is already owned by an earlier successful catalog. The batch is
    // still executed so retention runs, but every row write is gated on this
    // run's claim token, which `INSERT OR IGNORE` did not install — so no price
    // is rewritten and no newly appearing offering is appended.
    await runSnapshotBatch(batch.statements, options);
    console.log(`snapshot-prices: ${day} already claimed by ${claim.source_generated_at ?? 'an earlier run'} at ${claim.claimed_at}; prices left unchanged (${claim.offering_count} offerings)`);
    return batch;
  }

  await runSnapshotBatch(batch.statements, options);
  console.log(args.force && claim
    ? `snapshot-prices: force-replaced ${day} with ${batch.rowCount} rows (retention cutoff ${batch.cutoff})`
    : `snapshot-prices: claimed ${day} with ${batch.rowCount} rows (retention cutoff ${batch.cutoff})`);
  return batch;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('snapshot-prices failed:', error.message);
    process.exit(1);
  });
}
