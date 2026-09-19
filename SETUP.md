# Deployment & Setup Guide — User Auth + Per-User Chat Persistence

> **Audience:** the agent running on the laptop that serves the local Ollama model.
> This document describes (1) what changed in the app and (2) exactly what to do on
> this laptop to get it running.

---

## 1. What changed (summary)

The app went from an unauthenticated chat proxy to a **multi-user app with local
username/password authentication and per-user chat history**, all stored locally in
SQLite. No third-party auth service is used.

### New capabilities
- Login/signup form (username + password only).
- Session auth via a signed JWT stored in an **HttpOnly cookie** (`jose`).
- Passwords hashed with `bcryptjs`.
- All chats and messages are **saved per-user** in a local **SQLite** database.
- Every API call (`/api/chat`, `/api/chats`) requires a valid session.
- Unauthenticated browser requests are redirected to `/login` by `src/proxy.ts`
  (Next.js 16 renamed `middleware` → `proxy`).

### New files
| File | Purpose |
|------|---------|
| `src/lib/db.ts` | Opens/creates the SQLite file and schema (users, chats, messages). |
| `src/lib/queries.ts` | Typed DB queries + per-user authorization helpers. |
| `src/lib/session.ts` | JWT create/verify + HttpOnly session cookie management. |
| `src/lib/auth.ts` | Password hashing (`bcryptjs`) + `requireSession()` route guard. |
| `src/proxy.ts` | Route protection; redirects logged-out users to `/login`. |
| `src/app/login/page.tsx` | Login/signup UI. |
| `src/app/api/auth/login/route.ts` | Login endpoint. |
| `src/app/api/auth/signup/route.ts` | Signup endpoint. |
| `src/app/api/auth/logout/route.ts` | Logout endpoint. |
| `src/app/api/chats/route.ts` | List/create the logged-in user's chats. |
| `src/app/api/chats/[id]/route.ts` | Rename/delete a chat. |

### Modified files
| File | Change |
|------|--------|
| `next.config.ts` | Added `output: "standalone"`, `serverExternalPackages: ["better-sqlite3"]`; removed the wide-open CORS headers. |
| `src/app/page.tsx` | Now a Server Component; verifies session, redirects to `/login`, passes `username` to the UI. |
| `src/app/api/chat/route.ts` | Requires a session; persists user + assistant messages to the chat. |
| `src/lib/store.ts` | Loads/saves chats from the DB API per-user (no more localStorage). |
| `src/components/ChatLayout.tsx` | Loads chats on mount, shows logout. |
| `src/components/ChatSidebar.tsx` | Shows current user + sign-out button. |
| `src/components/ChatWindow.tsx` | Sends `chatId` so messages persist to the right chat. |
| `.env.example` | Documents `SESSION_SECRET`, `DB_PATH`, `REGISTRATION_OPEN`. |
| `.gitignore` | Ignores `/data/` and `*.db*` (the SQLite files are per-machine). |

### New dependencies
- `better-sqlite3` — synchronous SQLite driver (native module, needs a C toolchain to build).
- `bcryptjs` — pure-JS password hashing.
- `jose` — JWT signing/verification.
- `@types/better-sqlite3` (dev).

---

## 2. Data model (SQLite)

A single file at `./data/app.db` (override with `DB_PATH`). Created automatically on
first run. WAL mode enabled.

```
users(id, username UNIQUE, password_hash, created_at)
chats(id, user_id -> users.id, title, created_at, updated_at)
messages(id, chat_id -> chats.id, role, content, created_at)
```

The DB is **per-machine and git-ignored** — this laptop keeps its own users/chats.

---

## 3. Setup steps on THIS laptop

### Prerequisites
- **Node.js 20+**
- **A C toolchain** (required to compile `better-sqlite3`):
  - macOS: `xcode-select --install`
  - Debian/Ubuntu: `sudo apt-get install -y build-essential python3`
- **Ollama** already running locally (it is — this laptop serves the model).

### Steps

```bash
# 1. Get the latest code
git pull            # (repo already cloned; otherwise: git clone https://github.com/Shivam-Chandan/bleep-ai.git)
cd bleep-ai-chat

# 2. Install dependencies (this compiles better-sqlite3)
npm ci

# 3. Create local env config
cp .env.example .env.local
```

Edit `.env.local`:

```bash
# Model is served locally on this laptop:
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b

# Optional: bearer token for an authed Ollama tunnel (leave unset for direct localhost)
# OLLAMA_AUTH_TOKEN=

# REQUIRED: generate a stable secret. Do NOT change it later (it logs everyone out).
SESSION_SECRET=<run: openssl rand -base64 32>

# Optional: relocate the SQLite file (defaults to ./data/app.db)
# DB_PATH=/absolute/path/to/app.db

# Allow first-time signups; set to false after accounts are created.
REGISTRATION_OPEN=false

# REQUIRED once the app is exposed publicly (tunnel/Vercel): a shared secret
# protecting /api/warm and /api/health. Callers must send it in the
# Authorization: Bearer header (or a custom header, default: x-health-check).
# Without it those endpoints return 401. Leave unset only for localhost dev.
HEALTH_CHECK_SECRET=<run: openssl rand -base64 24>
```

Generate the secrets:
```bash
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 24   # HEALTH_CHECK_SECRET
```

### Run (production)

```bash
npm run build
npm start            # serves on http://localhost:3000
```

Or keep it alive with pm2:
```bash
npm i -g pm2
pm2 start npm --name bleep-ai-chat -- start
pm2 save
```

### First login
1. Open `http://localhost:3000` → you'll be redirected to `/login`.
2. Click **Sign up**, create the first account (username ≥ 3 chars, password ≥ 10 chars).
3. You're dropped into the chat UI. Chats now persist per-user (Turso/libSQL when configured, else local SQLite).
4. Signups are already locked at the app level (`REGISTRATION_OPEN=false` in env).
   Re-enable temporarily only when you need a new account, then flip it back and restart.

---

## 4. Updating later (git workflow)

```bash
git pull
npm ci
npm run build
pm2 restart bleep-ai-chat    # or: npm start
```

The SQLite DB persists across updates (it's outside git). Schema is created with
`CREATE TABLE IF NOT EXISTS`, so existing data is preserved.

---

## 5. Verifying it works (optional smoke test)

```bash
# Unauthenticated API call is rejected/redirected
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/chats     # 307 (redirect) or 401

# Sign up (stores a session cookie in cj.txt)
curl -s -c cj.txt -X POST http://localhost:3000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"username":"test","password":"secret123"}'

# Authenticated call returns the user's chats
curl -s -b cj.txt http://localhost:3000/api/chats
rm cj.txt
```

---

## 6. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `better-sqlite3` fails to install | Install the C toolchain (see Prerequisites), then `npm ci` again. |
| Everyone got logged out after a deploy | `SESSION_SECRET` changed. Set a fixed value in `.env.local`. |
| Redirect loop to `/login` | Cookie not being set — ensure you're on `http://localhost` (dev cookies are non-secure) and `SESSION_SECRET` is set. |
| Can't reach the model | Confirm `OLLAMA_BASE_URL` and that `ollama serve` is running: `curl http://localhost:11434/api/tags`. |
| Want to reset all users/chats | Stop the app, delete `./data/app.db*`, restart. |

---

## 7a. Digest worker (box-side LLM generation)

The daily digest's LLM generation runs **here, on this laptop**, not in the
Vercel function. A realistic day's briefing takes minutes on this box's GPU —
past what a serverless function can hold open — so `POST /api/digest/run`
(called by the Google Apps Script scraper) and the Vercel cron
(`/api/digest/summarize`) now only enqueue a row in the `digest_runs` table
and return instantly. This worker polls that table, generates locally against
`http://localhost:11434` with no deadline, and writes the result straight to
the same Turso database the Next app reads from.

### Setup

```bash
git pull
npm ci   # picks up @libsql/client if not already installed

# Uses the SAME .env.local as the app (needs TURSO_DATABASE_URL,
# TURSO_AUTH_TOKEN, OLLAMA_MODEL; DIGEST_CONTEXT_WINDOW and
# DIGEST_WORKER_POLL_SECONDS are optional, see scripts/digest-worker.mjs).
# OLLAMA_LOCAL_URL/OLLAMA_AUTH_TOKEN are only needed if this worker runs
# somewhere other than the Ollama box itself — normally it talks straight to
# http://127.0.0.1:11434 with no auth.
sudo cp scripts/bleep-digest-worker.service /etc/systemd/system/
# Edit WorkingDirectory/EnvironmentFile in that file if this repo isn't at
# /home/<user>/bleep-ai-chat.
sudo systemctl daemon-reload
sudo systemctl enable --now bleep-digest-worker
journalctl -u bleep-digest-worker -f   # watch it pick up the next run
```

### Keeping the model always resident

`warm-ollama.sh`'s timer pins `OLLAMA_MODEL` in GPU memory with
`keep_alive: -1` so there's no cold-start on the worker's first request. It
now also pins with `num_ctx` matching `DIGEST_CONTEXT_WINDOW` (default 8192)
— if these two ever drift apart, Ollama silently reloads the model on every
digest run (~15s tax). Keep them equal.

This GPU has room for exactly one 3B-class model fully-plus-offloaded at
`num_gpu=24` — a second model resident alongside it (e.g. left over from
testing a smaller one) steals VRAM from the one you actually want fast.
`warm-ollama.sh` now unloads any resident model that isn't in
`OLLAMA_MODELS`/`OLLAMA_MODEL` on every tick, so this self-corrects within
one warm cycle even if something else loads a model in the meantime.

### Failure visibility

Each `digest_runs` row has a `status` (`pending` → `processing` → `done` /
`failed`) and an `error` column. A worker that dies mid-generation leaves its
row `processing`; the next poll cycle requeues anything stuck for more than
`DIGEST_WORKER_STALE_MS` (default 30 min) back to `pending` automatically.

## 7b. Security notes
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Passwords are bcrypt-hashed (never stored in plaintext) and must be ≥ 10 characters.
- Login is limited to 10 failed attempts per username and 20 per IP per 15 minutes;
  signup is limited to 3 per IP per hour. Limits live in the app database, so they
  persist across Vercel cold starts. Tune with `LOGIN_MAX_ATTEMPTS` / `SIGNUP_MAX_PER_IP`.
- `/api/warm` and `/api/health` are locked behind `HEALTH_CHECK_SECRET` once set
  (recommended for any public deployment). 
- `src/proxy.ts` is an *optimistic* gate (checks cookie presence); the real
  verification happens server-side in each route handler / server component.
- Keep `.env.local` out of git (already git-ignored).
