#!/usr/bin/env bash
# sync-tunnel-url.sh - Detects the current quick-tunnel URL and, when it changes:
#   1. writes it to .env.local
#   2. upserts the Vercel OLLAMA_BASE_URL env var (needs VERCEL_TOKEN / VERCEL_PROJECT)
#   3. triggers a redeploy via a Vercel Deploy Hook (needs VERCEL_DEPLOY_HOOK_URL)
#
# Optional config (secrets, kept out of the repo):
#   ~/.config/bleep-ai/tunnel-sync.env
#     VERCEL_TOKEN=...
#     VERCEL_PROJECT=bleep-ai
#     VERCEL_TEAM_ID=...            # optional, for team scopes
#     VERCEL_DEPLOY_HOOK_URL=...    # Project Settings -> Git -> Deploy Hooks
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
CONFIG_FILE="${TUNNEL_SYNC_CONFIG:-$HOME/.config/bleep-ai/tunnel-sync.env}"

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$CONFIG_FILE"; set +a
fi

URL="$("$REPO_DIR/scripts/get-tunnel-url.sh")"
if [ -z "$URL" ]; then
  echo "Could not determine tunnel URL; skipping"
  exit 0
fi

CURRENT="$(grep -E '^OLLAMA_BASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ "$URL" = "$CURRENT" ]; then
  exit 0
fi

if grep -qE '^OLLAMA_BASE_URL=' "$ENV_FILE" 2>/dev/null; then
  tmp="$(mktemp)"
  sed "s|^OLLAMA_BASE_URL=.*|OLLAMA_BASE_URL=${URL}|" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
else
  printf 'OLLAMA_BASE_URL=%s\n' "$URL" >> "$ENV_FILE"
fi
echo "Updated local OLLAMA_BASE_URL -> $URL"

if [ -n "${VERCEL_TOKEN:-}" ] && [ -n "${VERCEL_PROJECT:-}" ]; then
  "$REPO_DIR/scripts/vercel-sync.sh" || echo "Vercel sync failed" >&2
else
  echo "VERCEL_TOKEN/VERCEL_PROJECT not set; update Vercel manually or run scripts/vercel-sync.sh"
fi
