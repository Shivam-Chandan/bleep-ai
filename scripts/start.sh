#!/usr/bin/env bash
# Start the standalone Next.js server, loading runtime secrets from .env.local
# WITHOUT logging or exposing their values. Secrets stay in .env.local only
# (never duplicated into pm2's stored environment).
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec node .next/standalone/server.js "$@"