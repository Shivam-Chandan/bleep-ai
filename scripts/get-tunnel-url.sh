#!/usr/bin/env bash
# get-tunnel-url.sh - Prints the current Cloudflare quick-tunnel URL.
# Usage: get-tunnel-url.sh [ollama|app]   (default: ollama)
# Reads cloudflared's local metrics endpoint, falling back to its systemd journal.
set -euo pipefail

TUNNEL="${1:-ollama}"

case "$TUNNEL" in
  ollama)
    METRICS_URL="${CLOUDFLARED_METRICS_URL:-http://127.0.0.1:20241/metrics}"
    TUNNEL_SERVICE="${CLOUDFLARED_SERVICE:-cloudflared-ollama}"
    ;;
  app)
    METRICS_URL="${CLOUDFLARED_APP_METRICS_URL:-http://127.0.0.1:20242/metrics}"
    TUNNEL_SERVICE="${CLOUDFLARED_APP_SERVICE:-cloudflared-app}"
    ;;
  *)
    echo "Unknown tunnel: $TUNNEL (expected: ollama|app)" >&2
    exit 2
    ;;
esac

url="$(curl -fsS --max-time 3 "$METRICS_URL" 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"

# Fallback: the live metrics may be empty while a freshly-restarted tunnel is
# still registering. Only trust the journal if the newest relevant line is an
# actual registration success — a dead tunnel's stale URL must not be re-pushed.
if [ -z "$url" ]; then
  log="$(journalctl -u "$TUNNEL_SERVICE" --no-pager -n 400 2>/dev/null || true)"
  if printf '%s' "$log" | grep -E 'Registered tunnel connection|quick Tunnel has been created' | tail -1 \
      | grep -qE 'Registered tunnel connection|quick Tunnel has been created'; then
    url="$(printf '%s' "$log" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
  fi
fi

printf '%s' "$url"