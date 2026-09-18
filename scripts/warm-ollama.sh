#!/usr/bin/env bash
# warm-ollama.sh - Pre-loads every configured Ollama model and pins each in
# memory (keep_alive=-1). Safe to run repeatedly; used by ollama-warm.service
# on boot and on a timer.
set -euo pipefail

BASE_URL="${OLLAMA_WARM_URL:-http://localhost:11434}"
# Comma-separated list (OLLAMA_MODELS), falling back to a single OLLAMA_MODEL.
MODELS="${OLLAMA_MODELS:-${OLLAMA_MODEL:-qwen2.5:3b}}"

# Only one warm-up at a time (boot service and the 5-min timer can overlap).
LOCK_FILE="/tmp/bleep-warm-ollama.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another warm-up is already running; skipping"
  exit 0
fi

# Skip if Ollama is not up yet (systemd will retry on the next timer tick).
if ! curl -fsS --connect-timeout 5 --max-time 10 "${BASE_URL}/api/tags" >/dev/null 2>&1; then
  echo "Ollama not reachable at ${BASE_URL}; skipping warm-up"
  exit 0
fi

IFS=',' read -ra MODEL_LIST <<< "$MODELS"
for MODEL in "${MODEL_LIST[@]}"; do
  MODEL="$(printf '%s' "$MODEL" | xargs)"  # trim surrounding whitespace
  [ -n "$MODEL" ] || continue
  echo "Warming ${MODEL} via ${BASE_URL}..."
  if body="$(curl -fsS --connect-timeout 5 --max-time 600 -X POST "${BASE_URL}/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${MODEL}\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1}}" \
    2>&1)"; then
    echo "Warmed ${MODEL}"
  else
    # Log the failure (with Ollama's reply when available) instead of dying:
    # a model that is mid-reload or out of VRAM often succeeds on the next tick.
    echo "WARN warm failed for ${MODEL}: ${body:-unreachable}" >&2
  fi
done

echo "Warm-up complete"
