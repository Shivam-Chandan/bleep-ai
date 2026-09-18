#!/usr/bin/env bash
# tunnel-watchdog.sh - Keeps the Cloudflare quick-tunnels (trycloudflare.com)
# registered. Account-less quick tunnels have no uptime guarantee: Cloudflare
# silently deregisters them, after which cloudflared loops forever with
#   ERR Register tunnel error ... "Unauthorized: Tunnel not found"
# and never recovers on its own. Restarting the unit makes cloudflared request
# a brand-new quick-tunnel URL; sync-tunnel-url.sh then propagates it.
#
# Intended to run as part of cloudflared-url-sync.timer (via sync-tunnel-url.sh).
# A per-service cooldown prevents restart loops during transient network blips.
set -euo pipefail

STATE_DIR="${TUNNEL_WATCHDOG_STATE:-/tmp/bleep-tunnel-watchdog}"
COOLDOWN_SECS="${WATCHDOG_COOLDOWN_SECS:-300}"
MIN_FAIL_LINES="${WATCHDOG_MIN_FAIL_LINES:-2}"

declare -A SERVICES=(
  [ollama]="cloudflared-ollama"
  # The app tunnel is intentionally gone (Vercel hosts the UI; the local
  # node app and its quick tunnel were retired). Restore this line and re-add
  # the unit only if self-hosting the app is ever brought back.
  # [app]="cloudflared-app"
)

PATTERNS="Register tunnel error|Unauthorized: Tunnel not found|failed to request quick Tunnel|Registered tunnel connection"

mkdir -p "$STATE_DIR"
now="$(date +%s)"

for name in "${!SERVICES[@]}"; do
  svc="${SERVICES[$name]}"
  state="$STATE_DIR/$name.last"
  last=0
  [ -f "$state" ] && last="$(cat "$state" 2>/dev/null || echo 0)"

  # Only manage services that are meant to be on. A deliberately-disabled or
  # masked tunnel (e.g. cloudflared-app while the local app is off) must stay
  # down; `systemctl restart` on it would re-invent the outage we're avoiding.
  # is-enabled prints one line per install slot (and differs for masked), so
  # match on tokens rather than a bare string/exit code.
  state="$( { systemctl is-enabled "$svc" 2>/dev/null || echo unknown; } | tr -s ' \n\t' ' ' | xargs)"
  case " $state " in
    *" enabled "*|*" static "*|*" indirect "*)
      ;;
    *)
      echo "watchdog: ${svc} is not enabled (${state:-unknown}) - leaving it alone"
      continue
      ;;
  esac

  if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
    echo "watchdog: ${svc} is not active; restarting"
    systemctl restart "$svc" 2>/dev/null || true
    echo "$now" > "$state"
    continue
  fi

  # The most recent relevant journal line decides health: a trailing
  # "Registered tunnel connection" means the registration is currently held,
  # anything else means cloudflared is stuck trying to (re)register.
  marker="$(journalctl -u "$svc" --no-pager -n 400 2>/dev/null | grep -E "$PATTERNS" | tail -1 || true)"

  if printf '%s' "$marker" | grep -q "Registered tunnel connection"; then
    echo "watchdog: ${svc} healthy"
    continue
  fi

  fails="$(journalctl -u "$svc" --no-pager -n 200 2>/dev/null | grep -cE "Register tunnel error|Unauthorized: Tunnel not found|failed to request quick Tunnel" || true)"
  if [ "$fails" -lt "$MIN_FAIL_LINES" ]; then
    echo "watchdog: ${svc} no recent registration failure (${fails} lines)"
    continue
  fi

  if [ $(( now - last )) -lt "$COOLDOWN_SECS" ]; then
    echo "watchdog: ${svc} failing (${fails} lines) but in cooldown; last restart $(($now - $last))s ago"
    continue
  fi

  echo "watchdog: ${svc} registration is dead (${fails} failure lines); restarting for a fresh tunnel URL"
  systemctl restart "$svc" 2>/dev/null || true
  echo "$now" > "$state"
done

exit 0