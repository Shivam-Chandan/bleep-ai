#!/usr/bin/env bash
# check-health.sh - Checks the deployed app's health endpoint.
# Usage: ./scripts/check-health.sh [https://your-app.vercel.app]
set -euo pipefail

BASE_URL="${1:-${APP_BASE_URL:-https://bleep-ai.vercel.app}}"

response="$(curl -s -w '\n%{http_code}' --max-time 20 "${BASE_URL}/api/health")"
code="$(printf '%s' "$response" | tail -1)"
body="$(printf '%s' "$response" | sed '$d')"

echo "HTTP ${code}: ${body}"

if [ "$code" != "200" ] || ! printf '%s' "$body" | grep -q '"status":"ok"'; then
  echo "Health check FAILED" >&2
  exit 1
fi

echo "Health check OK"
