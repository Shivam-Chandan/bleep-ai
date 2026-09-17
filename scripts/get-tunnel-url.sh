#!/usr/bin/env bash
# get-tunnel-url.sh - Prints the current Cloudflare quick-tunnel URL.
# Reads cloudflared's local metrics endpoint, falling back to its systemd journal.
set -euo pipefail

METRICS_URL="${CLOUDFLARED_METRICS_URL:-http://127.0.0.1:20241/metrics}"
TUNNEL_SERVICE="${CLOUDFLARED_SERVICE:-cloudflared-ollama}"

url="$(curl -fsS --max-time 3 "$METRICS_URL" 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"

if [ -z "$url" ]; then
  url="$(journalctl -u "$TUNNEL_SERVICE" --no-pager -n 300 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
fi

printf '%s' "$url"
