#!/usr/bin/env node
/**
 * Creates a user (if needed) and an ingest token in the LOCAL scratch SQLite DB,
 * matching src/lib/db.ts schema and src/lib/ingest.ts hashing. Prints the raw
 * token so you can paste it into Google Apps Script as INGEST_TOKEN.
 *
 * Usage: node scripts/make-ingest-token.mjs [username]
 *   DB_PATH defaults to ./data/app.db (same as the app's local fallback).
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');
const username = process.argv[2] || 'digest-tester';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Minimal schema (mirrors src/lib/db.ts) so this runs standalone.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ingest_tokens (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, last_used_at INTEGER
  );
`);

// Reuse existing user or create one (password isn't needed for ingest testing).
let user = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
if (!user) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)')
    .run(id, username, 'x', Date.now());
  user = { id };
  console.log(`Created user "${username}" (id=${id})`);
} else {
  console.log(`Using existing user "${username}" (id=${user.id})`);
}

// Generate a token the SAME way as src/lib/ingest.ts.
const token = 'ingest_' + crypto.randomBytes(24).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
db.prepare('INSERT INTO ingest_tokens (token_hash, user_id, label, created_at) VALUES (?,?,?,?)')
  .run(tokenHash, user.id, 'apps-script-local-test', Date.now());
db.close();

console.log('\n=== INGEST TOKEN (paste into Apps Script Script Property INGEST_TOKEN) ===');
console.log(token);
console.log('\nDB:', DB_PATH);
