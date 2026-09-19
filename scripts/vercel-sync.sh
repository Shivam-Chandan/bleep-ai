#!/usr/bin/env bash
# vercel-sync.sh - Push local Ollama env vars to a Vercel project and redeploy.
#
# Reads OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_AUTH_TOKEN, APP_BASE_URL,
# TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and SESSION_SECRET from .env.local and
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
KEYS=(OLLAMA_BASE_URL OLLAMA_MODEL OLLAMA_MODELS OLLAMA_AUTH_TOKEN OLLAMA_CONTEXT_WINDOW APP_BASE_URL TURSO_DATABASE_URL TURSO_AUTH_TOKEN SESSION_SECRET HEALTH_CHECK_SECRET)
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

team_query=""
[ -n "${VERCEL_TEAM_ID:-}" ] && team_query="teamId=${VERCEL_TEAM_ID}"
query="upsert=true"
[ -n "$team_query" ] && query="${query}&${team_query}"

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
      echo "Triggered redeploy via deploy hook (HTTP ${code})"
    fi
  elif [ -n "${VERCEL_GIT_REPO_ID:-}" ]; then
    if $DRY_RUN; then
      echo "[dry-run] would redeploy production from github ${VERCEL_GIT_REF:-main} (repoId ${VERCEL_GIT_REPO_ID})"
    else
      code="$(curl -s -o /tmp/vercel-deploy-response.json -w '%{http_code}' -X POST \
        "${API_BASE}/v13/deployments?${team_query}&forceNew=1" \
        -H "Authorization: Bearer ${VERCEL_TOKEN}" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"${VERCEL_PROJECT}\",\"target\":\"production\",\"gitSource\":{\"type\":\"github\",\"ref\":\"${VERCEL_GIT_REF:-main}\",\"repoId\":${VERCEL_GIT_REPO_ID}}}")"
      echo "Triggered redeploy via git source (HTTP ${code}): $(cat /tmp/vercel-deploy-response.json 2>/dev/null)"
    fi
  else
    echo "No VERCEL_DEPLOY_HOOK_URL or VERCEL_GIT_REPO_ID set; redeploy manually for env changes to apply"
  fi
fi
