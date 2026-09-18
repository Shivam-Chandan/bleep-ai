#!/usr/bin/env node
/**
 * Applies the digest-related tables/indexes to the remote Turso DB, idempotently
 * (CREATE ... IF NOT EXISTS). Mirrors the digest portion of SCHEMA in
 * src/lib/db.ts so production has the tables before any traffic.
 *
 * Usage:
 *   node --env-file=/tmp/bleep-prod2.env scripts/apply-digest-schema.mjs
 * (needs TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in the env)
 */
import { createClient } from '@libsql/client/web';

const URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';
if (!URL) {
  console.error('TURSO_DATABASE_URL is required');
  process.exit(1);
}

const client = createClient({
  url: URL.replace(/^libsql:\/\//, 'https://').replace(/^wss:\/\//, 'https://'),
  authToken: TOKEN || undefined,
  intMode: 'number',
});

// Exactly the digest additions from src/lib/db.ts SCHEMA.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ingest_tokens (
     token_hash TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     label      TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ingest_tokens_user ON ingest_tokens(user_id)`,
  `CREATE TABLE IF NOT EXISTS digest_items (
     id          TEXT PRIMARY KEY,
     user_id     TEXT NOT NULL,
     source      TEXT NOT NULL,
     day         TEXT NOT NULL,
     external_id TEXT,
     payload     TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_dedupe
     ON digest_items(user_id, source, external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_digest_day
     ON digest_items(user_id, day, source)`,
  `CREATE TABLE IF NOT EXISTS digest_summaries (
     user_id    TEXT NOT NULL,
     day        TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, day),
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
];

for (const sql of STATEMENTS) {
  await client.execute(sql);
  console.log('ok:', sql.trim().split('\n')[0]);
}
client.close();
console.log('\nDigest schema applied to Turso.');
