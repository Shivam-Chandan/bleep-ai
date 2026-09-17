#!/bin/bash
# setup-tunnel.sh - Sets up Cloudflare Tunnel for local Ollama access
# This allows Vercel to communicate with your local Ollama instance

set -e

echo "🌐 Setting up Cloudflare Tunnel for Ollama..."
echo ""

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "📦 Installing cloudflared..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install cloudflare/cloudflare/cloudflared
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux installation
        wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
        sudo dpkg -i cloudflared-linux-amd64.deb
        rm cloudflared-linux-amd64.deb
    else
        echo "❌ Please install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
        exit 1
    fi
fi

# Check if Ollama is running
echo "🔍 Checking if Ollama is running..."
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "⚠️  Ollama doesn't seem to be running on localhost:11434"
    echo "   Please start Ollama first: ollama serve"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "✅ Ollama is running"
    # Check if model is available
    MODEL=$(curl -s http://localhost:11434/api/tags | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$MODEL" ]; then
        echo "📦 Available model: $MODEL"
    else
        echo "⚠️  No models found. Pull a model first: ollama pull llama3.2"
    fi
fi

echo ""
echo "🚀 Starting Cloudflare Tunnel..."
echo "   This will create a public HTTPS URL that forwards to localhost:11434"
echo ""
echo "   Press Ctrl+C to stop the tunnel"
echo ""

# Start the tunnel
cloudflared tunnel --url http://localhost:11434 --no-autoupdate