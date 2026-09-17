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
   ollama pull llama3.2
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
OLLAMA_MODEL=llama3.2
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
│       ├── store.ts               # Zustand state management
│       └── types.ts               # TypeScript types
├── scripts/
│   └── setup-tunnel.sh            # Cloudflare tunnel setup
├── .env.example                   # Environment template
└── .env.local                     # Local config (gitignored)
```

## Features

- 💬 **Real-time streaming** responses from Llama
- 📱 **Responsive design** - works on mobile/desktop
- 🌙 **Dark mode** support (system preference)
- 💾 **Persistent chats** - saved to localStorage
- 🗂️ **Chat history** - create, switch, delete conversations
- ⚡ **Optimistic UI** - instant message display
- 🔒 **Secure** - tunnel encrypts traffic, no exposed ports

## Available Models

Pull any Ollama-compatible model:

```bash
# Popular options
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
Pull the model locally first: `ollama pull llama3.2`

### Streaming Not Working
Ensure `OLLAMA_BASE_URL` points to the tunnel URL (not localhost) in Vercel.

## License

MIT