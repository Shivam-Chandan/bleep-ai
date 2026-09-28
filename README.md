# Bleep AI - Local LLM Chat Application

A Next.js chat application that connects to a locally running Llama model via Ollama, deployable to Vercel. Fully local-first: the database is a local SQLite served by `sqld` on this box over the tailnet.

## Architecture

```
┌─────────────┐     HTTPS      ┌───────────────────────┐   localhost    ┌─────────┐
│   Vercel    │ ─────────────► │ Tailscale Funnel      │ ─────────────► │  Ollama │
│  (Frontend) │                │  (ts.net, permanent)  │                │ (Local) │
└─────────────┘                └───────────────────────┘                └─────────┘
                 \                    │
                  \        ┌─────────┴──────────┐
                   \       │  Funnel /sql ─────►│
                    \      │  sqld (libSQL DB)  │  local SQLite
                     └────►└────────────────────┘  (/var/lib/bleep-sqld)
```

## Prerequisites

1. **Ollama** installed and running locally
   ```bash
   # Install Ollama
   curl -fsSL https://ollama.com/install.sh | sh
   
   # Start Ollama server
   ollama serve
   
   # Pull a model (in another terminal)
   ollama pull qwen2.5:3b
   ```

2. **Node.js 18+** and npm

3. **Tailscale** (for production/Vercel deployment) - free Personal plan, permanent `.ts.net` URL, no request-timeout cap. Optional; skip for local-only use.

## Quick Start (Local Development)

```bash
# Clone and install
cd bleep-ai-chat
npm install

# Copy environment template
cp .env.example .env.local

# Start development server
npm run dev
```

Open http://localhost:3000 - the app will connect to your local Ollama directly.

## Production Deployment (Vercel + Tailscale Funnel)

### 1. Install + log in to Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up          # opens a browser login (free Personal plan is enough)
```

### 2. Expose the auth proxy with Funnel

The app's chat routes authenticate to Ollama behind a Bearer-token proxy on
`127.0.0.1:11435`. Funnel publishes that proxy at a **permanent** `ts.net` URL
(a Tailscale Funnel, free) — unlike a Cloudflare quick-tunnel it never rotates
and has no 100s request cap, so long model loads and streaming replies work
without the watchdog/URL-sync dance:

```bash
sudo tailscale funnel --bg --yes --https=443 --set-path=/ http://127.0.0.1:11435
sudo tailscale funnel --bg --yes --https=443 --set-path=/sql http://100.90.40.69:8080
```

This publishes both routes on the permanent URL:

```
https://bleep-ai.tailc327c1.ts.net        →  proxy http://127.0.0.1:11435
https://bleep-ai.tailc327c1.ts.net/sql/   →  proxy http://100.90.40.69:8080
```

The URLs stay active across reboots (config is stored in Tailscale's state DB
and re-applied by `bleep-funnel.service` on boot). Bearer-token auth still gates
every Ollama request — a no-token curl gets `401` — and sqld requires its JWT.
The `/sql` route is the local sqld/libSQL DB for the Vercel app
(`DATABASE_URL=https://bleep-ai.tailc327c1.ts.net/sql/`, trailing slash
required) and for anything else that can't reach the tailnet IP directly.

#### Watchdog: self-healing the Funnel

The Funnel can silently stop serving public traffic (stale control-plane state,
or tailscaled losing its control/DERP path after an interface/gateway change)
while still working from inside the tailnet. `bleep-tailscale-watchdog.timer`
(every minute) runs `scripts/tailscale-watchdog.sh`, which probes the public
Funnel URL **end-to-end**: `GET https://<funnel>/api/tags` with the auth proxy's
`OLLAMA_AUTH_TOKEN` (the Funnel's `/` route terminates at `ollama-auth-proxy`).
After 3 consecutive failures (outside a 5-min cooldown) it escalates: restart
tailscaled → re-assert the funnel → `tailscale funnel reset` + re-issue if
still failing, then re-checks. State lives in `/tmp/bleep-tailscale-watchdog/`.

(Historically this watchdog sent `HEALTH_CHECK_SECRET` to `/api/health` on the
Funnel URL — that path belongs to the Ollama auth proxy, which rejects it, so it
always 401'd and reboot-looped tailscaled every cooldown period. Keep the probe
on `OLLAMA_AUTH_TOKEN`.)

#### Watchdog: keeping the database up

`sqld` itself gets `Restart=on-failure` from systemd, so hard crashes recover in
~5s. But the DB can still be dead from the app's point of view while the process
looks fine (hung process, missing Funnel `/sql` mount, tailnet IP change, stale
JWT). To cover that, `bleep-db-watchdog.timer` (every 2 minutes + on boot) runs
`scripts/db-watchdog.sh`, which issues a real authenticated `SELECT 1` against
BOTH the box-side URL (digest worker path) and the public `/sql` Funnel URL
(prod app path), with in-tick retries. After 2 consecutive failures it restarts
`bleep-sqld.service` and, if needed, re-asserts the Funnel mount — verifying
prod reachability again after each stage. Health pings never force the schema
batch; state lives in `/tmp/bleep-db-watchdog/`. `/api/health` also reports
`db` and returns `503` when the DB is unreachable.

### 3. Configure Vercel Environment Variables

In your Vercel project settings, add (one time — the URL never changes):

```
OLLAMA_BASE_URL=https://bleep-ai.tailc327c1.ts.net
OLLAMA_MODEL=qwen2.5:3b
DATABASE_URL=https://bleep-ai.tailc327c1.ts.net/sql/
DATABASE_AUTH_TOKEN=<sqld JWT>
ENCRYPTION_KEY=<same value the digest worker uses>
```

Attachment limits have working defaults (3 MB/file, 5 files/chat), so nothing is
required to enable uploads. To change them, add e.g.
`ATTACHMENT_MAX_FILE_BYTES=3145728`, `ATTACHMENT_MAX_FILES=5` or
`ATTACHMENT_MAX_CHARS=40000`.

### 4. Deploy to Vercel

```bash
# Push to GitHub, then import in Vercel
# Or deploy directly:
vercel --prod
```

## Project Structure

```
bleep-ai-chat/
├── src/
│   ├── app/
│   │   ├── api/chat/route.ts      # Ollama API proxy (streaming)
│   │   ├── api/attachments/route.ts # Upload/extract, list, preview, delete
│   │   ├── layout.tsx             # Root layout
│   │   ├── page.tsx               # Main chat page
│   │   └── globals.css            # Tailwind + theme
│   ├── components/
│   │   ├── ChatLayout.tsx         # Main layout (sidebar + chat)
│   │   ├── ChatSidebar.tsx        # Chat history sidebar
│   │   ├── ChatWindow.tsx         # Chat interface with streaming
│   │   ├── AttachmentPicker.tsx   # Paperclip, upload state, composer chips
│   │   ├── AttachmentChip.tsx     # File chip + expandable text preview
│   └── lib/
│       ├── agent.ts               # Tool-calling loop + adaptive verbosity
│       ├── extract.ts             # PDF/DOCX/PPTX text extraction (server-only)
│       ├── attachments.ts         # Upload limits + validation (client-safe)
│       ├── search.ts              # Free DuckDuckGo web search
│       ├── store.ts               # Zustand state management
│       └── types.ts               # TypeScript types
├── scripts/
│   ├── setup-tunnel.sh            # Tailscale funnel setup
│   ├── tunnel-watchdog.sh         # Cloudflare quick-tunnel watchdog
│   ├── tailscale-watchdog.sh      # Restarts tailscaled/funnel when prod health fails
│   └── db-watchdog.sh             # Keeps sqld up + the prod /sql funnel reachable
├── .env.example                   # Environment template
└── .env.local                     # Local config (gitignored)
```

## Features

- 💬 **Real-time streaming** responses from Llama
- 📎 **Document attachments** — attach a PDF, Word doc or PowerPoint deck and the text is extracted server-side and used to ground the answer
- 🌐 **Web-access agent** — searches (DuckDuckGo, no API key) when a question needs current information, then streams a grounded answer that cites its sources
- ✂️ **Adaptive response length** — short answers for basic queries, detailed ones only when the question needs it
- 🧠 **Context-aware** — history is trimmed to the selected model's context window, with a live usage ring next to the model picker
- ⏹️ **Stop generation** — the send button becomes a stop button mid-answer; the partial reply is kept and marked as interrupted
- 🧵 **Concurrent chats** — an in-flight answer in one chat never blocks sending in another
- 📱 **Responsive design** - works on mobile/desktop
- 🌙 **Dark mode** support (system preference)
- 💾 **Persistent chats** - saved to localStorage
- 🗂️ **Chat history** - create, switch, delete conversations
- ⚡ **Optimistic UI** - instant message display
- 🔒 **Secure** - tunnel encrypts traffic, no exposed ports
- 🔐 **Encrypted at rest** - chats, messages, digest data, usernames, attachment text and prompts are AES-256-GCM encrypted in the database

## File Attachments

The paperclip beside the composer takes **modern** `.pdf`, `.docx` and `.pptx`
files (plus the `.docm`/`.dotx`/`.pptm`/`.potx`/`.ppsx` variants) — up to 5 per
chat, 3 MB each. Files can also be dropped onto the composer.

How it works:

1. The browser base64-encodes the file and `POST`s it to `/api/attachments`.
2. The server extracts the text (`unpdf` for PDF, JSZip + XML for Office Open
   XML) and stores **only that text**, encrypted at rest alongside the rest of
   the DB. The original file is never written to disk or the database.
3. The text is capped at 40,000 characters per file and is trimmed further to
   fit the selected model's context window. A file that got clipped is marked
   **Partial** in the UI, so a truncated file can never quietly ground an answer
   in half a document.
4. On send, the files are bound to that user turn. They stay available as
   context for every later message in the chat, so follow-up questions like
   "and what about page 3?" work without re-uploading.

Click a chip to see the exact text the model is reading. That matters: extraction
is lossy for scanned PDFs (no OCR — an image-only scan yields nothing and is
rejected) and for slide decks that are mostly text boxes or images.

Legacy binary `.doc`/`.ppt` cannot be parsed and are rejected with a message
telling you to re-save as `.docx`/`.pptx`.

Limits are configurable via `ATTACHMENT_MAX_FILE_BYTES`, `ATTACHMENT_MAX_FILES`,
`ATTACHMENT_MAX_REQUEST_BYTES` and `ATTACHMENT_MAX_CHARS` (see `.env.example`).
The 3 MB default is deliberate: uploads travel as base64 in a JSON body, which
inflates by ~33%, against Vercel's 4.5 MB request-body limit. Going larger needs
direct-to-storage uploads.

## Web-Access Agent

Search is decided per model type so slow local models stay responsive:

- **Local models** run on CPU and are by far the slowest part of the stack, so the
  server uses a fast keyword heuristic (freshness/live-data signals such as
  `latest`, `news`, `today`, `price`, a year, or a URL) to decide whether to
  search. The answer is then streamed in a **single model call** — there is no
  separate non-streaming "decide" round trip, which roughly halves latency.
- **Cloud models** (`openrouter/free`) are fast enough to keep LLM-decided tool
  calling: the model calls a free `web_search` tool (no API key) when it needs
  live data, and the grounded answer is streamed back with citations.

The search itself is plain-HTTP from the server (no API key, no headless
browser): **Bing** by default, falling back to **DuckDuckGo**'s HTML endpoint
when Bing fails or returns no results. Set `SEARCH_PROVIDER=bing|ddg` to pin a
single provider, or leave it at `auto` (default). Startpage/Google are not
used: Google requires JavaScript to render its SERP and Startpage sits behind
an anti-bot proof-of-work wall, so both would need a browser on the box.

Simple questions (greetings, arithmetic, general knowledge) are answered directly
without a search. Tools never block the stream: local answers start streaming
immediately, and cloud falls back to search-then-answer if a model doesn't
support tools.

- **Response length:** a lightweight heuristic detects whether the question is
  basic, standard, or complex and sets the matching token cap
  (`150` / `600` / `2000`). Local answers are capped at `OLLAMA_MAX_TOKENS`
  (default `512`) because a CPU-only model can otherwise spend 20+ minutes on a
  single reply.
- **Context window:** each model advertises a context size
  (`OLLAMA_CONTEXT_WINDOW`, default `4096`; `OPENROUTER_CONTEXT_WINDOW`, default
  `32768`). Older turns are dropped so the prompt and the reply fit, and the
  answer cap shrinks automatically as the window fills. The ring by the model
  picker shows an estimate of how much of the window the current chat uses.
- **Stopping:** press the stop button while a reply streams to abort the model.
  The tokens already produced are saved with a `[Response stopped by user]`
  marker instead of being lost.
- **Tuning:** `SEARCH_MAX_RESULTS` (default `5`) controls how many results are injected,
  and `OLLAMA_MAX_TOKENS` caps the length of local replies.

The free HTML endpoints are best-effort: if a provider is rate-limited or
returns no results, the server falls back to the next provider (Bing → DDG) and
otherwise answers without web context rather than failing.

## Data encryption (at rest)

Everything sensitive is encrypted **before** it is written to the database, so a
stolen SQLite file or a Turso dump reveals only opaque ciphertext. This covers
chat titles, message bodies, digest payloads (emails, calendar events, Slack
messages, Zoom recaps), daily summaries, ingest-token labels, usernames,
attachment filenames and extracted file text, and rate-limit keys. Structural columns (row ids, `user_id`, timestamps, `source`,
`day`, `status`) stay in the clear so indexes and joins keep working; they expose
ordering and counts, not content.

- Algorithm: AES-256-GCM (authenticated). Random IVs for free text, and a
  key-derived IV for values that must stay equality-searchable (usernames,
  external ids, rate-limit keys).
- Key: `ENCRYPTION_KEY` (32 bytes, base64 or hex). When unset, a key is derived
  from `SESSION_SECRET` for dev. **Set a dedicated `ENCRYPTION_KEY` and use the
  exact same value for the Vercel app and the box-side `digest-worker`.** Never
  change it once data exists, or that data becomes unreadable.
- Shared implementation: `src/lib/crypto.mjs`, used by the app
  (`src/lib/queries.ts`, `src/lib/rateLimit.ts`) and by
  `scripts/digest-worker.mjs`.

Migrating existing plaintext rows (back up first):

```bash
node --env-file=.env.local scripts/encrypt-existing-data.mjs --dry-run
node --env-file=.env.local scripts/encrypt-existing-data.mjs
```

Trust boundary: the server must decrypt data to send it to the model and back to
the browser, so this protects data **at rest** (database/backups), not a
compromised running server. There are no server-readable files stored on disk
outside the database; uploads/payloads live in encrypted DB columns.

## Available Models

Pull any Ollama-compatible model:

```bash
# Popular options
ollama pull qwen2.5:3b      # 3B params, fast (current default)
ollama pull llama3.2        # 3B params, fast
ollama pull llama3.1        # 8B params, better quality
ollama pull mistral         # 7B params, good balance
ollama pull codellama       # Code-specialized
ollama pull phi3            # Microsoft's small model
```

Update `OLLAMA_MODEL` in `.env.local` or Vercel env vars to switch models.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST   | `/api/chat` | Send messages, get streaming response |
| GET    | `/api/chat` | List available Ollama models |
| POST   | `/api/attachments` | Upload one or more documents (base64 JSON), extract text |
| GET    | `/api/attachments?chatId=` | List a chat's attachments (metadata only) |
| GET    | `/api/attachments?id=` | Read one attachment's extracted text (preview) |
| DELETE | `/api/attachments` | Delete one attachment by id |

## Troubleshooting

### "Failed to connect to Ollama"
- Ensure Ollama is running: `ollama serve`
- Check if model exists: `ollama list`
- Verify Funnel URL is accessible: `curl https://bleep-ai.tailc327c1.ts.net/api/tags`

### CORS Errors
The API proxy handles CORS - Vercel functions can access the tunnel URL.

### Model Not Found
Pull the model locally first: `ollama pull qwen2.5:3b`

### Streaming Not Working
Ensure `OLLAMA_BASE_URL` points to the tunnel URL (not localhost) in Vercel.

## License

MIT