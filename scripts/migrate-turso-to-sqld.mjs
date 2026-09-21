#!/usr/bin/env node
/**
 * migrate-turso-to-sqld.mjs
 *
 * One-shot migration: copy the full schema + every row from the old remote
 * Turso cloud DB (SOURCE_DATABASE_URL/SOURCE_DATABASE_TOKEN) into the local
 * sqld server (LOCAL_DB_URL / LOCAL_DB_TOKEN), which this box hosts over the
 * tailnet.
 *
 * Bytes are copied verbatim — chat/message/digest content stays encrypted with
 * the same ENCRYPTION_KEY, so it remains readable after the move.
 *
 * Idempotent: drops and recreates the target tables first, so it is safe to
 * re-run. Row counts are printed for each table as a sanity check.
 *
 * Usage:
 *   node scripts/migrate-turso-to-sqld.mjs
 * Env (source values no longer live in .env.local; use the pre-migration backup
 * e.g. /tmp/opencode/env.local.turso-backup):
 *   SOURCE_DATABASE_URL, SOURCE_DATABASE_TOKEN         (the old Turso cloud DB)
 *   LOCAL_DB_URL (=http://<tailscale-ip>:8080), LOCAL_DB_TOKEN  (destination)
 */

import { createClient } from '@libsql/client';

const REMOTE_URL = process.env.SOURCE_DATABASE_URL || process.env.LIBSQL_URL;
const REMOTE_TOKEN = process.env.SOURCE_DATABASE_TOKEN || process.env.LIBSQL_AUTH_TOKEN;
const LOCAL_URL = process.env.LOCAL_DB_URL || 'http://127.0.0.1:8080';
const LOCAL_TOKEN = process.env.LOCAL_DB_TOKEN || '';

if (!REMOTE_URL || !REMOTE_TOKEN) {
  console.error('Missing SOURCE_DATABASE_URL / SOURCE_DATABASE_TOKEN (source).');
  process.exit(2);
}
if (!LOCAL_TOKEN) {
  console.error('Missing LOCAL_DB_TOKEN (destination).');
  process.exit(2);
}

const remote = createClient({
  url: REMOTE_URL.replace(/^libsql:\/\//, 'https://').replace(/^wss:\/\//, 'https://'),
  authToken: REMOTE_TOKEN,
  intMode: 'number',
});
const local = createClient({ url: LOCAL_URL, authToken: LOCAL_TOKEN, intMode: 'number' });

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function main() {
  const schema = await remote.execute(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid`
  );
  const tables = schema.rows.map((r) => ({ name: r.name, sql: r.sql }));

  const indexRows = await remote.execute(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY rowid`
  );

  console.log(`Migrating ${tables.length} tables from source -> ${LOCAL_URL}`);

  // Drop everything in the destination first (idempotency).
  for (const t of tables) {
    await local.execute(`DROP TABLE IF EXISTS "${t.name}"`).catch((e) => {
      console.error(`drop ${t.name}: ${e.message}`);
    });
  }

  // Re-create schema from the source's own DDL (round-trips exactly).
  for (const t of tables) {
    await local.execute(t.sql);
  }

  // Copy data, table by table.
  for (const t of tables) {
    const rows = (await remote.execute(`SELECT * FROM "${t.name}"`)).rows;
    if (rows.length === 0) {
      console.log(`  ${t.name}: 0 rows`);
      continue;
    }
    const keys = Object.keys(rows[0]);
    const cols = keys.map((k) => `"${k}"`).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    for (const batch of chunk(rows, 200)) {
      const statements = batch.map((row) => ({
        sql: `INSERT INTO "${t.name}" (${cols}) VALUES (${placeholders})`,
        args: keys.map((k) => row[k]),
      }));
      await local.batch(statements, 'write');
    }
    console.log(`  ${t.name}: ${rows.length} rows`);
  }

  // Preserve AUTOINCREMENT counters (limit_attempts uses sqlite_sequence).
  const seq = (await remote.execute(`SELECT * FROM sqlite_sequence`)).rows;
  for (const s of seq) {
    await local.execute(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`, [s.seq, s.name]);
  }
  if (seq.length) console.log(`  sqlite_sequence: ${seq.length} entries restored`);

  // Explicit indexes.
  for (const ix of indexRows.rows) {
    await local.execute(ix.sql);
  }
  console.log(`Created ${indexRows.rows.length} indexes`);

  // Verify counts match.
  let ok = true;
  for (const t of tables) {
    const a = (await remote.execute(`SELECT COUNT(*) AS c FROM "${t.name}"`)).rows[0].c;
    const b = (await local.execute(`SELECT COUNT(*) AS c FROM "${t.name}"`)).rows[0].c;
    if (a !== b) {
      ok = false;
      console.error(`  MISMATCH ${t.name}: remote=${a} local=${b}`);
    }
  }
  console.log(ok ? 'Counts verified: all tables match.' : 'Count MISMATCH detected!');
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => {
    remote.close();
    local.close();
  });