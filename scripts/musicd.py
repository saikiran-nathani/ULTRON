#!/usr/bin/env python3
"""Apple Music's now-playing and transport, over the tailnet, for the PWA.

    python3 scripts/musicd.py --once       # ask once, print the JSON, exit
    python3 scripts/musicd.py --serve      # bind and serve (the launchd entry point)
    python3 scripts/musicd.py --install    # PRINT the launchd plist (writes nothing)
    python3 scripts/musicd.py --where      # what it would bind, and why

Why this exists, concretely
---------------------------
nexus is a Tauri desktop app being replaced by a PWA. `nexus/src/lib/music.ts`
makes 14 `invoke()` calls into Rust commands named `music_*`, and every one of
them is a thin wrapper around **AppleScript** — `osascript -e 'tell application
"Music" to ...'`. See `nexus/src-tauri/src/lib.rs:364-603`.

AppleScript does not exist in a browser. So in the PWA that widget renders a
play button, a scrubber and a track title, and `invoke()` is not there:
`music.ts`'s `call()` returns `null` on every path. The control looks live and
is inert — which is the exact failure this repo is organised against, wearing a
different hat. A dead play button is *absence of evidence rendering as
success*.

MusicKit JS was the other option and was rejected: it needs an Apple developer
token, which is the same $99/yr as just going native. So instead, the same
pattern as everything else here — **a small service on a machine you own,
reached over the tailnet.** The Mac is where Music.app is; the Mac answers.

What it binds, and why
----------------------
**Default: this machine's tailnet IPv4 (`tailscale ip -4`), port 8731.**
Never `0.0.0.0`, and `--bind 0.0.0.0` is *refused* unless
`MUSICD_ALLOW_ANY_INTERFACE=1` is set, because:

  * this service is unauthenticated and it **controls your Mac**. `POST /next`
    from anything that can reach the port skips your track. That is a small
    harm, but the port is the same port, and the habit is the thing;
  * `0.0.0.0` also binds every café wifi, every hotel LAN, and any future
    bridged interface you had not thought about. The tailnet IP binds exactly
    one interface, the encrypted one, with no listener anywhere else;
  * loopback would be safer still and is the fallback when tailscale is absent
     — but it cannot be reached from the iPad, which is the entire point. So
    the tailnet IP is *the safest option that still works over the tailnet*,
    and that is the rule.

On top of the bind address, the `Host` header is allowlisted and unrecognised
values get a **421**, for the reason set out in ADR-0003 C1 and implemented in
`src/trainwatch/security.py`: the threat is not other machines on the tailnet,
it is any web page open in Safari, which can reach `http://100.x.y.z:8731` as
easily as the dashboard can. DNS rebinding is the attack, the `Host` header is
the only thing a browser cannot forge, and so it is the only control that
actually closes it. The allowlist is *imported* from `security.py` rather than
re-derived, because two allowlists is one allowlist that is wrong.

Writes are `POST` only
----------------------
`GET /api/music/next` would be a mutation behind a safe method: a `<img src>`,
a link preview, a prefetch or Safari's speculative loader could skip your
track. So the transport verbs answer **405** to `GET` and additionally require
`X-Trainwatch: 1` (ADR-0003 C3 — a custom header forces a CORS preflight that
this service never answers, so a browser on another origin cannot send the
real request).

Every osascript call has a timeout
----------------------------------
This is the failure that will actually happen. `osascript` blocks
*indefinitely* if Music.app is mid-dialog ("Do you want to allow…", a Sign in
to Apple Music sheet, a spinning beachball), and the Rust original has no
timeout at all — `Command::output()` waits forever (`lib.rs:364-374`). In a
single-threaded HTTP server one such request takes the whole service down and
the launchd job still reports healthy.

So: every call goes through `run_osascript(script, timeout=...)`, the server is
threaded, and the osascript calls are serialised behind a lock that is itself
acquired *with a timeout* — otherwise a 2-second poll against a hung Music.app
just grows an unbounded queue of threads, which is the same outage with more
steps.

Three answers, not two
----------------------
The organising principle of this repo, applied to a music widget: **"I cannot
tell" and "nothing is playing" are different states and the UI must be able to
tell them apart.**

The Rust version cannot. `music_get_state` returns the identical `default`
struct — `playing: false, track: "", volume: 50` — for *all* of: the trusted
webview check failing, Music.app not running, osascript erroring, the script
returning `error:`, player state `stopped`, and a response with too few
fields (`lib.rs:380-457`). Six distinct situations, one indistinguishable
answer, and one of them ("volume: 50") is a fabricated number. So the widget
shows a paused player with a blank title whether Music is closed, hung, or
genuinely stopped.

Here the response carries a single discriminator, `state`:

    playing | paused | stopped     Music answered. This is the truth.
    not-running                    Music.app is not running. Determinate.
    unknown                        We could not find out. `reason` says why.

`unknown` is served with **HTTP 503**, not 200 and not 500. Not 500 because
nothing here is broken; not 200 because a client that only checks
`response.ok` must not be handed a body it will render as "nothing playing".
Unknown fields are `null`, never `0` and never `""` — `position: 0` for "I
could not ask" is a wrong fact, and `position: null` is a true one.

Known `unknown` reasons, all of them observed rather than imagined:

    osascript-timeout            Music.app is hung or mid-dialog
    osascript-not-permitted      TCC has not granted Apple-events access (-1743)
    osascript-failed             some other non-zero exit; stderr is attached
    osascript-missing            /usr/bin/osascript is not there (not a Mac)
    applescript-error            the script's own `on error` branch fired
    unparseable-response         the `||` join did not come back with 10 fields
    busy                         another request is already talking to Music

The `not-permitted` one is not hypothetical: on this machine, with Music.app
running, `osascript -e 'tell application "Music" to player state'` exits 1 with
`Not authorized to send Apple events to Music. (-1743)` until the *parent
process* is granted Automation access in System Settings → Privacy & Security.
A launchd job is a different parent from your terminal, so it needs granting
again. Under the Rust model that state renders as a paused player with a blank
title, forever, with nothing anywhere saying why.

No state file
-------------
Deliberately none. `probe.py` keeps one because it must compare this run to the
last one to spot a blind window; this is a long-lived server whose every answer
is a fresh question to Music.app, and a cached last-known track is precisely
the fake "nothing playing" the section above exists to prevent. The log under
`var/musicd.log` is the only persistence.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, NamedTuple

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

LABEL = "com.trainwatch.musicd"
LOG = ROOT / "var" / "musicd.log"

# 8731: one above the hub's 8730, so the two sit next to each other in
# `lsof -iTCP -sTCP:LISTEN` and in the tailnet notes.
DEFAULT_PORT = 8731

# Absolute path on purpose. A launchd job inherits almost no PATH (the lesson
# probe.py's plist records), and `osascript` resolved from a PATH we do not
# control is a different program from the one we tested.
OSASCRIPT = "/usr/bin/osascript"

# ── timeouts ──────────────────────────────────────────────────────────────
# Generous enough that a busy Music.app is not reported as hung, tight enough
# that a genuinely hung one is noticed inside one poll interval. Measured: a
# cold `music_get_state` on this Mac is 100-300ms (the comment at lib.rs:376
# says the same), so 5s is ~20x headroom.
STATE_TIMEOUT = 5.0
# Transport verbs return as soon as Music accepts the event; they do not wait
# for it to finish changing track.
CONTROL_TIMEOUT = 5.0
# The System Events process check is a different app and is cheap.
RUNNING_TIMEOUT = 3.0
# How long a request will wait for the osascript lock before giving up with
# `busy`. Must be well under the client's poll interval, or a hung Music.app
# turns every poll into a parked thread.
LOCK_TIMEOUT = 2.0
# Per-connection socket timeout, so a client that opens a socket and says
# nothing cannot hold a handler thread open forever.
SOCKET_TIMEOUT = 15.0

GUARD_HEADER = "x-trainwatch"

# ── the AppleScript, ported verbatim ──────────────────────────────────────
# From nexus/src-tauri/src/lib.rs. Copied rather than rewritten: this dialect
# is known to work against a real Music.app, and re-deriving AppleScript from
# the dictionary is exactly how a port introduces bugs you only find at 2am.
# Line references are to that file, which is READ ONLY from here.

# lib.rs:397-399
IS_RUNNING_SCRIPT = r'''tell application "System Events" to (name of processes) contains "Music"'''

# lib.rs:404-435, byte-for-byte.
STATE_SCRIPT = r'''
tell application "Music"
    try
        set playerState to player state as string
        set isPlaying to (playerState is "playing")
        if playerState is "stopped" then
            return "stopped||||||||||"
        end if
        set trackName to name of current track
        set trackArtist to artist of current track
        set trackAlbum to album of current track
        set trackDuration to duration of current track
        set trackPosition to player position
        set isShuffled to shuffle enabled
        set repeatMode to song repeat as string
        set currentVolume to sound volume
        set isLoved to false
        try
            set isLoved to loved of current track
        on error
            try
                set isLoved to favorited of current track
            on error
                set isLoved to false
            end try
        end try
        return (isPlaying as string) & "||" & trackName & "||" & trackArtist & "||" & trackAlbum & "||" & (trackPosition as string) & "||" & (trackDuration as string) & "||" & (isShuffled as string) & "||" & repeatMode & "||" & (currentVolume as string) & "||" & (isLoved as string)
    on error err
        return "error: " & err
    end try
end tell
'''

# The four transport verbs the brief asks for, plus the toggle the Rust
# actually had. `playpause`, `next track` and `previous track` are verbatim
# (lib.rs:576, 583, 590). `play` and `pause` are NOT in the Rust — it only
# shipped the toggle — but they are the same one-line form against the same
# Music dictionary, and a PWA that knows it wants "pause" should not have to
# guess whether a toggle will pause or resume.
#
# No verb interpolates anything. `music_play_playlist` and `music_set_volume`
# in the Rust build their script with `format!` and a caller-supplied string
# (lib.rs:562, 569), which is an AppleScript injection waiting for a playlist
# named `" & (do shell script "...") & "`. None of those verbs are ported here,
# and if they ever are, the argument must not be spliced into the source.
CONTROLS: dict[str, str] = {
    "play": r'''tell application "Music" to play''',
    "pause": r'''tell application "Music" to pause''',
    "playpause": r'''tell application "Music" to playpause''',
    "next": r'''tell application "Music" to next track''',
    "previous": r'''tell application "Music" to previous track''',
}

# One conversation with Music.app at a time. Two osascript processes racing on
# the same app is how you get a dialog, and a dialog is how you get the hang
# this file's timeouts exist for.
_MUSIC_LOCK = threading.Lock()


# ── logging ───────────────────────────────────────────────────────────────


def _log(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{stamp} {line}\n")


# ── the osascript runner (the one seam every test injects) ────────────────


class Osa(NamedTuple):
    """What one `osascript -e` invocation did.

    `ok` is about the *process*, not about Music: a script whose own `on error`
    branch fired still exits 0 and returns `"error: ..."` on stdout, which is
    why `read_state` checks the prefix separately.
    """

    ok: bool
    out: str
    reason: str  # an `unknown` reason key, "" when ok
    detail: str  # stderr or an explanation, for the log and the response


def run_osascript(script: str, timeout: float) -> Osa:
    """Run one AppleScript with a hard deadline. Never raises.

    `timeout` is not optional and has no default, deliberately. The Rust
    original's `Command::output()` has no timeout (lib.rs:364-374) and blocks
    forever against a Music.app that is mid-dialog; making the parameter
    required means a future call site cannot forget it by omission.
    """
    try:
        proc = subprocess.run(  # fixed argv, no shell, nothing interpolated into it
            [OSASCRIPT, "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        # subprocess.run kills the child before re-raising, so we are not
        # leaking an osascript per timeout.
        return Osa(
            False,
            "",
            "osascript-timeout",
            f"osascript did not return within {timeout:g}s — Music.app is hung "
            f"or showing a dialog",
        )
    except FileNotFoundError:
        return Osa(False, "", "osascript-missing", f"{OSASCRIPT} does not exist")
    except OSError as exc:
        return Osa(False, "", "osascript-failed", f"{type(exc).__name__}: {exc}")

    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        return Osa(
            False,
            "",
            "osascript-not-permitted" if is_not_permitted(err) else "osascript-failed",
            err or f"osascript exited {proc.returncode}",
        )

    return Osa(True, (proc.stdout or "").strip(), "", "")


def is_not_permitted(text: str) -> bool:
    """Is this the Automation-access refusal, errAEEventNotPermitted (-1743)?

    Matched two ways because it arrives two ways, and the second was found by
    running this against a real Music.app rather than by reasoning about it:

      * as a non-zero exit with `... (-1743)` on stderr, when the refused
        event is *outside* a `try` block (`osascript -e 'tell application
        "Music" to player state'`);
      * as **exit 0** with `error: Not authorized to send Apple events to
        Music.` on *stdout*, because `STATE_SCRIPT`'s own `on error err`
        (lib.rs:431) catches it first and `err` is the message only — no
        number. A returncode check alone therefore never sees this case, which
        is the one a launchd job actually hits.

    It earns its own reason key rather than folding into `applescript-error`
    because the two call for different actions: this one is fixed in System
    Settings → Privacy & Security → Automation, and nothing in this repo can
    fix it. A widget that says "not authorised" sends you somewhere;
    "applescript error" does not.
    """
    low = text.lower()
    return "-1743" in low or "not authorized to send apple events" in low


def _runner() -> Any:
    """Indirection so `monkeypatch.setattr(musicd, "run_osascript", ...)` works.

    Resolved at call time rather than captured in a default argument: a default
    binds the function object at import, and then a test that replaces the
    module attribute silently patches nothing — which is a test that passes
    while exercising the real `osascript`.
    """
    return run_osascript


# ── reading state ─────────────────────────────────────────────────────────


def _unknown(reason: str, detail: str = "") -> dict[str, Any]:
    """The honest answer. Every field null, because we do not know any of them."""
    return {
        "state": "unknown",
        "reason": reason,
        "detail": detail,
        "playing": None,
        "track": None,
        "artist": None,
        "album": None,
        "position": None,
        "duration": None,
        "shuffle": None,
        "repeat_mode": None,
        "volume": None,
        "loved": None,
        "at": time.time(),
    }


def _blank(state: str) -> dict[str, Any]:
    """A determinate answer with no track: `not-running` or `stopped`.

    Shares no shape with `_unknown` beyond the key set — the `state` field is
    what distinguishes them, and it is the only field a caller should branch
    on. Note `volume: None`: the Rust's `default` says `volume: 50` here
    (lib.rs:389), which is a number nobody measured.
    """
    return {
        "state": state,
        "reason": None,
        "detail": "",
        "playing": False,
        "track": None,
        "artist": None,
        "album": None,
        "position": None,
        "duration": None,
        "shuffle": None,
        "repeat_mode": None,
        "volume": None,
        "loved": None,
        "at": time.time(),
    }


def _num(raw: str, cast: Any) -> Any:
    """Parse a number, or admit we could not. Never substitutes a zero.

    The Rust does `.parse().unwrap_or(0.0)` (lib.rs:464-468), so an
    unparseable position becomes a playhead at the start of the track and a
    scrubber that jumps there. `None` renders as an unknown playhead, which is
    what it is.
    """
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return None


def probe_running() -> tuple[bool | None, Osa]:
    """(is it running?, why we think so). None means we could not find out.

    The three-valued answer is the whole point. A `bool` here would force the
    caller to pick a lie when System Events is itself unreachable, and the lie
    it would pick is "not running" — indistinguishable from the real thing.

    The `Osa` is returned alongside because the *reason* has to survive. An
    earlier version threw it away and reported every liveness failure as
    `osascript-failed`, so a Music.app hung badly enough to time out the
    System Events check was diagnosed as a generic error — losing the one
    detail that says "it is hung" rather than "it is broken". A test caught
    that, which is the only reason this returns a tuple.
    """
    res = _runner()(IS_RUNNING_SCRIPT, RUNNING_TIMEOUT)
    if not res.ok:
        return None, res
    out = res.out.strip().lower()
    if out == "true":
        return True, res
    if out == "false":
        return False, res
    return None, Osa(
        False,
        res.out,
        "unparseable-response",
        f"System Events answered {res.out!r}, which is neither true nor false",
    )


def read_state() -> dict[str, Any]:
    """Ask Music what it is doing. Returns one of the five `state` values."""
    running, probe = probe_running()
    if running is None:
        # We could not even ask System Events. Reporting "not running" here is
        # the single most tempting mistake in this file. The probe's own reason
        # is carried through so a hang still reads as a hang.
        return _unknown(
            probe.reason or "osascript-failed",
            probe.detail or "could not determine whether Music.app is running",
        )
    if running is False:
        return _blank("not-running")

    res = _runner()(STATE_SCRIPT, STATE_TIMEOUT)
    if not res.ok:
        return _unknown(res.reason, res.detail)

    out = res.out
    # The script's own error branch (lib.rs:431-433) exits 0 and returns this
    # on stdout, so a returncode check alone would treat it as a good answer.
    if out.startswith("error:"):
        detail = out[len("error:") :].strip()
        # Exit 0, an error on stdout. `is_not_permitted` explains why the
        # Automation refusal has to be re-checked here as well as on stderr.
        return _unknown(
            "osascript-not-permitted" if is_not_permitted(detail) else "applescript-error",
            detail,
        )

    # Checked before splitting, because the sentinel (lib.rs:410) is
    # `"stopped"` followed by ten bare pipes and does not split into 10 fields.
    if out.startswith("stopped"):
        return _blank("stopped")

    parts = out.split("||")
    # `!= 10`, not `< 10`. The Rust accepts any length >= 10 (lib.rs:455) and
    # then indexes positionally, so a track whose title contains "||" shifts
    # every subsequent field by one and the widget shows an album where the
    # artist should be — wrong data presented as right. Refusing to guess
    # costs us a real-but-unparseable track rendering as `unknown`, which is
    # the correct trade for this project.
    if len(parts) != 10:
        return _unknown(
            "unparseable-response",
            f"expected 10 ||-joined fields, got {len(parts)}",
        )

    playing = parts[0] == "true"
    return {
        # `player state` itself is not in the payload the script returns — it
        # returns the `isPlaying` boolean and the stopped sentinel — so paused
        # is derived. Consistent with the script, and the Rust threw this away
        # entirely by keeping only `playing: bool`.
        "state": "playing" if playing else "paused",
        "reason": None,
        "detail": "",
        "playing": playing,
        "track": parts[1],
        "artist": parts[2],
        "album": parts[3],
        "position": _num(parts[4], float),
        "duration": _num(parts[5], float),
        "shuffle": parts[6] == "true",
        "repeat_mode": parts[7],
        "volume": _num(parts[8], int),
        "loved": parts[9] == "true",
        "at": time.time(),
    }


def send_control(verb: str) -> dict[str, Any]:
    """Run one transport verb. Same three-valued honesty as `read_state`."""
    script = CONTROLS.get(verb)
    if script is None:
        raise KeyError(verb)

    running, probe = probe_running()
    if running is None:
        return {"state": "unknown", "reason": probe.reason or "osascript-failed", "verb": verb,
                "detail": probe.detail or "could not determine whether Music.app is running",
                "at": time.time()}
    if running is False:
        # Not an error and not a success. `open -a Music` is deliberately not
        # done for you: a POST that launches an application is a bigger
        # authority than a POST that skips a track, and nothing over an
        # unauthenticated port should hold it.
        return {"state": "not-running", "reason": None, "verb": verb,
                "detail": "Music.app is not running; nothing was sent",
                "at": time.time()}

    res = _runner()(script, CONTROL_TIMEOUT)
    if not res.ok:
        return {"state": "unknown", "reason": res.reason, "verb": verb,
                "detail": res.detail, "at": time.time()}
    # Deliberately does NOT read state back. Music.app has not settled a
    # moment after `next track` — it reports the outgoing track — so a state
    # echoed here would be stale in a way the client cannot detect. The client
    # re-polls.
    return {"state": "ok", "reason": None, "verb": verb, "detail": "", "at": time.time()}


def http_status(payload: dict[str, Any]) -> int:
    """503 for `unknown`, 200 for every determinate answer.

    Not 500: nothing in this service is broken when Music.app is hung. Not
    200: a client that checks only `response.ok` must not receive a body it
    will render as a stopped player. 503 is the one code that means exactly
    "ask me again", and it is the difference between a widget that says "can't
    reach Music" and one that says "nothing playing" while lying.
    """
    return 503 if payload.get("state") == "unknown" else 200


# ── where to bind ─────────────────────────────────────────────────────────

WILDCARD = "0.0.0.0"  # named so it can be refused by name, never bound
ANY_INTERFACE_ENV = "MUSICD_ALLOW_ANY_INTERFACE"


def _tailnet_ipv4() -> str:
    """This machine's tailnet IPv4, or "" if tailscale cannot say.

    Best-effort and never raises: the caller's fallback (loopback) is safe, so
    a failure here must not be fatal.
    """
    if not shutil.which("tailscale"):
        return ""
    try:
        proc = subprocess.run(  # absolute path from shutil.which, fixed argv, no shell
            [shutil.which("tailscale") or "tailscale", "ip", "-4"],
            capture_output=True,
            text=True,
            timeout=5.0,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if proc.returncode != 0:
        return ""
    for line in proc.stdout.splitlines():
        if ip := line.strip():
            return ip
    return ""


def resolve_bind(explicit: str = "") -> tuple[str, str]:
    """(host, why). Never returns the wildcard without an explicit override.

    Order: `--bind` / `MUSICD_BIND`, then the tailnet IPv4, then loopback.
    Loopback last because it is the safest and does not work from the iPad;
    the tailnet IP is the safest thing that does, which is the rule stated in
    the module docstring. The wildcard is not in the order at all.
    """
    want = (explicit or os.environ.get("MUSICD_BIND", "")).strip()
    if want:
        if want == WILDCARD or want == "::":
            if os.environ.get(ANY_INTERFACE_ENV) != "1":
                raise SystemExit(
                    f"refusing to bind {want}: this service is unauthenticated and "
                    f"controls Music.app on this Mac, and the wildcard binds every "
                    f"interface — café wifi, hotel LAN, anything bridged later.\n"
                    f"Bind the tailnet address instead (the default), or set "
                    f"{ANY_INTERFACE_ENV}=1 if you have a reason and have written "
                    f"it down."
                )
            return want, f"wildcard, forced by {ANY_INTERFACE_ENV}=1"
        return want, "explicitly requested"

    if ip := _tailnet_ipv4():
        return ip, "this machine's tailnet IPv4 (tailscale ip -4)"

    # Fails closed: unreachable from other devices rather than reachable from
    # everything. The message says so, because a service that silently stops
    # being reachable is a bug report about the PWA.
    return (
        "127.0.0.1",
        "loopback — tailscale did not report an address, so nothing off this "
        "Mac can reach it",
    )


def allowed_hosts(bind: str) -> set[str]:
    """The `Host` allowlist. ADR-0003 C1, borrowed rather than reinvented.

    `resolve_allowed_hosts` in `src/trainwatch/security.py` already derives
    localhost plus this machine's tailnet IPs and MagicDNS names, and it is
    stdlib-only. Importing it means the hub and this service agree by
    construction; two hand-maintained allowlists would be one allowlist that
    is wrong the first time an address changes.

    If the import fails (running this file outside the repo), the fallback is
    localhost plus the address we actually bound — closed, not open.
    """
    hosts = {"localhost", "127.0.0.1", "::1", "[::1]", bind.lower()}
    if ":" in bind:
        hosts.add(f"[{bind.lower()}]")
    try:
        from src.trainwatch.security import resolve_allowed_hosts

        hosts |= resolve_allowed_hosts(os.environ.get("MUSICD_ALLOWED_HOSTS", ""))
    except Exception as exc:  # broad on purpose -- see below
        # Broad on purpose: a failure to import the hub's helper must degrade
        # to a tighter allowlist, never take the service down. The fallback is
        # strictly more restrictive, so failing here cannot open anything.
        _log(f"could not import resolve_allowed_hosts ({exc}) — localhost + {bind} only")
        for extra in os.environ.get("MUSICD_ALLOWED_HOSTS", "").replace(",", " ").split():
            hosts.add(extra.strip().lower())
    return {h for h in hosts if h}


def host_only(value: str) -> str:
    """Strip the port from a Host header, keeping IPv6 brackets intact.

    Same shape as `security.py:_host_only`, and for the same reason: an
    unbracketed IPv6 authority is malformed and must resolve to "" so the
    caller rejects it rather than matching a prefix.
    """
    v = value.strip().lower()
    if not v:
        return ""
    if v.startswith("["):
        end = v.find("]")
        return v[: end + 1] if end != -1 else v
    return v.split(":", 1)[0]


# ── HTTP ──────────────────────────────────────────────────────────────────

# GET routes. Mutating verbs are deliberately absent from this map: adding one
# here is the mistake the 405 test exists to catch.
READ_PATHS = frozenset({"/api/music", "/api/music/state", "/healthz"})


@contextlib.contextmanager
def _talking_to_music() -> Iterator[bool]:
    """Serialise osascript, but never queue. Yields False if it gave up.

    Without the timeout this is where a hung Music.app becomes an outage: a
    2-second poll from the widget against a call that never returns parks one
    thread per poll until the process dies of it. Giving up after
    `LOCK_TIMEOUT` turns that into a stream of honest `busy` answers.
    """
    got = _MUSIC_LOCK.acquire(timeout=LOCK_TIMEOUT)
    try:
        yield got
    finally:
        if got:
            _MUSIC_LOCK.release()


class MusicHandler(BaseHTTPRequestHandler):
    """Four endpoints. Reads on GET, transport on POST, nothing else."""

    server_version = "musicd/1"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = SOCKET_TIMEOUT

    # Set by `make_server`. A class attribute rather than a global so a test
    # can stand up two handlers with different allowlists.
    hosts: frozenset[str] = frozenset()

    def log_message(self, fmt: str, *args: Any) -> None:
        # Into var/musicd.log, not stderr: under launchd stderr is the same
        # file anyway, and routing through `_log` keeps one timestamp format.
        _log(f"{self.address_string()} {fmt % args}")

    # ── guards ───────────────────────────────────────────────────────────

    def _guard(self) -> bool:
        """ADR-0003 C1/C2 on every request. False means already answered."""
        host = host_only(self.headers.get("Host", ""))
        # Absent or malformed is rejected, not waved through. `security.py`
        # notes that `if host and ...` let any non-browser client skip C1
        # entirely by omitting the header; the same hole is available here.
        if not host or host not in self.hosts:
            self._json(
                421,
                {
                    "error": "unrecognised Host header",
                    "got": host,
                    "allowed": sorted(self.hosts),
                    "why": (
                        "This blocks DNS rebinding (ADR-0003 C1) — a web page you "
                        "visit can otherwise reach this port and control Music. "
                        "Add a legitimate new name to MUSICD_ALLOWED_HOSTS."
                    ),
                },
            )
            return False

        # C2. A browser attaches a truthful Origin to every cross-origin
        # request and to every non-GET, and JS cannot forge it. Absent Origin
        # means a non-browser client, which is not subject to CSRF.
        origin = self.headers.get("Origin", "")
        if origin:
            o = origin.strip()
            authority = o.split("://", 1)[1] if "://" in o else o
            if host_only(authority) not in self.hosts:
                self._json(403, {"error": "cross-origin request refused", "origin": origin})
                return False
        return True

    # ── responses ────────────────────────────────────────────────────────

    def _json(self, status: int, payload: dict[str, Any], extra: dict[str, str] | None = None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # No Access-Control-Allow-* header, ever (ADR-0003 C4): without one the
        # browser withholds the body from any other origin, which is half of
        # what keeps a random web page from reading your listening history.
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    # ── verbs ────────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # the name is BaseHTTPRequestHandler's contract
        if not self._guard():
            return
        path = self.path.split("?", 1)[0].rstrip("/") or "/"

        if path == "/healthz":
            # Liveness of THIS service only. It deliberately does not touch
            # Music.app: a health check that shells out is a health check that
            # can hang, and a 200 here must never be read as "music works" —
            # that question has its own endpoint and its own three answers.
            self._json(200, {"ok": True, "service": "musicd", "checks_music": False,
                             "at": time.time()})
            return

        if path in READ_PATHS:
            with _talking_to_music() as got:
                payload = read_state() if got else _unknown(
                    "busy", f"another request held Music for more than {LOCK_TIMEOUT:g}s"
                )
            self._json(http_status(payload), payload)
            return

        if path.lstrip("/") in CONTROLS or path.split("/")[-1] in CONTROLS:
            # The whole reason this branch is spelled out instead of falling
            # through to 404: a mutation behind GET is one that a link
            # preview, an <img src>, a prefetch or Safari's speculative loader
            # can fire without anybody clicking anything. Say 405 and name the
            # method, so the client's bug is obvious rather than mysterious.
            self._json(
                405,
                {"error": "this endpoint mutates; use POST",
                 "why": "a GET can be triggered by a link, a prefetch or an <img src>"},
                extra={"Allow": "POST"},
            )
            return

        self._json(404, {"error": "no such endpoint",
                         "read": sorted(READ_PATHS),
                         "write": [f"POST /api/music/{v}" for v in sorted(CONTROLS)]})

    def do_POST(self) -> None:  # the name is BaseHTTPRequestHandler's contract
        if not self._guard():
            return

        # Drain the body before answering. A request body left unread on a
        # keep-alive connection is parsed as the start of the next request.
        with contextlib.suppress(ValueError):
            if length := int(self.headers.get("Content-Length", 0) or 0):
                self.rfile.read(min(length, 64_000))

        # ADR-0003 C3, checked BEFORE routing. A custom header makes the
        # request non-simple, so a browser must preflight it, and this service
        # answers no preflight — so cross-origin JS never gets to send the real
        # POST. Belt to C2's braces, and the belt is what holds when Origin is
        # absent.
        #
        # Before routing specifically: a security check that runs after "is
        # this a route I recognise" is one that a route added later can end up
        # in front of. Nothing reaches the dispatcher unguarded.
        if GUARD_HEADER not in {k.lower() for k in self.headers}:
            self._json(403, {"error": f"missing {GUARD_HEADER} header",
                             "why": "Required on writes so browsers must preflight "
                                    "(ADR-0003 C3)."})
            return

        path = self.path.split("?", 1)[0].rstrip("/")
        verb = path.rsplit("/", 1)[-1]
        if verb not in CONTROLS or not path.startswith("/api/music/"):
            self._json(404, {"error": "no such control",
                             "write": [f"POST /api/music/{v}" for v in sorted(CONTROLS)]})
            return

        with _talking_to_music() as got:
            payload = send_control(verb) if got else {
                "state": "unknown", "reason": "busy", "verb": verb,
                "detail": f"another request held Music for more than {LOCK_TIMEOUT:g}s",
                "at": time.time(),
            }
        self._json(http_status(payload), payload)

    def do_OPTIONS(self) -> None:  # the name is BaseHTTPRequestHandler's contract
        # Guarded like everything else, so the Host allowlist is genuinely
        # universal rather than "universal except the one method nobody
        # thought about".
        if not self._guard():
            return
        # Refused rather than answered. Never emitting Access-Control-Allow-*
        # is what keeps other origins out (ADR-0003 C4); answering a preflight
        # politely would undo C3.
        self._json(403, {"error": "CORS is not enabled on this service"})


def make_server(bind: str, port: int) -> ThreadingHTTPServer:
    """Threaded on purpose.

    `HTTPServer` is single-threaded: one request blocked in osascript stops
    every other request, including `/healthz`, so the service would look dead
    to a monitor while the process was fine. Threads plus `_talking_to_music`
    bound the damage to one slow answer instead of an outage.
    """

    class Handler(MusicHandler):
        hosts = frozenset(allowed_hosts(bind))

    httpd = ThreadingHTTPServer((bind, port), Handler)
    httpd.daemon_threads = True
    return httpd


# ── entry points ──────────────────────────────────────────────────────────


def serve(bind: str, port: int) -> int:
    host, why = resolve_bind(bind)
    httpd = make_server(host, port)
    listed = ", ".join(sorted(httpd.RequestHandlerClass.hosts))  # type: ignore[attr-defined]
    _log(f"serving on http://{host}:{port} ({why}); Host allowlist: {listed}")
    print(f"musicd on http://{host}:{port}")
    print(f"  bind          {host}  — {why}")
    print(f"  Host allowed  {listed}")
    print(f"  log           {LOG}")
    print("  read          GET  /api/music        (200 playing|paused|stopped|not-running,")
    print("                                        503 unknown — see `reason`)")
    for verb in sorted(CONTROLS):
        print(f"  write         POST /api/music/{verb:<10} (requires {GUARD_HEADER}: 1)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        httpd.shutdown()
        httpd.server_close()
        _log("stopped")
    return 0


def once() -> int:
    """Ask once and print the JSON. Exit code mirrors the HTTP status.

    0 for any determinate answer including `not-running`, 1 for `unknown` —
    so a shell caller gets the same three-way distinction the HTTP client does
    rather than having to parse for it.
    """
    payload = read_state()
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 1 if payload["state"] == "unknown" else 0


def where(bind: str) -> int:
    host, why = resolve_bind(bind)
    print(f"bind:    {host}")
    print(f"because: {why}")
    print(f"Host allowlist: {', '.join(sorted(allowed_hosts(host)))}")
    print(f"\nNever {WILDCARD}: unauthenticated, controls Music.app, and the wildcard "
          f"binds every interface. Set {ANY_INTERFACE_ENV}=1 to override, having "
          f"written down why.")
    return 0


def install(bind: str, port: int) -> int:
    """PRINT the plist. Writes nothing, loads nothing.

    `probe.py` writes and bootstraps its own plist; this one does not, because
    two things here need a human: the bind address depends on tailscale being
    up at load time, and Music.app automation access has to be granted to this
    *specific* parent process in System Settings. An installer that guessed
    either would produce a job that runs and cannot talk to Music — which is
    the inert-control failure this whole file exists to remove, reintroduced
    by the installer.
    """
    host, why = resolve_bind(bind)
    plist: dict[str, Any] = {
        "Label": LABEL,
        "ProgramArguments": [
            sys.executable,
            str(Path(__file__).resolve()),
            "--serve",
            "--bind",
            host,
            "--port",
            str(port),
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "WorkingDirectory": str(ROOT),
        "StandardOutPath": str(LOG),
        "StandardErrorPath": str(LOG),
        "ProcessType": "Interactive",
        "EnvironmentVariables": {
            # A launchd job inherits almost nothing — probe.py's plist carries
            # the same note. osascript is called by absolute path regardless,
            # but `tailscale` is resolved via PATH.
            "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "MUSICD_BIND": host,
        },
    }
    print(f"# ── ~/Library/LaunchAgents/{LABEL}.plist ──")
    print(f"# bind {host} — {why}")
    print(plistlib.dumps(plist).decode("utf-8"))
    print(
        f"""# ── install ──
cat > ~/Library/LaunchAgents/{LABEL}.plist <<'PLIST'
# (paste the plist above)
PLIST
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/{LABEL}.plist

# ── ProcessType: Interactive, not Background ──
# A Background job is throttled by App Nap and is not in a GUI session, and
# Apple events to Music.app need one. A Background musicd answers HTTP and
# reports `unknown / osascript-not-permitted` for every request.

# ── the part that is not optional ──
# Automation access is granted per PARENT process, so granting it to your
# terminal grants nothing to this job. The first Apple event from the launchd
# job raises its own prompt; if you miss it, or it was ever denied:
#
#   System Settings → Privacy & Security → Automation → (this job) → Music
#   tccutil reset AppleEvents      # nuclear: re-prompts everything
#
# Verify by demonstration, which is the only way this counts:
#
#   curl -sS -H 'Host: {host}' http://{host}:{port}/api/music | python3 -m json.tool
#     → state must be playing|paused|stopped|not-running.
#       `unknown` with reason osascript-not-permitted means the grant is missing;
#       that is this service working correctly and telling you so.
#
#   curl -sS -o /dev/null -w '%{{http_code}}\\n' http://{host}:{port}/api/music/next
#     → 405. A mutation must not be reachable by GET.
#
#   curl -sS -X POST -H 'Host: {host}' -H '{GUARD_HEADER}: 1' \\
#        http://{host}:{port}/api/music/next
#     → the track changes.
#
#   quit Music.app, then repeat the first curl
#     → state must be "not-running", NOT "stopped". If those two ever look the
#       same, the widget is back to rendering a dead control as a live one,
#       which is the entire reason this file exists."""
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Separate from `main` so a test can inspect the verbs without running one.

    The thing worth inspecting is that `--serve` exists as an explicit verb:
    see `main`'s closing comment for why no-argument invocation must not bind.
    """
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--once", action="store_true", help="ask Music once, print JSON, exit")
    ap.add_argument("--serve", action="store_true", help="bind and serve (the launchd entry point)")
    ap.add_argument("--install", action="store_true", help="PRINT the launchd plist")
    ap.add_argument("--where", action="store_true", help="show the bind address and why")
    ap.add_argument("--bind", default="", help=f"override the bind address (never {WILDCARD})")
    ap.add_argument(
        "--port", type=int, default=int(os.environ.get("MUSICD_PORT", DEFAULT_PORT)),
        help=f"default {DEFAULT_PORT}",
    )
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.install:
        return install(args.bind, args.port)
    if args.where:
        return where(args.bind)
    if args.serve:
        return serve(args.bind, args.port)
    # `--once` is the default rather than `--serve`. Opening an unauthenticated
    # control port must be something you asked for, not something you get by
    # running a script with no arguments.
    return once()


if __name__ == "__main__":
    raise SystemExit(main())
