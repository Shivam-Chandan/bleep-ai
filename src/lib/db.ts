import 'server-only';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// Store the DB file next to the project (or wherever DB_PATH points).
// SQLite is a single file — no server process, near-zero idle RAM.
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');

// Ensure the directory exists.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// A single shared connection for the whole app (module singleton).
declare global {
  var __sqlite__: Database.Database | undefined;
}

function createDb(): Database.Database {
  const db = new Database(DB_PATH);
  // WAL mode = better concurrency and durability, still a plain file.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT 'New Chat',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC);
  `);

  return db;
}

export const db = global.__sqlite__ ?? createDb();
if (process.env.NODE_ENV !== 'production') global.__sqlite__ = db;