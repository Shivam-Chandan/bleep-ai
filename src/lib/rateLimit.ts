import 'server-only';
import { execute, select } from './db';

// Simple sliding-window attempt limiter backed by the same SQLite/Turso
// database, so it works on the serverless (Vercel) runtime too.
// Persists into a shared table: limit_attempts(key_ TEXT, ts INTEGER)

export const RATE_LIMIT_TABLE = `CREATE TABLE IF NOT EXISTS limit_attempts (
   id   INTEGER PRIMARY KEY AUTOINCREMENT,
   key_ TEXT NOT NULL,
   ts   INTEGER NOT NULL
 )`;

export const RATE_LIMIT_INDEX = `CREATE INDEX IF NOT EXISTS idx_limit_ts ON limit_attempts(ts)`;
export const RATE_LIMIT_KEY_INDEX = `CREATE INDEX IF NOT EXISTS idx_limit_key ON limit_attempts(key_, ts)`;

interface AttemptRow {
  n: number;
}

// Returns the current number of recorded attempts for `key`.
export async function countAttempts(key: string): Promise<number> {
  const rows = await select<AttemptRow>(
    `SELECT COUNT(*) AS n FROM limit_attempts WHERE key_ = ?`,
    [key]
  );
  return rows[0]?.n ?? 0;
}

export interface RateLimitCheck {
  allowed: boolean;
  attempts: number;
  retryAfterSeconds: number;
}

// Check a limit: allow up to `max` rate-limited events per `windowSeconds`.
export async function checkRateLimit(
  key: string,
  max: number,
  windowSeconds: number
): Promise<RateLimitCheck> {
  await execute(`DELETE FROM limit_attempts WHERE ts < ?`, [
    Date.now() - windowSeconds * 1000,
  ]);
  const attempts = await countAttempts(key);
  return {
    allowed: attempts < max,
    attempts,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(windowSeconds - ((Date.now() / 1000) % windowSeconds))
    ),
  };
}

// Record a rate-limited event for `key`; expires naturally with the window.
export async function recordAttempt(key: string): Promise<void> {
  await execute(`INSERT INTO limit_attempts (key_, ts) VALUES (?, ?)`, [
    key,
    Date.now(),
  ]);
}

// Clear all recorded events for `key` (e.g. after a successful login).
export async function clearAttempts(key: string): Promise<void> {
  await execute(`DELETE FROM limit_attempts WHERE key_ = ?`, [key]);
}