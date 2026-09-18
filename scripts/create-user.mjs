#!/usr/bin/env node
/**
 * Creates a user directly in the database, bypassing the signup page's
 * min-length rules (useful for bootstrapping the first account or a low
 * -length local-only password).
 *
 * Usage:
 *   node --env-file=.env.local scripts/create-user.mjs <username> [password]
 *
 * Password defaults to the username when omitted. Reads the same config as
 * src/lib/db.ts: remote Turso when TURSO_DATABASE_URL is set, otherwise the
 * local SQLite file at DB_PATH (default ./data/app.db).
 */
import { createClient } from '@libsql/client/web';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const REMOTE_URL =
  process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const REMOTE_TOKEN =
  process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';
const DB_PATH = process.env.DB_PATH || './data/app.db';

const username = process.argv[2];
const password = process.argv[3] || process.argv[2];

if (!username) {
  console.error(
    'Usage: node --env-file=.env.local scripts/create-user.mjs <username> [password]'
  );
  process.exit(1);
}

function makeLocalDriver() {
  return (async () => {
    const { default: Database } = await import('better-sqlite3');
    const sqlite = new Database(DB_PATH);
    await sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      )
    `);
    return sqlite;
  })();
}

async function main() {
  let client;
  let local;
  if (REMOTE_URL) {
    client = createClient({
      url: REMOTE_URL.replace(/^libsql:\/\//, 'https://').replace(
        /^wss:\/\//,
        'https://'
      ),
      authToken: REMOTE_TOKEN || undefined,
      intMode: 'number',
    });
  } else {
    local = await makeLocalDriver();
  }

  const select = async (sql, args = []) => {
    if (client) {
      const res = await client.execute({ sql, args });
      return res.rows;
    }
    return local.prepare(sql).all(...args);
  };
  const execute = async (sql, args = []) => {
    if (client) {
      await client.execute({ sql, args });
      return;
    }
    local.prepare(sql).run(...args);
  };
  const close = async () => {
    if (local) local.close();
    if (client) client.close();
  };

  const existing = await select(
    'SELECT id FROM users WHERE username = ? COLLATE NOCASE',
    [username]
  );
  if (existing.length > 0) {
    console.error(`User "${username}" already exists (id=${existing[0].id}).`);
    await close();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  await execute(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), username, hash, Date.now()]
  );
  await close();
  console.log(`Created user "${username}".`);
  console.log('Password:', '*'.repeat(password.length));
}

main().catch((err) => {
  console.error('Failed to create user:', err.message);
  process.exit(1);
});