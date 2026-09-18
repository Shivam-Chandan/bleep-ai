import 'server-only';
import path from 'node:path';
import fs from 'node:fs';

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface DbResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
}

interface Driver {
  select<T>(sql: string, args: SqlValue[]): Promise<T[]>;
  execute(sql: string, args: SqlValue[]): Promise<DbResult>;
}

// Remote Turso/libSQL when configured (works on Vercel and locally);
// otherwise a local SQLite file via better-sqlite3 (dev fallback).
const REMOTE_URL =
  process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const REMOTE_TOKEN =
  process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';

export const usingRemote = Boolean(REMOTE_URL);

import {
  RATE_LIMIT_INDEX,
  RATE_LIMIT_KEY_INDEX,
  RATE_LIMIT_TABLE,
} from './rateLimit';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id            TEXT PRIMARY KEY,
     username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     created_at    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS chats (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     title      TEXT NOT NULL DEFAULT 'New Chat',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id         TEXT PRIMARY KEY,
     chat_id    TEXT NOT NULL,
     role       TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC)`,
  // Per-user machine tokens used by data-source integrations (Google Apps
  // Script, Slack poller) to POST into /api/ingest without a session cookie.
  // Only the SHA-256 hash of the token is stored.
  `CREATE TABLE IF NOT EXISTS ingest_tokens (
     token_hash TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     label      TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ingest_tokens_user ON ingest_tokens(user_id)`,
  // Raw items scraped from each source, one row per email/event/message.
  // Keyed per-user; `day` is the user's local calendar day (YYYY-MM-DD).
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
  // Dedupe re-POSTs of the same source item for the same user.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_dedupe
     ON digest_items(user_id, source, external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_digest_day
     ON digest_items(user_id, day, source)`,
  // One generated markdown summary per user per day.
  `CREATE TABLE IF NOT EXISTS digest_summaries (
     user_id    TEXT NOT NULL,
     day        TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, day),
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  RATE_LIMIT_TABLE,
  RATE_LIMIT_INDEX,
  RATE_LIMIT_KEY_INDEX,
];

async function createRemoteDriver(): Promise<Driver> {
  const { createClient } = await import('@libsql/client/web');
  const url = REMOTE_URL.replace(/^libsql:\/\//, 'https://').replace(
    /^wss:\/\//,
    'https://'
  );
  const client = createClient({
    url,
    authToken: REMOTE_TOKEN || undefined,
    intMode: 'number',
  });

  return {
    async select<T>(sql: string, args: SqlValue[]): Promise<T[]> {
      const result = await client.execute({ sql, args });
      return result.rows as unknown as T[];
    },
    async execute(sql: string, args: SqlValue[]): Promise<DbResult> {
      const result = await client.execute({ sql, args });
      return {
        rows: result.rows as unknown as Record<string, unknown>[],
        rowsAffected: result.rowsAffected,
      };
    },
  };
}

async function createLocalDriver(): Promise<Driver> {
  const { default: Database } = await import('better-sqlite3');
  const DB_PATH =
    process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return {
    async select<T>(sql: string, args: SqlValue[]): Promise<T[]> {
      return sqlite.prepare(sql).all(...(args as never[])) as T[];
    },
    async execute(sql: string, args: SqlValue[]): Promise<DbResult> {
      const info = sqlite.prepare(sql).run(...(args as never[]));
      return { rows: [], rowsAffected: info.changes };
    },
  };
}

// A single shared driver for the whole app (module singleton).
declare global {
  var __dbDriver__: Promise<Driver> | undefined;
  var __dbSchema__: Promise<void> | undefined;
}

function getDriver(): Promise<Driver> {
  if (!global.__dbDriver__) {
    global.__dbDriver__ = usingRemote
      ? createRemoteDriver()
      : createLocalDriver();
  }
  return global.__dbDriver__;
}

function ensureSchema(): Promise<void> {
  if (!global.__dbSchema__) {
    global.__dbSchema__ = (async () => {
      const driver = await getDriver();
      for (const stmt of SCHEMA) {
        await driver.execute(stmt, []);
      }
    })();
  }
  return global.__dbSchema__;
}

export async function select<T>(
  sql: string,
  args: SqlValue[] = []
): Promise<T[]> {
  await ensureSchema();
  return (await getDriver()).select<T>(sql, args);
}

export async function execute(
  sql: string,
  args: SqlValue[] = []
): Promise<DbResult> {
  await ensureSchema();
  return (await getDriver()).execute(sql, args);
}
