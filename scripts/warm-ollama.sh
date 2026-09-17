#!/usr/bin/env bash
# warm-ollama.sh - Pre-loads the Ollama model and pins it in memory (keep_alive=-1).
# Safe to run repeatedly; used by ollama-warm.service on boot and on a timer.
set -euo pipefail

BASE_URL="${OLLAMA_WARM_URL:-http://localhost:11434}"
MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"

# Skip if Ollama is not up yet (systemd will retry on the next timer tick).
if ! curl -fsS --max-time 5 "${BASE_URL}/api/tags" >/dev/null 2>&1; then
  echo "Ollama not reachable at ${BASE_URL}; skipping warm-up"
  exit 0
fi

echo "Warming ${MODEL} via ${BASE_URL}..."
curl -fsS --max-time 600 -X POST "${BASE_URL}/api/generate" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1}}" \
  >/dev/null

echo "Warm-up complete"
