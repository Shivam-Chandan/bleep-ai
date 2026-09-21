#!/usr/bin/env node
/**
 * encrypt-existing-data.mjs — one-time migration that seals rows written
 * before application-level encryption was introduced.
 *
 * New writes are encrypted automatically (see src/lib/crypto.mjs and
 * src/lib/queries.ts); existing rows are left untouched and still readable
 * because decrypt() passes legacy plaintext through. This script rewrites those
 * legacy rows in place so a database dump reveals nothing.
 *
 * It is idempotent: already-encrypted values are skipped, so it is safe to run
 * more than once (useful if new legacy rows appear from another deploy).
 *
 * IMPORTANT: the key used here (ENCRYPTION_KEY, or the SESSION_SECRET-derived
 * fallback) must be exactly the same key the running app and the box-side
 * digest worker use. Back up the database before running this. Generating a NEW
 * ENCRYPTION_KEY now means existing plaintext can still be migrated, but any
 * data already encrypted with a different key would become unreadable.
 *
 * Usage:
 *   node --env-file=.env.local scripts/encrypt-existing-data.mjs [--dry-run]
 *
 * Env (same as src/lib/db.ts):
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN   (or LIBSQL_URL / LIBSQL_AUTH_TOKEN)
 *   DB_PATH                                 local SQLite fallback (default ./data/app.db)
 *   ENCRYPTION_KEY                          ../../(or SESSION_SECRET fallback)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  encrypt,
  encryptDeterministic,
  isEncrypted,
  sealUsername,
} from '../src/lib/crypto.mjs';

const REMOTE_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const REMOTE_TOKEN =
  process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');
const DRY_RUN = process.argv.includes('--dry-run');

// Every sensitive column, with the primary-key columns used to target the
// UPDATE. `seal` mirrors the mode used by src/lib/queries.ts: deterministic for
// values that are looked up/deduped by equality, random IV for free text.
const JOBS = [
  { table: 'users', column: 'username', key: ['id'], seal: (v) => sealUsername(v) },
  { table: 'chats', column: 'title', key: ['id'], seal: encrypt },
  { table: 'messages', column: 'content', key: ['id'], seal: encrypt },
  { table: 'digest_items', column: 'payload', key: ['id'], seal: encrypt },
  {
    table: 'digest_items',
    column: 'external_id',
    key: ['id'],
    seal: encryptDeterministic,
  },
  { table: 'digest_summaries', column: 'content', key: ['user_id', 'day'], seal: encrypt },
  { table: 'ingest_tokens', column: 'label', key: ['token_hash'], seal: encrypt },
  { table: 'digest_runs', column: 'error', key: ['id'], seal: encrypt },
  {
    table: 'limit_attempts',
    column: 'key_',
    key: ['id'],
    seal: encryptDeterministic,
  },
];

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function createDriver() {
  if (REMOTE_URL) {
    const { createClient } = await import('@libsql/client');
    const url = REMOTE_URL.replace(/^libsql:\/\//, 'https://').replace(
      /^wss:\/\//,
      'https://'
    );
    const client = createClient({
      url,
      authToken: REMOTE_TOKEN || undefined,
      intMode: 'number',
    });
    log('DB: remote Turso/libSQL at', url);
    return {
      async select(sql, args = []) {
        const r = await client.execute({ sql, args });
        return r.rows;
      },
      async execute(sql, args = []) {
        const r = await client.execute({ sql, args });
        return { rowsAffected: r.rowsAffected };
      },
      close() {
        client.close();
      },
    };
  }

  const { default: Database } = await import('better-sqlite3');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  log('DB: local SQLite at', DB_PATH);
  return {
    async select(sql, args = []) {
      return sqlite.prepare(sql).all(...args);
    },
    async execute(sql, args = []) {
      const info = sqlite.prepare(sql).run(...args);
      return { rowsAffected: info.changes };
    },
    close() {
      sqlite.close();
    },
  };
}

async function migrateJob(db, job) {
  const { table, column, key, seal } = job;
  const keySelect = key.join(', ');
  let rows;
  try {
    rows = await db.select(`SELECT ${keySelect}, ${column} AS value FROM ${table}`);
  } catch (err) {
    log(`skip ${table}.${column}: ${err instanceof Error ? err.message : err}`);
    return { table, column, scanned: 0, migrated: 0, skipped: true };
  }

  let migrated = 0;
  for (const row of rows) {
    const value = row.value;
    if (value === null || value === undefined || value === '') continue;
    if (isEncrypted(value)) continue;

    if (!DRY_RUN) {
      const where = key.map((k) => `${k} = ?`).join(' AND ');
      await db.execute(
        `UPDATE ${table} SET ${column} = ? WHERE ${where}`,
        [seal(String(value)), ...key.map((k) => row[k])]
      );
    }
    migrated += 1;
  }

  log(
    `${table}.${column}: scanned=${rows.length} ${DRY_RUN ? 'would encrypt' : 'encrypted'}=${migrated}`
  );
  return { table, column, scanned: rows.length, migrated, skipped: false };
}

async function main() {
  if (!process.env.ENCRYPTION_KEY) {
    log(
      'WARNING: ENCRYPTION_KEY is not set; using the SESSION_SECRET-derived fallback. ' +
        'Set ENCRYPTION_KEY consistently across the app and worker before relying on this.'
    );
  }
  if (DRY_RUN) log('DRY RUN: no rows will be written.');

  const db = await createDriver();
  const results = [];
  try {
    for (const job of JOBS) {
      results.push(await migrateJob(db, job));
    }
  } finally {
    db.close();
  }

  const total = results.reduce((n, r) => n + r.migrated, 0);
  log(`Done. ${DRY_RUN ? 'Would encrypt' : 'Encrypted'} ${total} value(s) total.`);
}

main().catch((err) => {
  log('Fatal:', err);
  process.exit(1);
});
