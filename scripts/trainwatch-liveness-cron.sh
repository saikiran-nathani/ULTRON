#!/usr/bin/env bash
# Layer 3 · the alert that catches silent death.
#
# Installs a cron entry that asks, out of process, "has the run made progress?"
# This has to be external: a hang, an OOM kill, a SIGKILL or a dead CUDA
# context leave no code running to report anything. Value-based alerts cannot
# fire if nothing is running.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
TW="${ROOT}/scripts/trainwatch"
EVERY="${1:-10}"                       # minutes between checks

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

bold $'\nLayer 3 · liveness cron\n'

[[ -x "$TW" ]] || { echo "  trainwatch not installed — run: uv pip install -r requirements/mac.txt" >&2; exit 1; }

# --quiet: print only when unhealthy, so cron only mails you on a real problem.
LINE="*/${EVERY} * * * * cd ${ROOT} && ${TW} liveness --quiet >> ${ROOT}/logs/liveness.log 2>&1"

mkdir -p logs

if ! command -v crontab >/dev/null 2>&1; then
  warn "no crontab on this box"
  warn "install cron:  sudo apt-get install -y cron"
  exit 1
fi

CURRENT="$(crontab -l 2>/dev/null || true)"
if grep -qF "trainwatch liveness" <<<"$CURRENT"; then
  warn "an entry already exists; replacing it"
  CURRENT="$(grep -vF 'trainwatch liveness' <<<"$CURRENT" || true)"
fi
printf '%s\n%s\n' "$CURRENT" "$LINE" | sed '/^$/d' | crontab -
ok "installed: every ${EVERY} minutes"
echo "      $LINE"

# WSL2 has no init, so cron is often installed but not running. An installed
# cron entry that never fires is worse than none — you believe you are covered.
if ! pgrep -x cron >/dev/null 2>&1 && ! pgrep -x crond >/dev/null 2>&1; then
  warn "cron is NOT running (normal on WSL2 — there is no systemd)"
  echo
  echo "      Start it now:        sudo service cron start"
  echo "      Start it at boot, by adding this to your ~/.bashrc:"
  echo "        pgrep -x cron >/dev/null || sudo service cron start 2>/dev/null"
  echo
  echo "      To make that passwordless, run 'sudo visudo' and add:"
  echo "        $(whoami) ALL=(root) NOPASSWD: /usr/sbin/service cron start"
  echo
  echo "      Alternative that survives WSL restarts without cron at all —"
  echo "      run this from Windows Task Scheduler at logon:"
  echo "        wsl.exe -d \$(wslpath -w / >/dev/null 2>&1; echo Ubuntu) -- sudo service cron start"
else
  ok "cron daemon is running"
fi

echo
echo "  Verify it fires (forces one check now):"
echo "      ${TW} liveness"
echo "  Then watch:  tail -f ${ROOT}/logs/liveness.log"
