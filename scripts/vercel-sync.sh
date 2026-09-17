#!/usr/bin/env bash
# vercel-sync.sh - Push local Ollama env vars to a Vercel project and redeploy.
#
# Reads OLLAMA_BASE_URL, OLLAMA_MODEL and OLLAMA_AUTH_TOKEN from .env.local and
# upserts them into the Vercel project's environment via the REST API.
#
# Config (secrets, kept out of the repo): ~/.config/bleep-ai/tunnel-sync.env
#   VERCEL_TOKEN=...              # https://vercel.com/account/tokens
#   VERCEL_PROJECT=bleep-ai
#   VERCEL_TEAM_ID=...            # optional, for team scopes
#   VERCEL_DEPLOY_HOOK_URL=...    # optional; Project -> Settings -> Git
#
# Usage:
#   ./scripts/vercel-sync.sh [--dry-run] [--no-deploy]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
CONFIG_FILE="${TUNNEL_SYNC_CONFIG:-$HOME/.config/bleep-ai/tunnel-sync.env}"
KEYS=(OLLAMA_BASE_URL OLLAMA_MODEL OLLAMA_AUTH_TOKEN)
API_BASE="https://api.vercel.com"

DRY_RUN=false
DEPLOY=true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-deploy) DEPLOY=false ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$CONFIG_FILE"; set +a
fi

VERCEL_PROJECT="${VERCEL_PROJECT:-bleep-ai}"
if ! $DRY_RUN; then
  : "${VERCEL_TOKEN:?VERCEL_TOKEN is required (set it in $CONFIG_FILE)}"
fi

query="upsert=true"
[ -n "${VERCEL_TEAM_ID:-}" ] && query="${query}&teamId=${VERCEL_TEAM_ID}"

upsert() {
  local key="$1" value="$2"

  if $DRY_RUN; then
    echo "[dry-run] would set ${key}=${value:0:10}… on Vercel project ${VERCEL_PROJECT}"
    return 0
  fi

  local code
  code="$(curl -s -o /tmp/vercel-env-response.json -w '%{http_code}' -X POST \
    "${API_BASE}/v10/projects/${VERCEL_PROJECT}/env?${query}" \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"key\":\"${key}\",\"value\":\"${value}\",\"type\":\"encrypted\",\"target\":[\"production\",\"preview\",\"development\"]}")"

  if [ "$code" = "200" ] || [ "$code" = "201" ]; then
    echo "Upserted ${key} (HTTP ${code})"
  else
    echo "Failed to upsert ${key} (HTTP ${code}): $(cat /tmp/vercel-env-response.json 2>/dev/null)" >&2
    return 1
  fi
}

for key in "${KEYS[@]}"; do
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -z "$value" ]; then
    echo "Skipping ${key} (not found in .env.local)"
    continue
  fi
  upsert "$key" "$value"
done

if $DEPLOY; then
  if [ -n "${VERCEL_DEPLOY_HOOK_URL:-}" ]; then
    if $DRY_RUN; then
      echo "[dry-run] would trigger deploy hook"
    else
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$VERCEL_DEPLOY_HOOK_URL")"
      echo "Triggered redeploy (HTTP ${code})"
    fi
  else
    echo "VERCEL_DEPLOY_HOOK_URL not set; redeploy manually for env changes to apply"
  fi
fi
