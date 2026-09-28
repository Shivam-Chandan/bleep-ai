#!/usr/bin/env bash
# db-watchdog.sh - Keeps the database (sqld/libSQL) up and reachable by BOTH
# box-side services and the prod (Vercel) app.
#
# sqld ("bleep-sqld.service") has Restart=on-failure from systemd, but that
# only covers a crash of the process itself. The database can still be dead
# from prod's point of view while the process looks fine:
#   - the process hangs/refuses new connections (saturated WAL, stuck thread),
#   - the Tailscale Funnel /sql mount disappears (so Vercel gets 502),
#   - the box's Tailscale IP changed and nothing re-binds sqld,
#   - the sqld JWT (DATABASE_AUTH_TOKEN) no longer matches the server key.
#
# This watchdog probes with a real authenticated `SELECT 1` against BOTH the
# box-side URL (what the digest worker uses) and the public /sql path (what the
# Vercel app uses), then walks a repair ladder. State + fail counting live in
# /tmp/bleep-db-watchdog/; a single blip (e.g. sqld mid-restart) never fires a
# repair.
#
# Intended to run from bleep-db-watchdog.timer every 2 minutes and on boot
# (which also serves as the DB warm/availability check).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

STATE_DIR="${DB_WATCHDOG_STATE:-/tmp/bleep-db-watchdog}"
# True hard failures (crash) are already handled by systemd's Restart=on-failure
# (~5s). This watchdog exists for the "process looks alive but is unreachable"
# cases (funnel gone, IP changed, stale JWT, hang); requiring 2 consecutive
# failures (~4-5 min) keeps it from restarting a HEALTHY sqld when a transient
# network flap (e.g. a tailscaled restart) makes a single probe fail.
NEED_FAILS="${DB_WATCHDOG_FAILS:-2}"
COOLDOWN_SECS="${DB_WATCHDOG_COOLDOWN:-120}"
WAIT_TICKS="${DB_WATCHDOG_WAIT_TICKS:-20}"   # ~60s max for sqld to come back
# Retries within one tick, so one-off curl failures (DERP rebind, proxy hiccup)
# don't register as an outage at all.
PROBE_ATTEMPTS="${DB_WATCHDOG_ATTEMPTS:-3}"

# Box-side DB URL (digest worker path) - defaults to .env.local DATABASE_URL.
DIRECT_BASE="${DB_WATCHDOG_DIRECT_URL:-}"
# Prod-facing DB URL (Vercel path) via the Tailscale Funnel /sql mount.
# Derived from `tailscale funnel status` (NOT APP_BASE_URL — that's the Vercel
# app URL, the DB lives behind the funnel hostname, e.g. bleep-ai.tailc...ts.net).
FUNNEL_BASE="${DB_WATCHDOG_FUNNEL_URL:-}"

# Import DATABASE_URL / DATABASE_AUTH_TOKEN / APP_BASE_URL without echoing values.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

[ -n "$DIRECT_BASE" ] || DIRECT_BASE="${DATABASE_URL:-http://127.0.0.1:8080}"
if [ -z "$FUNNEL_BASE" ]; then
  # Buffer fully before parsing: `grep -m1 | sed` directly on the pipe would
  # SIGPIPE tailscale once grep exits after the first match (and, under
  # `set -o pipefail`, kill this script). Reading into a variable first makes
  # the pipelines operate on already-read data. Importantly the whole lookup is
  # `|| true`-guarded: if tailscaled is mid-restart and returns nothing, we warn
  # and continue with the box-side check instead of silently dying (set -e).
  funnel_status="$(tailscale funnel status 2>/dev/null || true)"
  funnel_line="$(printf '%s\n' "$funnel_status" | grep -F '(Funnel on)' | head -n1 || true)"
  FUNNEL_BASE="$(printf '%s\n' "$funnel_line" | sed -E 's#^(https?://[^ ]+).*#\1#')"
  [ -n "$FUNNEL_BASE" ] && FUNNEL_BASE="${FUNNEL_BASE%/}/sql"
fi
TOKEN="${DATABASE_AUTH_TOKEN:-}"

# A probe without the JWT can only test the socket, not whether the app can
# actually read/write. Bail so we don't blind-restart sqld against a missing
# credential; the timer will retry and the box is misconfigured until fixed.
if [ -z "$TOKEN" ]; then
  echo "watchdog: DATABASE_AUTH_TOKEN missing from $ENV_FILE; skipping (cannot verify DB access)"
  exit 0
fi
if [ -z "${FUNNEL_BASE:-}" ]; then
  echo "watchdog: WARN could not resolve Funnel /sql URL (tailscaled down?); checking box-side DB only"
fi

command_exists() { command -v "$1" >/dev/null 2>&1; }

systemctl_restart() {
  if [ "$(id -u)" = "0" ]; then
    systemctl restart "$1"
  else
    sudo systemctl restart "$1"
  fi
}

# Probe one base URL with an authenticated SELECT 1. Success = HTTP 200 AND a
# `"type":"ok"` result (catches bad-token 401s and upstream 502s).
probe_db() {
  local base="$1"
  [ -n "$base" ] || return 1
  local url="${base%/}/v2/pipeline"
  local probe="$STATE_DIR/probe.$$"
  local out
  out="$(curl -sS --max-time 10 \
    -o "$probe" -w '%{http_code}' \
    -X POST "$url" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    --data '{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}}]}' \
    2>/dev/null || echo 000)"
  if [ "$out" = "200" ] && grep -q '"type":"ok"' "$probe"; then
    rm -f "$probe"
    return 0
  fi
  rm -f "$probe"
  return 1
}

is_healthy() {
  # Retry within the tick so transient flap (tailscaled rebind, DERP reconnect)
  # doesn't register as an outage. Both paths must pass.
  local try attempt
  for try in $(seq 1 "$PROBE_ATTEMPTS"); do
    attempt=0
    if ! probe_db "$DIRECT_BASE"; then
      attempt=1
    elif [ -n "${FUNNEL_BASE:-}" ] && ! probe_db "$FUNNEL_BASE"; then
      attempt=1
    fi
    if [ "$attempt" = 0 ]; then
      return 0
    fi
    [ "$try" -lt "$PROBE_ATTEMPTS" ] && sleep 2
  done
  return 1
}

# Wait until sqld answers a real authenticated SELECT 1 (not just TCP /health):
# `/health` returns 200 as soon as the socket is up, but a freshly-restarted
# sqld may still be recovering the meta store and answering 500s.
wait_sqld() {
  local i
  for i in $(seq 1 "$WAIT_TICKS"); do
    if probe_db "$DIRECT_BASE"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

funnel_apply() {
  if [ -x /usr/local/sbin/bleep-funnel-apply.sh ]; then
    /usr/local/sbin/bleep-funnel-apply.sh >/dev/null 2>&1 || true
  fi
}

# Repair ladder: cheapest, least disruptive first; re-check after each stage.
repair() {
  echo "watchdog: restarting bleep-sqld.service"
  systemctl_restart bleep-sqld.service || true
  wait_sqld || echo "watchdog: warning - sqld not answering /health yet"
  if is_healthy; then
    echo "watchdog: DB healthy after sqld restart"
    return 0
  fi

  if [ -n "${FUNNEL_BASE:-}" ]; then
    echo "watchdog: still failing; re-asserting Tailscale Funnel /sql mount"
    funnel_apply
    if is_healthy; then
      echo "watchdog: DB healthy after funnel re-apply (prod /sql restored)"
      return 0
    fi
  fi

  echo "watchdog: DB still failing after full repair"
  return 1
}

mkdir -p "$STATE_DIR"
# State dir may be created by the root timer OR a repo user running manually;
# both must be able to update the fail counter and probe files.
chmod 0777 "$STATE_DIR" 2>/dev/null || true
now="$(date +%s)"
cnt=0
last=0
[ -f "$STATE_DIR/fails" ] && cnt="$(cat "$STATE_DIR/fails" 2>/dev/null || echo 0)"
[ -f "$STATE_DIR/last" ] && last="$(cat "$STATE_DIR/last" 2>/dev/null || echo 0)"

if is_healthy; then
  rm -f "$STATE_DIR/fails" "$STATE_DIR/last"
  echo "watchdog: DB reachable (box=${DIRECT_BASE}${FUNNEL_BASE:+, funnel=${FUNNEL_BASE}}), nothing to do"
  exit 0
fi

cnt=$((cnt + 1))
echo "$cnt" > "$STATE_DIR/fails"
echo "watchdog: DB UNREACHABLE (consecutive=$cnt, need=$NEED_FAILS)"

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