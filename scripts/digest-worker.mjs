#!/usr/bin/env node
/**
 * digest-worker.mjs — box-side daily-digest generator.
 * -----------------------------------------------------
 * Runs as a long-lived process ON THE SAME MACHINE AS OLLAMA (not on
 * Vercel). It polls the `digest_runs` queue that the Next app writes to
 * (POST /api/ingest -> POST /api/digest/run enqueues a row and returns
 * instantly), generates the briefing locally against http://localhost:11434
 * with no tunnel and no wall-clock deadline, and writes the result straight
 * to the same database the Next app reads from (Turso, so /digest updates
 * with no redeploy).
 *
 * WHY THIS EXISTS: a realistic day's briefing on qwen2.5:3b on this box's
 * GPU takes minutes (measured ~5.5 min for a full-size prompt + 1536 output
 * tokens). Vercel functions cap out at maxDuration=300s. There is no model
 * setting that closes that gap without cutting output quality or length —
 * see the conversation this script came out of. Generating here instead of
 * inside the Vercel function removes the deadline entirely: output quality
 * and length are never traded for latency.
 *
 * DB: mirrors src/lib/db.ts's driver choice (remote Turso when
 * TURSO_DATABASE_URL/LIBSQL_URL is set, else a local SQLite file at DB_PATH)
 * so this script and the Next app always agree on the same schema/data
 * without importing Next/TypeScript machinery — see src/lib/digestCore.mjs
 * for why the prompt-building logic itself is a shared plain-JS module
 * rather than being duplicated here.
 *
 * Usage:
 *   node --env-file=.env.local scripts/digest-worker.mjs
 *   # or as a systemd service — see scripts/bleep-digest-worker.service
 *
 * Env:
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN   (or LIBSQL_URL / LIBSQL_AUTH_TOKEN)
 *   DB_PATH                                 local SQLite fallback (default ./data/app.db)
 *   OLLAMA_LOCAL_URL                        default http://127.0.0.1:11434 (bypasses
 *                                            the public tunnel/auth proxy entirely —
 *                                            this process runs on the box, so it talks
 *                                            to Ollama directly, no auth needed)
 *   OLLAMA_AUTH_TOKEN                       optional; only needed if OLLAMA_LOCAL_URL
 *                                            points at something other than a bare
 *                                            localhost Ollama (e.g. testing against the
 *                                            public tunnel from another machine)
 *   OLLAMA_MODEL                            default qwen2.5:3b
 *   DIGEST_CONTEXT_WINDOW                   default 8192 (must match what
 *                                            warm-ollama.sh pins, or every run reloads)
 *   DIGEST_WORKER_POLL_SECONDS              default 300 (5 min)
 *   DIGEST_WORKER_STALE_MS                  default 1800000 (30 min) — a 'processing'
 *                                            row older than this is assumed crashed
 *                                            and requeued
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDigestPrompt,
  callDigestModel,
  CONTEXT_WINDOW,
} from '../src/lib/digestCore.mjs';

const REMOTE_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const REMOTE_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');

const OLLAMA_URL = process.env.OLLAMA_LOCAL_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const OLLAMA_AUTH_HEADER = process.env.OLLAMA_AUTH_TOKEN
  ? { Authorization: `Bearer ${process.env.OLLAMA_AUTH_TOKEN}` }
  : {};
const POLL_SECONDS = Number(process.env.DIGEST_WORKER_POLL_SECONDS) || 300;
const STALE_MS = Number(process.env.DIGEST_WORKER_STALE_MS) || 30 * 60_000;

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ---------- DB driver (mirrors src/lib/db.ts) ----------

async function createDriver() {
  if (REMOTE_URL) {
    const { createClient } = await import('@libsql/client');
    const url = REMOTE_URL.replace(/^libsql:\/\//, 'https://').replace(/^wss:\/\//, 'https://');
    const client = createClient({ url, authToken: REMOTE_TOKEN || undefined, intMode: 'number' });
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
    };
  }
  const { default: Database } = await import('better-sqlite3');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  log('DB: local SQLite at', DB_PATH);
  return {
    async select(sql, args = []) {
      return sqlite.prepare(sql).all(...args);
    },
    async execute(sql, args = []) {
      const info = sqlite.prepare(sql).run(...args);
      return { rowsAffected: info.changes };
    },
  };
}

// Only the tables this worker touches. The Next app's own ensureSchema()
// (src/lib/db.ts) is the source of truth for the full schema; this is just
// enough for the worker to run standalone (e.g. if it starts before the app
// has ever hit the DB) without diverging from it.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS digest_runs (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL,
     day          TEXT NOT NULL,
     status       TEXT NOT NULL DEFAULT 'pending',
     error        TEXT,
     requested_at INTEGER NOT NULL,
     started_at   INTEGER,
     finished_at  INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_runs_dedupe ON digest_runs(user_id, day)`,
  `CREATE INDEX IF NOT EXISTS idx_digest_runs_status ON digest_runs(status, requested_at)`,
  `CREATE TABLE IF NOT EXISTS digest_summaries (
     user_id    TEXT NOT NULL,
     day        TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, day)
   )`,
];

// ---------- Single-instance lock (mirrors warm-ollama.sh's flock intent) ----------

const LOCK_FILE = process.env.DIGEST_WORKER_LOCK || '/tmp/bleep-digest-worker.lock';

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    const alive = pid && (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive) {
      log(`Another worker is already running (pid ${pid}); exiting.`);
      process.exit(0);
    }
    log(`Stale lock file (pid ${pid} not running); taking over.`);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // best effort
  }
}

// ---------- Core work ----------

async function upsertDigestSummary(db, userId, day, content) {
  const info = await db.execute(
    `UPDATE digest_summaries SET content = ?, created_at = ? WHERE user_id = ? AND day = ?`,
    [content, Date.now(), userId, day]
  );
  if (info.rowsAffected > 0) return;
  await db.execute(
    `INSERT INTO digest_summaries (user_id, day, content, created_at) VALUES (?, ?, ?, ?)`,
    [userId, day, content, Date.now()]
  );
}

async function processRun(db, run) {
  const claimed = await db.execute(
    `UPDATE digest_runs SET status = 'processing', started_at = ? WHERE id = ? AND status = 'pending'`,
    [Date.now(), run.id]
  );
  if (claimed.rowsAffected === 0) {
    log(`  run ${run.id} was claimed elsewhere; skipping`);
    return;
  }

  try {
    const rows = await db.select(
      `SELECT * FROM digest_items WHERE user_id = ? AND day = ? ORDER BY source ASC, created_at ASC`,
      [run.user_id, run.day]
    );
    if (rows.length === 0) {
      log(`  no items for user=${run.user_id} day=${run.day}; marking done with nothing to say`);
      await db.execute(`UPDATE digest_runs SET status = 'done', finished_at = ? WHERE id = ?`, [
        Date.now(),
        run.id,
      ]);
      return;
    }

    const prompt = buildDigestPrompt(run.day, rows);
    log(`  generating: user=${run.user_id} day=${run.day} items=${rows.length} promptChars=${prompt.length}`);
    const t0 = Date.now();
    // No AbortSignal deadline race here beyond callDigestModel's own generous
    // crash-protection timeout — this is the whole point of running here
    // instead of on Vercel. Output length/quality is never traded for speed.
    const content = await callDigestModel({
      baseUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      authHeader: OLLAMA_AUTH_HEADER,
      prompt,
      contextWindow: CONTEXT_WINDOW,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!content) {
      throw new Error('model returned empty content');
    }

    await upsertDigestSummary(db, run.user_id, run.day, content);
    await db.execute(`UPDATE digest_runs SET status = 'done', finished_at = ? WHERE id = ?`, [
      Date.now(),
      run.id,
    ]);
    log(`  done in ${elapsed}s -> ${content.length} chars`);
  } catch (err) {
    // A bare fetch failure (network blip, DNS hiccup, tunnel restart) throws
    // a generic "fetch failed" with the real reason in `.cause` — surface it,
    // since this runs unattended and the journal is the only place to see it.
    const cause = err instanceof Error && err.cause ? `: ${err.cause}` : '';
    const message = (err instanceof Error ? err.message : String(err)) + cause;
    log(`  FAILED: ${message}`);
    await db.execute(
      `UPDATE digest_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
      [Date.now(), message.slice(0, 2000), run.id]
    );
  }
}

async function pollOnce(db) {
  const requeued = await db.execute(
    `UPDATE digest_runs SET status = 'pending', started_at = NULL
     WHERE status = 'processing' AND started_at < ?`,
    [Date.now() - STALE_MS]
  );
  if (requeued.rowsAffected > 0) {
    log(`Requeued ${requeued.rowsAffected} stale 'processing' run(s).`);
  }

  const pending = await db.select(
    `SELECT * FROM digest_runs WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 10`
  );
  if (pending.length === 0) {
    log('No pending digest runs.');
    return;
  }
  log(`Found ${pending.length} pending run(s).`);
  for (const run of pending) {
    await processRun(db, run);
  }
}

async function main() {
  acquireLock();
  const cleanup = () => {
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const db = await createDriver();
  for (const stmt of SCHEMA) await db.execute(stmt, []);

  log(
    `digest-worker started. ollama=${OLLAMA_URL} model=${OLLAMA_MODEL} ` +
      `ctx=${CONTEXT_WINDOW} pollEvery=${POLL_SECONDS}s pid=${process.pid}`
  );

  // Poll in a plain loop (await between iterations) rather than setInterval,
  // so a slow generation can never overlap with the next tick.
  for (;;) {
    try {
      await pollOnce(db);
    } catch (err) {
      log('Poll cycle error:', err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((err) => {
  log('Fatal:', err);
  releaseLock();
  process.exit(1);
});
