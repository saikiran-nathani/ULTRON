#!/usr/bin/env bash
#
# Bring the TUF up as a server, from the Mac, over SSH.
#
#   ./scripts/tuf-bringup.sh            # report only; changes nothing
#   ./scripts/tuf-bringup.sh --apply    # make the changes
#
# This is Step 2 of the bring-up. Step 1 cannot be done remotely and has to be
# typed at the TUF's own keyboard, once, because it is what installs the SSH
# server this script needs:
#
#   sudo apt update && sudo apt install -y \
#       openssh-server avahi-daemon tmux build-essential htop nvtop rsync restic \
#     && sudo systemctl enable --now ssh \
#     && sudo tailscale set --hostname=tuf --ssh \
#     && echo "USER=$(whoami)"
#
# `build-essential` is in there for two reasons, not one: it is also the unsloth
# unblock, because Triton JIT-compiles kernels at runtime and needs a C
# compiler. One apt call, two jobs. `tailscale set --ssh` means no key copying
# and no password prompts afterwards.
#
# Why a script and not a checklist
# --------------------------------
# Every item below was already written down as prose in TUF/01-SETUP.md, and
# several of them had never been done. A checklist that depends on a human
# remembering is the same failure mode as a service that depends on a human
# starting it. So: idempotent, re-runnable, and it reports what it found rather
# than assuming.
#
# Default is report-only on purpose. Every check here is read-only, so running
# it without --apply is safe on a box that is mid-training.

set -euo pipefail

HOST="${TUF_HOST:-tuf}"
APPLY=0
FAILED=0
declare -a RESULTS=()

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --check) APPLY=0 ;;
    -h | --help)
      sed -n '2,30p' "$0" | sed 's|^# \{0,1\}||'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# ── output ───────────────────────────────────────────────────────────────
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }
ok() {
  RESULTS+=("  ok      $1")
  printf '  \033[32mok\033[0m      %s\n' "$1"
}
todo() {
  RESULTS+=("  todo    $1")
  printf '  \033[33mtodo\033[0m    %s\n' "$1"
  FAILED=1
}
fail() {
  RESULTS+=("  FAIL    $1")
  printf '  \033[31mFAIL\033[0m    %s\n' "$1"
  FAILED=1
}
did() {
  RESULTS+=("  applied $1")
  printf '  \033[36mapplied\033[0m %s\n' "$1"
}

# `ssh -n` so a command that reads stdin cannot swallow the rest of this
# script — a classic way for a loop over hosts to silently run once.
sh_() { ssh -n -o BatchMode=yes "$HOST" "$@"; }
sudo_() {
  if [ "$APPLY" -eq 1 ]; then
    ssh -n -o BatchMode=yes "$HOST" "sudo $*"
  fi
}

# ── 0. reachability, before anything else ────────────────────────────────
bold "TUF bring-up — host '$HOST'  ($([ "$APPLY" -eq 1 ] && echo APPLY || echo 'report only'))"
echo

if ! sh_ true 2>/dev/null; then
  fail "cannot ssh to '$HOST' with BatchMode (no password prompts)"
  cat <<EOF

  Nothing else can run until this works. In order, the likely causes:

    1. The TUF is off, or off the tailnet.     tailscale status | grep -i tuf
    2. Step 1 was never run, so there is no
       SSH server and port 22 is closed.       (see the header of this script)
    3. It is still named killerx8143.          sudo tailscale set --hostname=tuf
    4. ~/.ssh/config has no User for it.       grep -A3 'Host tuf' ~/.ssh/config

  Item 4 is the one that looks like a network problem and is not.
EOF
  exit 1
fi
ok "ssh to '$HOST' works without a password"

# Single quotes deliberately: $USER must expand on the REMOTE host, not here.
# shellcheck disable=SC2016
REMOTE_USER="$(sh_ 'echo $USER')"
ok "remote user is '$REMOTE_USER'"

# ── 1. ~/.ssh/config actually names the user ─────────────────────────────
# Local check. The config shipped with a placeholder comment, and a Host block
# without `User` silently falls back to the *Mac's* username — which works
# until it doesn't, and then reads as an auth failure.
if grep -qE '^[[:space:]]*User[[:space:]]+[^[:space:]<]' <<<"$(awk '/^Host tuf$/,/^$/' ~/.ssh/config 2>/dev/null)"; then
  # shellcheck disable=SC2088  # display text, not a path: `~` is what a human types
  ok "~/.ssh/config names a User for 'tuf'"
else
  # shellcheck disable=SC2088
  todo "~/.ssh/config has no User for 'tuf' — add:  User $REMOTE_USER"
fi

# ── 2. swap: 16 G total, by ADDING a file ────────────────────────────────
# Never swapoff to resize. swapoff has to page everything currently swapped
# back into RAM before it returns, and the capacity sweeps have driven swap to
# ~2.8 G in use. Paging that into ~5.7 G free is an OOM-kill during the command
# meant to prevent OOM-kills.
SWAP_KB="$(sh_ "awk '/^SwapTotal/{print \$2}' /proc/meminfo")"
SWAP_G=$((SWAP_KB / 1024 / 1024))
if [ "$SWAP_G" -ge 15 ]; then
  ok "swap is ${SWAP_G} G"
elif sh_ 'test -f /swap2.img' 2>/dev/null; then
  todo "/swap2.img exists but swap is only ${SWAP_G} G — is it swapped on and in fstab?"
else
  todo "swap is ${SWAP_G} G; adding /swap2.img would take it to ~16 G"
  if [ "$APPLY" -eq 1 ]; then
    # fallocate first; dd is the fallback for filesystems that refuse it.
    sudo_ 'fallocate -l 12G /swap2.img || dd if=/dev/zero of=/swap2.img bs=1M count=12288 status=none'
    sudo_ 'chmod 600 /swap2.img'
    sudo_ 'mkswap /swap2.img >/dev/null'
    sudo_ 'swapon /swap2.img'
    # Idempotent fstab append: without this the box reboots back to 4 G,
    # looking configured and not being.
    sudo_ "grep -q '^/swap2.img' /etc/fstab || echo '/swap2.img none swap sw 0 0' >> /etc/fstab"
    NEW_KB="$(sh_ "awk '/^SwapTotal/{print \$2}' /proc/meminfo")"
    did "swap is now $((NEW_KB / 1024 / 1024)) G, and /swap2.img is in fstab"
  fi
fi

# ── 3. a laptop is a server that sleeps ──────────────────────────────────
if sh_ 'test -f /etc/systemd/logind.conf.d/99-server.conf' 2>/dev/null; then
  ok "lid-switch drop-in present"
else
  todo "closing the lid still suspends the box — and takes an 8-hour run with it"
  if [ "$APPLY" -eq 1 ]; then
    sudo_ 'mkdir -p /etc/systemd/logind.conf.d'
    sudo_ "tee /etc/systemd/logind.conf.d/99-server.conf >/dev/null <<'CONF'
# This machine is a server that happens to have a lid.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchDocked=ignore
HandleLidSwitchExternalPower=ignore
CONF"
    sudo_ 'systemctl restart systemd-logind'
    did "lid switch ignored"
  fi
fi

# Masking the targets is belt-and-braces: logind covers the lid, this covers
# anything else that asks the system to suspend.
if sh_ 'systemctl is-enabled sleep.target 2>/dev/null | grep -q masked' 2>/dev/null; then
  ok "sleep/suspend/hibernate targets masked"
else
  todo "sleep targets not masked — something other than the lid can still suspend it"
  if [ "$APPLY" -eq 1 ]; then
    sudo_ 'systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target'
    did "sleep targets masked"
  fi
fi

# ── 4. linger, or user units die at logout ───────────────────────────────
# Without this the hub is configured-looking and broken: it runs while you are
# logged in and stops the moment the session ends.
if sh_ "loginctl show-user $REMOTE_USER -p Linger 2>/dev/null | grep -q 'Linger=yes'" 2>/dev/null; then
  ok "linger enabled for '$REMOTE_USER' (user units survive logout)"
else
  todo "linger is OFF — user units will die at logout"
  if [ "$APPLY" -eq 1 ]; then
    sudo_ "loginctl enable-linger $REMOTE_USER"
    did "linger enabled"
  fi
fi

# ── 5. the data disk is actually mounted ─────────────────────────────────
# An unmounted /data silently resolves to an empty directory on the root disk.
# You then write "successfully" into nowhere and fill the OS disk instead.
if sh_ 'findmnt -n /data >/dev/null' 2>/dev/null; then
  ok "/data is mounted: $(sh_ 'findmnt -n -o SOURCE,FSTYPE,SIZE /data' | tr -s ' ')"
else
  fail "/data is NOT a mount point — writes there go to the OS disk"
fi

if sh_ 'nvidia-smi -L >/dev/null 2>&1'; then
  ok "nvidia-smi works: $(sh_ 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader' | tr -s ' ')"
else
  fail "nvidia-smi is not working — machine-health panels will be empty and training will not run"
fi

# ── 6. every binary the app shells out to resolves under a UNIT's PATH ───
# Not your shell's. A supervised unit gets PATH=/usr/bin:/bin:/usr/sbin:/sbin
# and nothing else, and `tailscale` lives in /usr/local/bin. When that lookup
# failed, host-allowlist discovery returned localhost only and the dashboard
# answered 421 to its own URL — a rejection that reads like DNS.
#
# This list is derived from the source, not remembered: every subprocess call
# and shutil.which() under src/trainwatch.
UNIT_PATH='/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
MISSING=""
for bin in tailscale tmux crontab nvidia-smi; do
  if sh_ "PATH='$UNIT_PATH' command -v $bin >/dev/null 2>&1"; then
    :
  else
    MISSING="$MISSING $bin"
  fi
done
if [ -z "$MISSING" ]; then
  ok "all shelled-out binaries resolve under a unit's PATH (tailscale tmux crontab nvidia-smi)"
else
  fail "not on a unit's PATH:$MISSING — set Environment=\"PATH=...\" in the unit"
fi
# tensorboard is optional: only the TensorBoard panel needs it.
if sh_ "PATH='$UNIT_PATH' command -v tensorboard >/dev/null 2>&1"; then
  ok "tensorboard present (optional)"
else
  dim "  --      tensorboard absent — only the TensorBoard panel needs it"
fi

# ── 7. the hub, supervised and memory-bounded ────────────────────────────
if sh_ 'systemctl --user is-active trainwatch-hub >/dev/null 2>&1'; then
  ok "trainwatch-hub is active under systemd --user"
  if sh_ 'systemctl --user show trainwatch-hub -p MemoryMax | grep -qv "MemoryMax=infinity"'; then
    ok "hub has a memory ceiling: $(sh_ 'systemctl --user show trainwatch-hub -p MemoryMax')"
  else
    todo "hub has no MemoryMax — a runaway server could be what OOM-kills a training run"
  fi
else
  todo "trainwatch-hub is not running here yet (it is still on the Mac)"
  cat <<'EOF'
           Migration is deliberately NOT automated. It moves a live database
           and repoints `tailscale serve`, and doing that from a script while
           the Mac's copy is still serving invites two writers on one file.
           Run it by hand, in this order, and stop at the first surprise:

             1. On the Mac:  launchctl bootout gui/$(id -u)/com.trainwatch.hub
             2. Copy var/trainwatch.db to the TUF  (rsync; the Mac's hub is
                now stopped, so there is exactly one writer)
             3. On the TUF:  trainwatch service install hub   # renders the unit
                             systemctl --user enable --now trainwatch-hub
             4. Add MemoryMax=512M to the unit — ~14x the measured 35 MB RSS
             5. Repoint `tailscale serve` at the TUF, off on the Mac
             6. Then re-run this script; the two checks above should go green
EOF
fi

# ── summary ──────────────────────────────────────────────────────────────
echo
bold "Summary"
printf '%s\n' "${RESULTS[@]}"
echo
if [ "$FAILED" -eq 0 ]; then
  bold "All checks green. Next: ./scripts/tuf-gate.sh — the gate is by demonstration."
  exit 0
fi
if [ "$APPLY" -eq 0 ]; then
  dim "Report only. Re-run with --apply to make the 'todo' changes."
else
  dim "Some items need attention by hand — see the notes above."
fi
exit 1
