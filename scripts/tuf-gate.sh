#!/usr/bin/env bash
#
# Step 3 of the TUF bring-up: the gate, by demonstration only.
#
#   ./scripts/tuf-gate.sh              # everything except the reboot
#   ./scripts/tuf-gate.sh --reboot     # include the reboot test
#
# "The unit says Restart=on-failure" is not evidence. Killing the process and
# watching it come back is. Several items in this project were green in config
# and red in reality, and the only thing that told them apart was doing it.
#
# Each check below corresponds to a way the box has actually failed, or would:
#
#   1. Keyless SSH        — otherwise every script needs a human at a prompt
#   2. tmux survives      — otherwise closing the Mac ends an 8-hour run
#   3. kill -9 returns    — otherwise a crash at 03:00 is an outage until noon
#   4. Reboot returns     — the one everybody skips, and the ONLY way to find a
#                           unit you enabled but never made persistent
#   5. Restore works      — an untested backup is a file, not a backup
#
# The reboot is opt-in because it is disruptive: it will end anything running.
# It is also the most valuable check here, so do not leave it un-run.

set -euo pipefail

HOST="${TUF_HOST:-tuf}"
UNIT="${TUF_UNIT:-trainwatch-hub}"
DO_REBOOT=0
FAILED=0

for arg in "$@"; do
  case "$arg" in
    --reboot) DO_REBOOT=1 ;;
    -h | --help)
      sed -n '2,24p' "$0" | sed 's|^# \{0,1\}||'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
miss() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  FAILED=1
}
note() { printf '        \033[2m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

sh_() { ssh -n -o BatchMode=yes "$HOST" "$@"; }

printf '\033[1mTUF gate — host %s, unit %s\033[0m\n' "$HOST" "$UNIT"

# ── 1 ────────────────────────────────────────────────────────────────────
step "1. SSH with no password"
if sh_ true 2>/dev/null; then
  pass "ssh $HOST returns without prompting"
else
  miss "ssh $HOST failed under BatchMode — run ./scripts/tuf-bringup.sh first"
  exit 1
fi

# ── 2 ────────────────────────────────────────────────────────────────────
step "2. Work survives the Mac going away"
SESSION="gate-$$"
sh_ "tmux new-session -d -s $SESSION 'sleep 300' 2>/dev/null || true"
# A second, entirely separate SSH connection stands in for "closed the laptop,
# came back later". Checking within the same connection would prove nothing:
# the session would be alive because the connection still is.
if sh_ "tmux has-session -t $SESSION 2>/dev/null"; then
  pass "tmux session survived a new connection (detached work persists)"
  sh_ "tmux kill-session -t $SESSION 2>/dev/null || true"
else
  miss "tmux session did not survive — check 'loginctl enable-linger'"
  note "without linger, user processes are killed when the session ends"
fi

# ── 3 ────────────────────────────────────────────────────────────────────
step "3. kill -9 the service; it comes back"
if ! sh_ "systemctl --user is-active $UNIT >/dev/null 2>&1"; then
  miss "$UNIT is not active, so there is nothing to kill"
  note "the hub may still be on the Mac — see bringup item 7"
else
  BEFORE="$(sh_ "systemctl --user show $UNIT -p MainPID --value")"
  sh_ "kill -9 $BEFORE 2>/dev/null || true"
  RECOVERED=0
  for _ in $(seq 1 20); do
    sleep 1
    AFTER="$(sh_ "systemctl --user show $UNIT -p MainPID --value" 2>/dev/null || echo 0)"
    if [ "${AFTER:-0}" != "0" ] && [ "$AFTER" != "$BEFORE" ] &&
      sh_ "systemctl --user is-active $UNIT >/dev/null 2>&1"; then
      pass "restarted: pid $BEFORE → $AFTER"
      RECOVERED=1
      break
    fi
  done
  [ "$RECOVERED" -eq 1 ] || miss "did not come back within 20s — check Restart= and its rate limit"

  # A crash loop that restarts forever hides the bug and fills the disk with
  # logs. Restart= without a rate limit is only half the setting.
  #
  # Assert the INTERVAL, not the burst. systemd's DefaultStartLimitBurst is
  # itself 5, so `show -p StartLimitBurst` returns a non-zero number whether
  # the unit set anything or not — the old check here passed on the default and
  # would have reported "rate limit is set" for a unit that had none. That is
  # absence-of-evidence-as-success inside the gate whose whole job is to catch
  # it. Only the interval distinguishes configured from inherited: the default
  # is 10s, and 10s with RestartSec=5 allows about two restarts per window, so
  # a burst of 5 is never reached and the service restarts forever.
  INTERVAL="$(sh_ "systemctl --user show $UNIT -p StartLimitIntervalSec --value" 2>/dev/null | tr -d '[:space:]')"
  BURST="$(sh_ "systemctl --user show $UNIT -p StartLimitBurst --value" 2>/dev/null | tr -d '[:space:]')"
  if [ "$INTERVAL" = "300000000" ] || [ "$INTERVAL" = "5min" ]; then
    pass "restart rate limit is configured: ${BURST:-?} failures in ${INTERVAL} (not systemd's 10s default)"
  else
    miss "restart rate limit is systemd's default (interval=${INTERVAL:-unset}), not the unit's 5 minutes — check that StartLimit* are in [Unit], because under [Service] systemd ignores them silently"
  fi
fi

# ── 4 ────────────────────────────────────────────────────────────────────
step "4. Reboot; everything returns unaided"
if [ "$DO_REBOOT" -eq 0 ]; then
  note "skipped. Re-run with --reboot to include it."
  note "This is the check that finds a unit you enabled but never made"
  note "persistent, and it is the one that gets skipped. Do not skip it."
else
  echo "  rebooting $HOST — this will end anything running on it"
  sh_ 'sudo systemctl reboot' 2>/dev/null || true
  sleep 10
  BACK=0
  for _ in $(seq 1 60); do
    sleep 5
    if sh_ true 2>/dev/null; then
      BACK=1
      break
    fi
  done
  if [ "$BACK" -eq 0 ]; then
    miss "did not come back within ~5 minutes"
  else
    pass "host is back and reachable"
    # The real question is not "did it boot" but "did everything that is
    # supposed to be running come back without being asked".
    if sh_ "systemctl --user is-active $UNIT >/dev/null 2>&1"; then
      pass "$UNIT came back unaided"
    else
      miss "$UNIT did NOT come back — enabled but not persistent (or linger is off)"
    fi
    SWAP_G=$(( $(sh_ "awk '/^SwapTotal/{print \$2}' /proc/meminfo") / 1024 / 1024 ))
    if [ "$SWAP_G" -ge 15 ]; then
      pass "swap is still ${SWAP_G} G after reboot (fstab entry holds)"
    else
      miss "swap fell back to ${SWAP_G} G — /swap2.img is not in /etc/fstab"
    fi
    if sh_ 'findmnt -n /data >/dev/null' 2>/dev/null; then
      pass "/data remounted"
    else
      miss "/data did not remount — writes will silently land on the OS disk"
    fi
  fi
fi

# ── 5 ────────────────────────────────────────────────────────────────────
step "5. A backup restores, and the restore is diffed"
note "not automated: restoring over a live database is not something a gate"
note "script should do unprompted. Run it by hand, and record the date:"
cat <<'EOF'

    trainwatch backup --list
    trainwatch backup --restore <snapshot> --to /tmp/restored.db
    # Then DIFF it. "The file exists" is not a restore -- compare row counts
    # against the live database for each table you care about:
    sqlite3 /tmp/restored.db  'select count(*) from runs; select count(*) from metrics;'
    sqlite3 var/trainwatch.db 'select count(*) from runs; select count(*) from metrics;'

EOF

# ── verdict ──────────────────────────────────────────────────────────────
echo
if [ "$FAILED" -eq 0 ]; then
  if [ "$DO_REBOOT" -eq 0 ]; then
    printf '\033[1mGreen, except the reboot — which is not optional. Re-run with --reboot.\033[0m\n'
    exit 1
  fi
  printf '\033[1;32mGate passed. Stage 0 is done.\033[0m\n'
  exit 0
fi
printf '\033[1;31mGate failed. Do not start Stage 1 on this.\033[0m\n'
exit 1
