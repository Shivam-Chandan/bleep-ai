#!/usr/bin/env bash
# sync-tunnel-url.sh - Detects the current quick-tunnel URLs (Ollama + App) and,
# when either changes:
#   1. writes OLLAMA_BASE_URL / APP_BASE_URL to .env.local
#   2. upserts the Vercel OLLAMA_* env vars (needs VERCEL_TOKEN / VERCEL_PROJECT)
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

# A dead quick-tunnel registration ("Unauthorized: Tunnel not found") never
# recovers by itself — restore it FIRST so the URLs below are fresh, otherwise
# this script would keep syncing a dead URL and never notice.
"$REPO_DIR/scripts/tunnel-watchdog.sh" || true

# Tunnel name -> env key to keep in sync.
declare -A TUNNELS=(
  [ollama]=OLLAMA_BASE_URL
  [app]=APP_BASE_URL
)

changed=false

for tunnel in "${!TUNNELS[@]}"; do
  key="${TUNNELS[$tunnel]}"
  url="$("$REPO_DIR/scripts/get-tunnel-url.sh" "$tunnel")"

  if [ -z "$url" ]; then
    echo "Could not determine ${tunnel} tunnel URL; skipping ${key}"
    continue
  fi

  current="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ "$url" = "$current" ]; then
    echo "${key} unchanged (${url})"
    continue
  fi

  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"
    sed "s|^${key}=.*|${key}=${url}|" "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$url" >> "$ENV_FILE"
  fi
  echo "Updated local ${key} -> ${url}"
  changed=true
done

if ! $changed; then
  exit 0
fi

if [ -n "${VERCEL_TOKEN:-}" ] && [ -n "${VERCEL_PROJECT:-}" ]; then
  "$REPO_DIR/scripts/vercel-sync.sh" || echo "Vercel sync failed" >&2
else
  echo "VERCEL_TOKEN/VERCEL_PROJECT not set; update Vercel manually or run scripts/vercel-sync.sh"
fi