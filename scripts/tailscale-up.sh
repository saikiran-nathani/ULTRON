#!/usr/bin/env bash
# Layer 0 · Reach — put this box on the tailnet.
#
# Every machine gets a stable 100.x.y.z that works on campus wifi, at home, or
# on cellular. No port forwarding, no dynamic DNS, no chasing a changing IP.
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

bold $'\nLayer 0 · Reach\n'

if ! command -v tailscale >/dev/null 2>&1; then
  warn "installing tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
ok "tailscale $(tailscale version | head -1)"

# WSL2 has no systemd by default, so tailscaled may need starting by hand.
if ! pgrep -x tailscaled >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running --quiet 2>/dev/null; then
    sudo systemctl enable --now tailscaled
  else
    warn "no systemd (normal on WSL2) — starting tailscaled in the background"
    sudo nohup tailscaled --state=/var/lib/tailscale/tailscaled.state \
      >/var/log/tailscaled.log 2>&1 &
    sleep 2
  fi
fi

# --ssh lets you SSH in over the tailnet using Tailscale's own identity,
# so there is no sshd to expose and no keys to distribute to the iPad.
sudo tailscale up --ssh

echo
ok "this machine: $(tailscale ip -4 | tr '\n' ' ')"
if command -v tailscale >/dev/null 2>&1; then
  echo
  bold "Tailnet"
  tailscale status || true
fi

cat <<'NEXT'

Next:
  · Install Tailscale on the iPad and the iPhone, same account.
  · Turn on MagicDNS in the admin console so you can use `asus` instead of
    the IP: https://login.tailscale.com/admin/dns

VERIFY BEFORE MOVING ON — this is the one test that matters:
  SSH to this box from the iPad over CELLULAR, with wifi switched off.
  Campus networks isolate clients from each other; home wifi hides the
  problem. If cellular works, everything downstream works.
NEXT
