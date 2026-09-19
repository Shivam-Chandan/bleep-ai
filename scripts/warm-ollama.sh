#!/usr/bin/env bash
# warm-ollama.sh - Pre-loads every configured Ollama model and pins each in
# memory (keep_alive=-1). Safe to run repeatedly; used by ollama-warm.service
# on boot and on a timer.
#
# num_ctx here MUST match DIGEST_CONTEXT_WINDOW (what the digest worker,
# scripts/digest-worker.mjs, requests) — a mismatch forces Ollama to reload
# the model on every digest run (measured ~15-16s). Pinning the same context
# here means the worker never pays that cost.
#
# This GPU has room for exactly one 3B-class model at num_gpu=24 (measured:
# fully offloading a 3B model OOMs; a second model resident alongside it
# forces a worse split on both). So after warming the configured MODELS list,
# this also unloads any OTHER model Ollama is currently holding in memory —
# otherwise a stray model (e.g. left resident from manual testing) silently
# steals VRAM from the one that's supposed to have it.
set -euo pipefail

BASE_URL="${OLLAMA_WARM_URL:-http://localhost:11434}"
# Comma-separated list (OLLAMA_MODELS), falling back to a single OLLAMA_MODEL.
MODELS="${OLLAMA_MODELS:-${OLLAMA_MODEL:-qwen2.5:3b}}"
NUM_CTX="${DIGEST_CONTEXT_WINDOW:-8192}"
# Physical-core count so the warm call doesn't spin up 4 logical threads on
# this 2C/4T box (see src/lib/ollama.ts / digestCore.mjs for the same default).
NUM_THREAD="${OLLAMA_NUM_THREAD:-2}"

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
  echo "Warming ${MODEL} via ${BASE_URL} (num_ctx=${NUM_CTX}, num_thread=${NUM_THREAD})..."
  if body="$(curl -fsS --connect-timeout 5 --max-time 600 -X POST "${BASE_URL}/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${MODEL}\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1,\"num_gpu\":24,\"num_ctx\":${NUM_CTX},\"num_thread\":${NUM_THREAD}}}" \
    2>&1)"; then
    echo "Warmed ${MODEL}"
  else
    # Log the failure (with Ollama's reply when available) instead of dying:
    # a model that is mid-reload or out of VRAM often succeeds on the next tick.
    echo "WARN warm failed for ${MODEL}: ${body:-unreachable}" >&2
  fi
done

# Unload any resident model that isn't in MODELS — it's not supposed to be
# here, and on a GPU this small it directly steals VRAM/offload from the
# model that is (Node is already a hard dependency of this app; use it for
# the JSON handling rather than adding a jq dependency to this script).
node -e '
  const base = process.argv[1];
  const wanted = new Set(process.argv[2].split(",").map((s) => s.trim()).filter(Boolean));
  fetch(`${base}/api/ps`)
    .then((r) => r.json())
    .then(async (data) => {
      for (const m of data.models || []) {
        if (wanted.has(m.name)) continue;
        console.log(`Unloading stray resident model: ${m.name}`);
        await fetch(`${base}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: m.name, keep_alive: 0 }),
        }).catch((e) => console.error(`WARN unload failed for ${m.name}: ${e.message}`));
      }
    })
    .catch((e) => console.error(`WARN could not check /api/ps: ${e.message}`));
' "$BASE_URL" "$MODELS"

echo "Warm-up complete"
