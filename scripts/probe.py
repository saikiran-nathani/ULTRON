#!/usr/bin/env python3
"""Probe the hub from outside it, and shout when it is up but not serving.

    python3 scripts/probe.py                     # check once, print, exit 0/1
    python3 scripts/probe.py --install           # install the launchd timer
    python3 scripts/probe.py --uninstall

Why this exists, concretely
---------------------------
The hub ran for 6h30m, exhausted its 256 file descriptors, and then spent the
rest of the day accepting TCP connections it could not answer. The process was
alive. launchd reported it healthy. `Restart=on-failure` never fired, because
nothing failed — it just stopped being useful.

That is the failure mode every on-box check misses, and it is the majority of
them: power cut, kernel panic, OOM-kill, network loss and descriptor
exhaustion all leave something that either cannot report or reports fine.

So there are two layers, and they catch disjoint things:

| layer               | direction        | catches                          | misses            |
|---------------------|------------------|----------------------------------|-------------------|
| dead man's switch   | box → outside    | box gone, power, network, OOM    | "up but 500"      |
| **this**            | Mac → the hub    | up but broken, wrong allowlist   | while the Mac sleeps |

This is the second one. It runs on a different machine from the thing it
judges, which is the only property that matters.

What it actually checks
-----------------------
Not just "did something answer". A 200 from `/healthz` is necessary and not
sufficient, so it also fetches `/api/state` and requires a parseable body with
the fields the dashboard needs. The hub's failure returned *nothing* — but a
future one could return a 200 and an error page, and "absence of evidence must
never render as success" applies to the probe too.

Notification
------------
Reuses `notify.py`, so alerts land wherever the rest of trainwatch's already
do. If ntfy is unconfigured it still writes to the log and exits non-zero,
because a probe whose only output is a notification you have not set up is a
probe that reports nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

LABEL = "com.trainwatch.probe"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG = ROOT / "var" / "probe.log"

# Every 5 minutes. Matches the dead man's switch cadence in the plan, so the
# two layers agree on how long an outage may go unnoticed.
INTERVAL_SECONDS = 300

# Generous: the hub polls SQLite on the request path and the tailnet can be
# slow on cellular. A timeout that is too tight turns a slow answer into a
# false alarm, and a probe that cries wolf gets muted.
TIMEOUT = 10.0

# Consecutive failures before alerting. One failed probe is a blip — a laptop
# waking up, a tailnet re-handshake.
#
# This used to say "three in a row at 5-minute spacing is 15 minutes of
# genuinely not working". Eleven hours of real log says otherwise: 38 samples
# where 137 were expected, with seven gaps over 11 minutes and one of **three
# hours**. launchd's StartInterval does not fire while the Mac is asleep and
# coalesces missed firings into a single catch-up run, so a closed lid is a
# blind monitor.
#
# So three failures is an unknown number of minutes, and — worse — a gap is
# indistinguishable from a healthy stretch in a log that only records the
# samples it managed to take. A monitor whose silence reads as health is the
# exact inversion this file exists to correct, so the gap is now measured and
# logged explicitly.
#
# The real fix is not here. A probe on a machine that sleeps cannot watch a
# server that does not; that is what the plan's dead man's switch is for, run
# ON the server and pushing outbound, where silence becomes the alarm rather
# than the absence of one.
FAILURES_BEFORE_ALERT = 3

# Log an explicit blind-window line when the gap since the last check exceeds
# this. Twice the intended 5-minute interval: one late firing is scheduler
# jitter, two means nobody was watching.
MAX_QUIET_SECONDS = 600

STATE = ROOT / "var" / "probe-state.json"


def _urls() -> list[str]:
    """Where to probe, most specific first.

    `TRAINWATCH_PROBE_URL` overrides. The default is localhost because the hub
    currently runs on this Mac; once it moves to the TUF this becomes the
    tailnet name and the probe genuinely crosses a machine boundary. Until
    then it is still worth running — it catches "up but not serving", which is
    the failure that actually happened, and it does not pretend to catch a
    power cut.
    """
    if override := os.environ.get("TRAINWATCH_PROBE_URL"):
        return [override.rstrip("/")]
    port = os.environ.get("TRAINWATCH_PORT", "8730")
    return [f"http://127.0.0.1:{port}"]


def _get(url: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.status, resp.read(64_000)


def check(base: str) -> tuple[bool, str]:
    """True only if the hub is genuinely answering, with a reason when not."""
    try:
        status, _ = _get(f"{base}/healthz")
    except urllib.error.HTTPError as exc:
        return False, f"/healthz returned {exc.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        # This is the branch the real outage took: the connection was accepted
        # and then reset, because the process had no descriptor for it.
        return False, f"/healthz unreachable: {exc}"
    if status != 200:
        return False, f"/healthz returned {status}"

    # A 200 from a health endpoint is necessary and not sufficient. Ask for
    # something the dashboard actually needs and check the shape of it.
    try:
        status, body = _get(f"{base}/api/state")
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            # Enforcement is on and the probe has no session. That is correct
            # behaviour, and it proves the app is serving — which is all this
            # layer is for.
            return True, "healthz ok; /api/state 401 (auth enforced, app serving)"
        return False, f"/api/state returned {exc.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, f"/api/state unreachable: {exc}"

    if status != 200:
        return False, f"/api/state returned {status}"
    try:
        state = json.loads(body)
    except json.JSONDecodeError:
        return False, "/api/state returned a 200 that is not JSON"
    for field in ("now", "version", "status"):
        if field not in state:
            return False, f"/api/state is missing {field!r} — up but answering wrongly"
    return True, f"healthy (version {state['version']}, status {state['status']})"


def _load_state() -> dict[str, object]:
    try:
        return json.loads(STATE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(state: dict[str, object]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(STATE)


def _notify(title: str, body: str) -> bool:
    """Push, if ntfy is configured. Returns whether it actually sent.

    The first version of this called `Config.load()` and `Notifier(cfg).send()`
    — neither of which exists. It failed silently into the log on every alert,
    which is the bug this whole script is about wearing a different hat: the
    alerting path had never been exercised, so "notifications are configured"
    was an assumption rather than a fact. The real API is `load_config()` and
    `Notifier(url).alert(body, title=..., rule=...)`.
    """
    try:
        from src.trainwatch.config import load_config
        from src.trainwatch.notify import Notifier

        cfg = load_config()
        if not cfg.notify_enabled:
            return False
        notifier = Notifier(cfg.ntfy_url, token=cfg.ntfy_token)
        try:
            # `rule` is the dedupe key, so repeated probes of the same outage
            # collapse instead of sending one push every five minutes.
            return notifier.alert(body, title=title, priority="high", rule="probe")
        finally:
            notifier.close()
    except Exception as exc:
        _log(f"notify failed: {exc}")
        return False


def _descriptors() -> str:
    """The hub's open descriptor count, for the log line.

    Recorded on every probe because the descriptor leak that took this service
    down is **not fully diagnosed**. The pools were made weak-referencing and
    the ceiling raised from 256 to 4096, which turned ~6 hours into ~12, but
    measurement showed the count still trending up and the mechanism is still
    unknown.

    So rather than argue about it, sample it. The probe already runs every five
    minutes; adding one number per line turns an open question into a dataset —
    `grep fds= var/probe.log` gives the trend over days, which is the only
    thing that can settle whether it plateaus or climbs.

    Best-effort: a monitor must never fail because a diagnostic did.
    """
    try:
        out = subprocess.run(
            ["/bin/launchctl", "list", "com.trainwatch.hub"],
            capture_output=True, text=True, timeout=5, check=False,
        ).stdout
        pid = ""
        for line in out.splitlines():
            if '"PID"' in line:
                pid = "".join(c for c in line.split("=")[-1] if c.isdigit())
        if not pid:
            return "fds=?"
        listed = subprocess.run(
            ["/usr/sbin/lsof", "-p", pid], capture_output=True, text=True, timeout=20, check=False
        ).stdout.splitlines()
        total = max(0, len(listed) - 1)
        db = sum(1 for line in listed if "trainwatch.db" in line)
        return f"fds={total} db={db}"
    except Exception:
        return "fds=?"


def _stamp(epoch: float) -> str:
    return time.strftime("%H:%M", time.localtime(epoch))


def _log(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{stamp} {line}\n")


def run_once(*, quiet: bool = False) -> int:
    base = _urls()[0]
    ok, reason = check(base)
    state = _load_state()
    streak = int(state.get("failures", 0) or 0)

    # Before anything else: say how long nobody was looking. Without this the
    # log reads as a continuous series of healthy samples, and a three-hour
    # hole in it looks exactly like three hours of health. The hub was dead for
    # six hours once while its supervisor reported it running; a monitor that
    # cannot distinguish "fine" from "unwatched" would not have caught that
    # either.
    now = time.time()
    last_check = float(state.get("last_check", 0) or 0)
    gap = now - last_check
    if last_check and gap > MAX_QUIET_SECONDS:
        _log(
            f"UNMONITORED for {gap / 60:.0f} min — no probe ran between "
            f"{_stamp(last_check)} and {_stamp(now)}. The hub may have been down "
            f"for any part of it and this probe would not know."
        )

    if ok:
        if streak >= FAILURES_BEFORE_ALERT:
            _log(f"RECOVERED {base} — {reason}")
            _notify("trainwatch hub recovered", f"{base}\n{reason}")
        _save_state({"failures": 0, "last_ok": now, "last_check": now, "last_reason": reason})
        # Logged on success too, not only on failure: the trend is the point,
        # and a series with only the bad samples in it cannot show a trend.
        _log(f"ok {base} — {reason} [{_descriptors()}]")
        if not quiet:
            print(f"ok   {base}  {reason}")
        return 0

    streak += 1
    _save_state({"failures": streak, "last_fail": now, "last_check": now, "last_reason": reason})
    _log(f"FAIL ({streak}) {base} — {reason} [{_descriptors()}]")
    if not quiet:
        print(f"FAIL {base}  {reason}  (consecutive: {streak})", file=sys.stderr)

    if streak == FAILURES_BEFORE_ALERT:
        # Exactly at the threshold, not above it: alert once per outage rather
        # than every five minutes for as long as it lasts.
        sent = _notify(
            "trainwatch hub is not serving",
            f"{base}\n{reason}\n\n"
            f"{streak} consecutive failures ({streak * INTERVAL_SECONDS // 60} min).\n"
            "The process may still be running — check `launchctl list com.trainwatch.hub` "
            "and `tail var/hub.log`.",
        )
        if not sent:
            _log("ntfy is not configured — this log is the only alert")
    return 1


def install() -> int:
    plist = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, str(Path(__file__).resolve()), "--once"],
        "StartInterval": INTERVAL_SECONDS,
        "RunAtLoad": True,
        "WorkingDirectory": str(ROOT),
        "StandardOutPath": str(LOG),
        "StandardErrorPath": str(LOG),
        "ProcessType": "Background",
        # The lesson from service.py, applied here too: a supervised job
        # inherits almost nothing, and this script imports trainwatch and may
        # shell out. An absolute interpreter and an explicit PATH are not
        # optional.
        "EnvironmentVariables": {
            "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            # Carried into the plist, not left to the shell. `_urls()` honours
            # TRAINWATCH_PROBE_URL, and a test has always said that exists "so
            # it can point at the TUF once the hub moves there" — but the
            # installer could not set it, so the installed timer could only
            # ever probe localhost.
            #
            # After the migration localhost is nothing at all, so the timer
            # would have reported the hub down every five minutes forever. The
            # worse version: something else binds 8730 later and the probe
            # cheerfully reports *that* as the hub being healthy.
            **({"TRAINWATCH_PROBE_URL": os.environ["TRAINWATCH_PROBE_URL"]}
               if os.environ.get("TRAINWATCH_PROBE_URL") else {}),
        },
    }
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_bytes(plistlib.dumps(plist))
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], check=False, capture_output=True)
    result = subprocess.run(
        ["launchctl", "bootstrap", f"gui/{uid}", str(PLIST)], capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"launchctl bootstrap failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"installed {LABEL} — every {INTERVAL_SECONDS // 60} min")
    print(f"  plist  {PLIST}")
    print(f"  log    {LOG}")
    print("\nVerify by demonstration, which is the only way this counts:")
    here = f'"{sys.executable}" "{Path(__file__).resolve()}" --once'
    # The stop/start commands depend on where the hub lives, and it moved. This
    # block used to hard-code `launchctl ... com.trainwatch.hub`, which stopped
    # existing the moment the hub was migrated to the TUF — printing
    # instructions that fail is how a demonstration quietly stops being run.
    target = _urls()[0]
    if "127.0.0.1" in target or "localhost" in target:
        stop = "launchctl bootout gui/$(id -u)/com.trainwatch.hub"
        start = "launchctl kickstart -k gui/$(id -u)/com.trainwatch.hub"
    else:
        host = target.split("//", 1)[-1].split("/")[0].split(":")[0]
        stop = f"ssh {host} 'systemctl --user stop trainwatch-hub'"
        start = f"ssh {host} 'systemctl --user start trainwatch-hub'"
    print(f"  {start:<58} # bring it up")
    print(f"  {here}   # should say ok")
    print(f"  {stop:<58} # stop it")
    print(f"  {here}   # should FAIL")
    print("\n  A probe nobody has watched fail is a probe nobody knows is wired up.")
    return 0


def uninstall() -> int:
    subprocess.run(
        ["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], check=False, capture_output=True
    )
    PLIST.unlink(missing_ok=True)
    print(f"removed {LABEL}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="probe once (the timer's entry point)")
    ap.add_argument("--install", action="store_true", help="install the launchd timer")
    ap.add_argument("--uninstall", action="store_true", help="remove the timer")
    ap.add_argument("--quiet", action="store_true", help="log only, no stdout")
    args = ap.parse_args()

    if args.install:
        return install()
    if args.uninstall:
        return uninstall()
    return run_once(quiet=args.quiet)


if __name__ == "__main__":
    raise SystemExit(main())
