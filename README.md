# Bleep AI - Local LLM Chat Application

A Next.js chat application that connects to a locally running Llama model via Ollama, deployable to Vercel.

## Architecture

```
┌─────────────┐     HTTPS      ┌──────────────────┐     localhost     ┌─────────┐
│   Vercel    │ ─────────────► │ Cloudflare Tunnel │ ───────────────► │  Ollama │
│  (Frontend) │                │   (Free, Secure) │                   │ (Local) │
└─────────────┘                └──────────────────┘                   └─────────┘
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

3. **Cloudflare Tunnel** (for production/Vercel deployment) - free, no account needed

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

## Production Deployment (Vercel + Cloudflare Tunnel)

### 1. Set up Cloudflare Tunnel

Run the setup script (creates a free, secure tunnel):

```bash
./scripts/setup-tunnel.sh
```

This will output a URL like: `https://random-name.trycloudflare.com`

### 2. Configure Vercel Environment Variables

In your Vercel project settings, add:

```
OLLAMA_BASE_URL=https://your-tunnel-url.trycloudflare.com
OLLAMA_MODEL=qwen2.5:3b
```

### 3. Deploy to Vercel

```bash
# Push to GitHub, then import in Vercel
# Or deploy directly:
vercel --prod
```

### 4. Keep Tunnel Running

For production, run the tunnel as a background service:

```bash
# Option 1: Keep terminal open
cloudflared tunnel --url http://localhost:11434

# Option 2: Run as service (Linux/macOS)
nohup cloudflared tunnel --url http://localhost:11434 > tunnel.log 2>&1 &

# Option 3: Docker (recommended for servers)
docker run -d --name cloudflare-tunnel --network host cloudflare/cloudflared tunnel --url http://localhost:11434
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
│   └── setup-tunnel.sh            # Cloudflare tunnel setup
├── .env.example                   # Environment template
└── .env.local                     # Local config (gitignored)
```

## Features

- 💬 **Real-time streaming** responses from Llama
- 🌐 **Web-access agent** — the model can call a free `web_search` tool (DuckDuckGo) when a question needs current information, then cite its sources
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

When you send a message, the server first asks the model whether the question needs
live web data. If so, it runs a free DuckDuckGo search (no API key), feeds the top
results back to the model, and streams an answer that cites its sources. Simple
questions (greetings, arithmetic, general knowledge) are answered directly without
a search.

- **Model support:** tool calling works with Ollama's `qwen2.5` family and with
  OpenRouter's free router (`openrouter/free` automatically picks a tool-capable
  free model). If a model doesn't support tools, the agent falls back to
  search-then-answer automatically.
- **Response length:** a lightweight heuristic detects whether the question is
  basic, standard, or complex and sets the matching token cap
  (`150` / `600` / `2000`).
- **Context window:** each model advertises a context size
  (`OLLAMA_CONTEXT_WINDOW`, default `8192`; `OPENROUTER_CONTEXT_WINDOW`, default
  `32768`). Older turns are dropped so the prompt and the reply fit, and the
  answer cap shrinks automatically as the window fills. The ring by the model
  picker shows an estimate of how much of the window the current chat uses.
- **Stopping:** press the stop button while a reply streams to abort the model.
  The tokens already produced are saved with a `[Response stopped by user]`
  marker instead of being lost.
- **Tuning:** `SEARCH_MAX_RESULTS` (default `5`) controls how many results are injected.

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
- Verify tunnel URL is accessible: `curl https://your-tunnel.trycloudflare.com/api/tags`

### CORS Errors
The API proxy handles CORS - Vercel functions can access the tunnel URL.

### Model Not Found
Pull the model locally first: `ollama pull qwen2.5:3b`

### Streaming Not Working
Ensure `OLLAMA_BASE_URL` points to the tunnel URL (not localhost) in Vercel.

## License

MIT