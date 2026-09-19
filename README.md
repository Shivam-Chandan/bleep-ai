# Bleep AI - Local LLM Chat Application

A Next.js chat application that connects to a locally running Llama model via Ollama, deployable to Vercel.

## Architecture

```
┌─────────────┐     HTTPS      ┌───────────────────────┐   localhost    ┌─────────┐
│   Vercel    │ ─────────────► │ Tailscale Funnel      │ ─────────────► │  Ollama │
│  (Frontend) │                │  (ts.net, permanent)  │                │ (Local) │
└─────────────┘                └───────────────────────┘                └─────────┘
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
sudo tailscale funnel --bg 11435
```

This prints the permanent URL, e.g.:

```
https://bleep-ai.tailc327c1.ts.net   →   proxy http://127.0.0.1:11435
```

The URL stays active across reboots (config is stored in Tailscale's state DB
and re-applied by `bleep-funnel.service` on boot). Bearer-token auth still gates
every request — a no-token curl gets `401`.

#### Watchdog: self-healing the Funnel

The Funnel can silently stop serving public traffic (stale control-plane state,
or tailscaled losing its control/DERP path after an interface/gateway change)
while still working from inside the tailnet — prod then fails `/api/health` at
~320ms. `bleep-tailscale-watchdog.timer` (every minute) runs
`scripts/tailscale-watchdog.sh`, which pings prod health and, after 3
consecutive failures (outside a 5-min cooldown), escalates: restart tailscaled →
re-assert the funnel → `tailscale funnel reset` + re-issue if still failing, then
re-checks. State lives in `/tmp/bleep-tailscale-watchdog/`.

### 3. Configure Vercel Environment Variables

In your Vercel project settings, add (one time — the URL never changes):

```
OLLAMA_BASE_URL=https://bleep-ai.tailc327c1.ts.net
OLLAMA_MODEL=qwen2.5:3b
```

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
│   │   ├── layout.tsx             # Root layout
│   │   ├── page.tsx               # Main chat page
│   │   └── globals.css            # Tailwind + theme
│   ├── components/
│   │   ├── ChatLayout.tsx         # Main layout (sidebar + chat)
│   │   ├── ChatSidebar.tsx        # Chat history sidebar
│   │   └── ChatWindow.tsx         # Chat interface with streaming
│   └── lib/
│       ├── agent.ts               # Tool-calling loop + adaptive verbosity
│       ├── search.ts              # Free DuckDuckGo web search
│       ├── store.ts               # Zustand state management
│       └── types.ts               # TypeScript types
├── scripts/
│   ├── setup-tunnel.sh            # Tailscale funnel setup
│   ├── tunnel-watchdog.sh         # Cloudflare quick-tunnel watchdog
│   └── tailscale-watchdog.sh      # Restarts tailscaled/funnel when prod health fails
├── .env.example                   # Environment template
└── .env.local                     # Local config (gitignored)
```

## Features

- 💬 **Real-time streaming** responses from Llama
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

## Web-Access Agent

Search is decided per model type so slow local models stay responsive:

- **Local models** run on CPU and are by far the slowest part of the stack, so the
  server uses a fast keyword heuristic (freshness/live-data signals such as
  `latest`, `news`, `today`, `price`, a year, or a URL) to decide whether to
  search. The answer is then streamed in a **single model call** — there is no
  separate non-streaming "decide" round trip, which roughly halves latency.
- **Cloud models** (`openrouter/free`) are fast enough to keep LLM-decided tool
  calling: the model calls a free DuckDuckGo `web_search` tool (no API key) when
  it needs live data, and the grounded answer is streamed back with citations.

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

DuckDuckGo's free HTML endpoint is best-effort: if it is rate-limited or returns
no results, the assistant still answers without web context rather than failing.

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