#!/usr/bin/env bash
# tailscale-watchdog.sh - Restores prod -> Funnel -> Ollama reachability when it
# breaks. The Tailscale Funnel fails in two known ways, both of which surface as
# the Funnel no longer answering Ollama from the public URL (while it may still
# answer from inside the tailnet):
#   1. Stale control-plane/funnel state (TLS-ALPN-01 regression era) - fixed by
#      `tailscale funnel reset` + re-issue.
#   2. tailscaled loses its control/DERP path (e.g. an interface/gateway dies and
#      tailscaled keeps sockets bound to it), leaving the Funnel ingress stale -
#      fixed by restarting tailscaled.
#
# Runs from bleep-tailscale-watchdog.timer. A state file counts consecutive
# failures so a single blip doesn't restart the network stack, and a cooldown
# prevents restart loops during prolonged outages.
#
# Health = an authenticated probe THROUGH the Funnel: GET https://<funnel>/api/tags
# with the proxy's OLLAMA_AUTH_TOKEN. The Funnel's `/` route terminates at the
# Ollama auth proxy (`ollama-auth-proxy.mjs`), which requires exactly that Bearer
# token - NOT HEALTH_CHECK_SECRET. (The old probe sent HEALTH_CHECK_SECRET there
# and got an eternal 401, which drove continuous tailscaled restarts and, through
# the network flapping they caused, false "DB down" alarms - see db-watchdog.sh.)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

STATE_DIR="${TAILSCALE_WATCHDOG_STATE:-/tmp/bleep-tailscale-watchdog}"
NEED_FAILS="${TAILSCALE_WATCHDOG_FAILS:-3}"
COOLDOWN_SECS="${TAILSCALE_WATCHDOG_COOLDOWN:-300}"
WAIT_TICKS="${TAILSCALE_WATCHDOG_WAIT_TICKS:-24}"   # ~72s max for tailscaled to come up

# Import OLLAMA_AUTH_TOKEN / APP_BASE_URL without echoing values.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -z "${OLLAMA_AUTH_TOKEN:-}" ]; then
  echo "watchdog: OLLAMA_AUTH_TOKEN missing from $ENV_FILE; skipping (cannot verify the Funnel's auth proxy)"
  exit 0
fi

FUNNEL_URL="${TAILSCALE_WATCHDOG_FUNNEL_URL:-}"
if [ -z "$FUNNEL_URL" ]; then
  # Buffer fully before parsing: grepping/sedding the pipe directly would SIGPIPE
  # tailscale once the reader exits after the first match (and, under
  # `set -o pipefail`, kill this script with 141).
  funnel_status="$(tailscale funnel status 2>/dev/null || true)"
  FUNNEL_URL="$(printf '%s\n' "$funnel_status" | grep -F '(Funnel on)' | head -n1 | sed -E 's#^(https?://[^ ]+).*#\1#')"
fi
if [ -z "$FUNNEL_URL" ]; then
  echo "watchdog: could not resolve the Funnel URL from 'tailscale funnel status'; skipping"
  exit 0
fi

command_exists() { command -v "$1" >/dev/null 2>&1; }

tailscale_cmd() {
  if [ "$(id -u)" = "0" ]; then
    tailscale "$@"
  else
    sudo tailscale "$@"
  fi
}

restart_tailscaled() {
  if [ "$(id -u)" = "0" ]; then
    systemctl restart tailscaled
  else
    sudo systemctl restart tailscaled
  fi
}

# End-to-end Funnel health: the public URL must answer the Ollama API with the
# shared proxy token (also proves token validity, not just the socket).
is_healthy() {
  local body
  body="$(curl -fsS --max-time 15 -H "Authorization: Bearer ${OLLAMA_AUTH_TOKEN}" \
    "${FUNNEL_URL%/}/api/tags" 2>/dev/null || true)"
  [ -n "$body" ]
}

# tailscaled is up once status no longer marks the node offline.
wait_tailscaled() {
  local i line
  for i in $(seq 1 "$WAIT_TICKS"); do
    line="$(tailscale_cmd status 2>/dev/null | head -1 || true)"
    if [ -n "$line" ] && ! printf '%s' "$line" | grep -q " offline"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

funnel_apply() {
  if [ -x /usr/local/sbin/bleep-funnel-apply.sh ]; then
    /usr/local/sbin/bleep-funnel-apply.sh >/dev/null 2>&1 || true
  else
    tailscale_cmd funnel status 2>/dev/null | grep -q "Funnel on\|proxy http://127.0.0.1:11435" ||
      tailscale_cmd funnel --bg 11435 >/dev/null 2>&1 || true
  fi
}

# Repair ladder: cheapest, least disruptive first; re-check after each stage.
repair() {
  echo "watchdog: restarting tailscaled"
  restart_tailscaled || true
  wait_tailscaled || echo "watchdog: warning - tailscaled still not online"
  funnel_apply
  if is_healthy; then
    echo "watchdog: prod health recovered after tailscaled restart"
    return 0
  fi

  echo "watchdog: still failing; hard-resetting the Funnel"
  tailscale_cmd funnel reset >/dev/null 2>&1 || true
  tailscale_cmd funnel --bg 11435 >/dev/null 2>&1 || true
  funnel_apply
  wait_tailscaled || true
  if is_healthy; then
    echo "watchdog: prod health recovered after funnel reset"
    return 0
  fi

  echo "watchdog: prod health still failing after full repair"
  return 1
}

mkdir -p "$STATE_DIR"
# State dir may be created by the root timer OR a repo user running manually;
# both must be able to update the fail counter.
chmod 0777 "$STATE_DIR" 2>/dev/null || true
now="$(date +%s)"
cnt=0
last=0
[ -f "$STATE_DIR/fails" ] && cnt="$(cat "$STATE_DIR/fails" 2>/dev/null || echo 0)"
[ -f "$STATE_DIR/last" ] && last="$(cat "$STATE_DIR/last" 2>/dev/null || echo 0)"

if is_healthy; then
  rm -f "$STATE_DIR/fails" "$STATE_DIR/last"
  echo "watchdog: prod health OK, nothing to do"
  exit 0
fi

cnt=$((cnt + 1))
echo "$cnt" > "$STATE_DIR/fails"
echo "watchdog: prod health FAILING (consecutive=$cnt, need=$NEED_FAILS)"

if [ "$cnt" -lt "$NEED_FAILS" ]; then
  exit 0
fi

if [ -f "$STATE_DIR/last" ] && [ $((now - last)) -lt "$COOLDOWN_SECS" ]; then
  echo "watchdog: in cooldown; last repair $((now - last))s ago"
  exit 0
fi

if repair; then
  echo "$now" > "$STATE_DIR/last"
  echo "0" > "$STATE_DIR/fails"
else
  echo "$now" > "$STATE_DIR/last"
fi

exit 0