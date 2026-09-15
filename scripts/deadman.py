#!/usr/bin/env python3
"""The dead man's switch: the box tells the outside world it is alive.

    python3 scripts/deadman.py --once       # one beat (the timer's entry point)
    python3 scripts/deadman.py --install    # print the systemd timer + unit
    python3 scripts/deadman.py --check      # is the receiver actually wired up?

Why this outranks the probe
---------------------------
`probe.py` runs on the Mac and asks the hub whether it is well. That catches
"up but broken", which nothing on the box can catch, and it was supposed to be
the safety net. Eleven hours of its own log says it cannot be:

    137 samples expected at 5-minute spacing. 38 arrived.
    Seven gaps over 11 minutes, one of three hours.
    Roughly nine of the eleven hours unwatched.

launchd's `StartInterval` does not fire while the Mac is asleep, and it
coalesces the missed firings into one catch-up run. So the machine doing the
watching sleeps and — once the hub moves — the machine being watched does not.
A closed lid is a blind monitor, and a log holding only the samples it managed
to take renders that blindness as an unbroken line of `ok`.

This runs the other way. The server pushes outbound on a timer, and **absence
of the push is the alarm**. It needs nothing of the Mac, survives the lid being
shut, and catches the whole class the probe structurally cannot:

    | layer             | direction     | catches                       | misses      |
    |-------------------|---------------|-------------------------------|-------------|
    | **this**          | box → outside | power, panic, OOM, network, fd | "up but 500" |
    | probe.py          | Mac → hub     | up but broken, bad allowlist   | while the Mac sleeps |

The two are disjoint, and this one is now the first line.

The part that is easy to get wrong
----------------------------------
**A dead man's switch you cannot see the other end of is decorative.** The
sending side can never prove the alarm works — it only proves it sent. So:

  * with no receiver configured this **exits non-zero and says so**, rather
    than succeeding at doing nothing, which is how a switch ends up installed,
    green, and silent for the one outage it existed for;
  * `--check` pings the receiver now and tells you what it answered;
  * `--install` prints the unit *and* the demonstration you have to run, which
    is the plan's own C7 and the step everyone skips: stop the timer, wait out
    the grace period, confirm the alert actually arrives, and time it.

The receiver has to be something that alerts on silence — a healthchecks.io
ping URL or equivalent. ntfy cannot do it: it delivers what you send, and the
whole point here is what you stop sending.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

LOG = ROOT / "var" / "deadman.log"
STATE = ROOT / "var" / "deadman-state.json"

# Matches the probe's cadence and the plan's. Five minutes is short enough that
# an outage is noticed while you could still do something about it, and long
# enough that a reboot does not look like a death.
INTERVAL_SECONDS = 300

# The receiver. Deliberately has no default: a default would be a URL nobody
# owns, and a switch pinging into the void looks exactly like a working one.
URL_ENV = "TRAINWATCH_DEADMAN_URL"

# The hub, asked only so the beat can carry its state. This switch does NOT
# judge the hub — that is the probe's job, and duplicating it here would give
# two answers to one question. It is carried because a beat that says "alive,
# and by the way the hub is not answering" costs nothing and has, on occasion,
# been the whole diagnosis.
HUB_URL = os.environ.get("TRAINWATCH_PROBE_URL", "http://127.0.0.1:8730").rstrip("/")

TIMEOUT = 10.0


def _log(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{stamp} {line}\n")


def _load_state() -> dict[str, object]:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_state(state: dict[str, object]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    tmp.replace(STATE)


def hub_state() -> str:
    """One word about the hub, for the beat's body. Never raises."""
    try:
        with urllib.request.urlopen(f"{HUB_URL}/healthz", timeout=3) as resp:
            return "hub-ok" if resp.status == 200 else f"hub-{resp.status}"
    except urllib.error.HTTPError as exc:
        return f"hub-{exc.code}"
    except (urllib.error.URLError, OSError, ValueError):
        return "hub-unreachable"


def beat_body() -> str:
    """What the beat carries. Short: some receivers cap the body at 10 KB."""
    # `/proc/uptime` is Linux-only. Reported as unknown rather than as a
    # number, because "up=-0.0h" is a wrong fact and "up=?" is a true one — and
    # this string is what someone reads at 3am when the alarm goes off.
    try:
        hours = f"{float(Path('/proc/uptime').read_text().split()[0]) / 3600:.1f}h"
    except (OSError, ValueError, IndexError):
        hours = "?"
    return (
        f"{socket.gethostname()} up={hours} {hub_state()} "
        f"at {time.strftime('%Y-%m-%d %H:%M:%S %Z')}"
    )


def send(url: str, body: str) -> tuple[bool, str]:
    """POST one beat. Returns (sent, what happened)."""
    req = urllib.request.Request(
        url, data=body.encode("utf-8"), method="POST", headers={"User-Agent": "trainwatch-deadman"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return (200 <= resp.status < 300), f"{resp.status}"
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def run_once(*, quiet: bool = False) -> int:
    url = os.environ.get(URL_ENV, "").strip()
    if not url:
        # The whole failure mode of this thing, refused up front. A switch that
        # exits 0 while sending nowhere is installed, green, and silent for the
        # one outage it was there for.
        msg = (
            f"{URL_ENV} is not set, so this beat went nowhere. A dead man's "
            f"switch with no receiver cannot alarm on silence — it only looks "
            f"like it can. Point it at something that alerts when a ping stops "
            f"arriving (a healthchecks.io URL or equivalent); ntfy cannot do "
            f"it, because it delivers what you send and this is about what you "
            f"stop sending."
        )
        _log(f"UNCONFIGURED {msg}")
        print(msg, file=sys.stderr)
        return 2

    body = beat_body()
    ok, detail = send(url, body)
    now = time.time()
    state = _load_state()
    misses = 0 if ok else int(state.get("misses", 0) or 0) + 1
    _save_state(
        {
            "misses": misses,
            "last_attempt": now,
            "last_sent": now if ok else state.get("last_sent", 0),
            "last_detail": detail,
        }
    )

    if ok:
        _log(f"beat {detail} — {body}")
        if not quiet:
            print(f"beat sent ({detail}): {body}")
        return 0

    # A failed beat is indistinguishable, from the receiver's side, from the
    # box being dead — which is correct, and is the design working. It is
    # logged here so that a box which is alive but cannot reach the receiver
    # has somewhere to say so.
    _log(f"MISS ({misses}) {detail} — {body}")
    print(f"beat FAILED ({detail}) — {misses} in a row: {body}", file=sys.stderr)
    return 1


def check() -> int:
    """Is the other end actually wired up? The half this cannot assume."""
    url = os.environ.get(URL_ENV, "").strip()
    print(f"receiver: {url or '(unset)'}")
    if not url:
        print(
            f"\n{URL_ENV} is unset. Nothing below can be checked, and a switch "
            f"in this state sends into the void while reporting success.",
            file=sys.stderr,
        )
        return 2
    ok, detail = send(url, f"check from {socket.gethostname()}")
    print(f"ping:     {'accepted' if ok else 'REFUSED'} ({detail})")
    state = _load_state()
    last = float(state.get("last_sent", 0) or 0)
    if last:
        print(f"last beat: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(last))}")
    print(
        "\nThis proves the ping is accepted. It does NOT prove an alert arrives "
        "when the pings stop — nothing on this side can prove that. Run the "
        "demonstration in --install."
    )
    return 0 if ok else 1


UNIT = """# trainwatch-deadman.service — one beat. Driven by the .timer below.
[Unit]
Description=trainwatch dead man's switch (one beat)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory={root}
ExecStart={python} {script} --once --quiet
Environment="{env}=%h/.config/trainwatch/deadman-url"
# Read the URL from a file rather than baking it into the unit: a ping URL is
# a credential in everything but name, and unit files land in backups, git
# diffs and `systemctl cat` output.
EnvironmentFile=-%h/.config/trainwatch/deadman.env
"""

TIMER = """# trainwatch-deadman.timer
[Unit]
Description=trainwatch dead man's switch every {minutes} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec={minutes}min
# Without this, a box that was off does not beat until a full interval after
# boot, so a reboot reads as {minutes} more minutes of silence.
Persistent=true
AccuracySec=30s

[Install]
WantedBy=timers.target
"""


def install() -> int:
    """Print the unit, the timer, and the demonstration. Never writes."""
    python = sys.executable
    script = Path(__file__).resolve()
    print(f"# ── ~/.config/systemd/user/trainwatch-deadman.service ──")
    print(UNIT.format(root=ROOT, python=python, script=script, env=URL_ENV))
    print(f"# ── ~/.config/systemd/user/trainwatch-deadman.timer ──")
    print(TIMER.format(minutes=INTERVAL_SECONDS // 60))
    print(
        f"""# ── install ──
mkdir -p ~/.config/systemd/user ~/.config/trainwatch
echo '{URL_ENV}=<your ping URL>' > ~/.config/trainwatch/deadman.env
chmod 600 ~/.config/trainwatch/deadman.env
# paste the two files above, then:
systemctl --user daemon-reload
systemctl --user enable --now trainwatch-deadman.timer
loginctl enable-linger $USER      # or the timer dies at logout

# ── the demonstration, which is the point (plan item C7) ──
# Installing this proves nothing. The only thing that proves it is stopping it
# and watching the alarm arrive:
#
#   1. systemctl --user stop trainwatch-deadman.timer
#   2. wait out the receiver's grace period
#   3. confirm the alert ARRIVES, and write down how long it took
#   4. systemctl --user start trainwatch-deadman.timer
#   5. confirm the recovery notice arrives too
#
# Step 3 is the whole exercise. A switch nobody has ever seen fire is a switch
# nobody knows is wired up, and it will be discovered on the day it matters."""
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="send one beat (the timer's entry point)")
    ap.add_argument("--install", action="store_true", help="print the systemd unit and timer")
    ap.add_argument("--check", action="store_true", help="ping the receiver now and report")
    ap.add_argument("--quiet", action="store_true", help="log only, no stdout")
    a = ap.parse_args()

    if a.install:
        return install()
    if a.check:
        return check()
    return run_once(quiet=a.quiet)


if __name__ == "__main__":
    sys.exit(main())
