#!/usr/bin/env bash
# check-health.sh - Checks the deployed app's health endpoint.
# Usage: ./scripts/check-health.sh [https://your-app.vercel.app]
set -euo pipefail

BASE_URL="${1:-${APP_BASE_URL:-https://bleep-ai.vercel.app}}"

# /api/health is gated behind HEALTH_CHECK_SECRET in production; pass it via env
# (e.g. HEALTH_CHECK_SECRET=... ./scripts/check-health.sh) or HEADER_NAME/HEADER_VALUE.
HEADER="${HEALTH_SECRET_HEADER:-authorization}"
HEADER_VALUE="${HEALTH_CHECK_SECRET:+Bearer ${HEALTH_CHECK_SECRET}}"
if [ -n "${HEALTH_HEADER_VALUE:-}" ]; then
  HEADER_VALUE="$HEALTH_HEADER_VALUE"
fi

args=(-s -H "$HEADER:$HEADER_VALUE" -w '\n%{http_code}' --max-time 20)
[ -z "$HEADER_VALUE" ] && args=(-s -w '\n%{http_code}' --max-time 20)

response="$(curl "${args[@]}" "${BASE_URL}/api/health")"
code="$(printf '%s' "$response" | tail -1)"
body="$(printf '%s' "$response" | sed '$d')"

echo "HTTP ${code}: ${body}"

if [ "$code" != "200" ] || ! printf '%s' "$body" | grep -q '"status":"ok"'; then
  echo "Health check FAILED" >&2
  exit 1
fi

echo "Health check OK"
