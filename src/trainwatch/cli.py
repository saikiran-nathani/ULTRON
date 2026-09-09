"""`trainwatch` command line. argparse only — the core stays dependency-free."""

from __future__ import annotations

import argparse
import getpass
import logging
import math
import os
import pathlib
import platform
import random
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import __version__, backup
from .auth import Auth
from .client import HubClient, HubError, os_clipboard_read, os_clipboard_write
from .config import Config, load_config
from .curriculum import Curriculum
from .gpu import nvidia_smi_available, sample_gpus
from .heartbeat import read_heartbeat
from .liveness import check_liveness
from .notify import Notifier
from .progress import render_status, seed_from_yaml
from .store import Store

# ── tiny ANSI helpers (no dependency on rich/colorama) ───────────────────

_TTY = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _TTY else text


def dim(t: str) -> str:
    return _c("2", t)


def bold(t: str) -> str:
    return _c("1", t)


def green(t: str) -> str:
    return _c("32", t)


def yellow(t: str) -> str:
    return _c("33", t)


def red(t: str) -> str:
    return _c("31", t)


def cyan(t: str) -> str:
    return _c("36", t)


OK, WARN, FAIL = green("  ok  "), yellow(" warn "), red(" fail ")


# ── commands ─────────────────────────────────────────────────────────────


def cmd_serve(args: argparse.Namespace, cfg: Config) -> int:
    try:
        import uvicorn
    except ImportError:
        print(red("The server extra is not installed."))
        print("  uv pip install -r requirements/mac.txt   (fastapi + uvicorn live there)")
        return 2

    from .server.app import create_app

    host, port = args.host or cfg.host, args.port or cfg.port
    print(
        f"{bold('trainwatch')} {dim(__version__)}  ·  dashboard on {cyan(f'http://{host}:{port}')}"
    )
    for addr in _tailscale_ips():
        print(f"  from the iPad: {cyan(f'http://{addr}:{port}')}")
    if host in ("0.0.0.0", "::"):  # noqa: S104 - comparison, not a bind
        print(dim("  bound to all interfaces — safe only because Tailscale is the"))
        print(dim("  network boundary. Do not port-forward this."))

    uvicorn.run(
        create_app(cfg),
        host=host,
        port=port,
        log_level="warning" if not args.verbose else "info",
        access_log=args.verbose,
    )
    return 0


def cmd_liveness(args: argparse.Namespace, cfg: Config) -> int:
    result = check_liveness(cfg)
    icon = {"ok": OK, "idle": dim(" idle "), "dead": FAIL}.get(result.status, WARN)
    if not args.quiet or not result.healthy:
        print(f"[{icon}] {result.message}")
        if result.notified:
            print(dim("       alert pushed"))
    return result.exit_code


def cmd_gpu(_args: argparse.Namespace, _cfg: Config) -> int:
    samples = sample_gpus()
    if not samples:
        print(red("no GPU samples — nvidia-smi unavailable or returned nothing"))
        if not nvidia_smi_available():
            print(dim("  nvidia-smi is not on PATH. On WSL2: export PATH=$PATH:/usr/lib/wsl/lib"))
        return 1
    for s in samples:
        thr = s["throttle"] or "-"
        print(
            f"  gpu{s['gpu_index']} {bold(s['name'])}\n"
            f"    util {_fmt(s['util'], '%')}   temp {_fmt(s['temp'], 'C')}   "
            f"power {_fmt(s['power'], 'W')}   sm {_fmt(s['clock_sm'], 'MHz')}\n"
            f"    mem  {_fmt(s['mem_used'], 'MiB')} / {_fmt(s['mem_total'], 'MiB')}   "
            f"throttle {(red(thr) if s['throttle'] else dim(thr))}"
        )
    return 0


def cmd_prune(args: argparse.Namespace, cfg: Config) -> int:
    with Store(cfg.db_path) as store:
        before = cfg.db_path.stat().st_size if cfg.db_path.exists() else 0
        deleted = store.prune(keep_days=args.days)
    after = cfg.db_path.stat().st_size if cfg.db_path.exists() else 0
    print(f"pruned {deleted} rows older than {args.days} days")
    print(dim(f"  {_bytes(before)} → {_bytes(after)}"))
    return 0


def _git_sha() -> str:
    """Short HEAD sha, or empty. Evidence is worth much less undated and unpinned."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607 - PATH lookup is fine here
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def cmd_user(args: argparse.Namespace, cfg: Config) -> int:
    """Create, re-password or disable the human account. ADR-0004 C7-C9."""
    with Auth(cfg.db_path) as auth:
        if args.action in {"add", "passwd"}:
            # getpass, never argv: a password on the command line lands in the
            # shell history and in `ps` output for every user on the box.
            pw = getpass.getpass("password (min 12 chars): ")
            if pw != getpass.getpass("again: "):
                print(red("passwords do not match"))
                return 2
            try:
                if args.action == "add":
                    auth.create_user(args.name, pw, role=args.role)
                    print(f"created {cyan(args.name)} ({args.role})")
                else:
                    auth.set_password(args.name, pw)
                    print(f"password changed for {cyan(args.name)}")
                    print(dim("  every live session for this account was revoked"))
            except (ValueError, KeyError) as exc:
                print(red(str(exc)))
                return 2
            except sqlite3.IntegrityError:
                print(red(f"user {args.name!r} already exists"))
                return 2
            return 0

        try:
            auth.disable_user(args.name)
        except KeyError as exc:
            print(red(str(exc)))
            return 2
        print(f"disabled {cyan(args.name)}; sessions revoked")
        return 0


def cmd_token(args: argparse.Namespace, cfg: Config) -> int:
    """Machine identities. ADR-0004 C10."""
    with Auth(cfg.db_path) as auth:
        if args.action == "list":
            rows = auth.tokens()
            if not rows:
                print(dim("no tokens"))
                return 0
            for r in rows:
                state = red("revoked") if r["revoked_at"] else green("live")
                used = _ago(r["last_used"]) if r["last_used"] else dim("never used")
                print(f"  {r['name']:<18} {state:<18} {r['scopes'] or '-':<24} {used}")
            return 0

        if args.action == "revoke":
            try:
                auth.revoke_token(args.name)
            except KeyError as exc:
                print(red(str(exc)))
                return 2
            print(f"revoked {cyan(args.name)}")
            return 0

        scopes = {s.strip() for s in args.scopes.split(",") if s.strip()}
        if not scopes:
            print(red("--scopes is required, e.g. --scopes telemetry:write"))
            return 2
        try:
            grant = auth.create_token(
                args.name, scopes, ttl=args.ttl * 86400 if args.ttl else None
            )
        except sqlite3.IntegrityError:
            print(red(f"a token named {args.name!r} already exists"))
            return 2
        print(f"token for {cyan(args.name)}  scopes={','.join(sorted(scopes))}")
        print()
        print(f"  {grant.secret}")
        print()
        print(dim("  Shown once. Only its SHA-256 is stored, so this cannot be recovered."))
        print(dim("  Put it in the client's .env as TRAINWATCH_TOKEN."))
        return 0


def cmd_audit(args: argparse.Namespace, cfg: Config) -> int:
    """Read the audit log, or verify its hash chain. ADR-0004 C11."""
    with Auth(cfg.db_path) as auth:
        if args.verify:
            ok, why = auth.verify_chain()
            print(f"{green('chain intact') if ok else red('CHAIN BROKEN')} — {why}")
            if not ok:
                print(dim("  A row was edited, deleted or reordered after it was written."))
            return 0 if ok else 1
        rows = auth.audit(limit=args.limit)
        if not rows:
            print(dim("nothing recorded yet"))
            return 0
        for r in reversed(rows):
            target = f" → {r['target']}" if r["target"] else ""
            print(f"  {_ago(r['ts']):>12}  {r['actor_kind']:<7} {r['actor_id']:<10} "
                  f"{r['action']}{target}")
        return 0


def cmd_curriculum(args: argparse.Namespace, cfg: Config) -> int:
    """Seed, inspect, record and render curriculum progress. ADR-0004 phase C.

    Replaces hand-editing `TUF/STATUS.md`. Statuses are derived from gate
    evidence, so the way to change one is to record a result.
    """
    with Curriculum(cfg.db_path) as cur:
        if args.seed:
            counts = seed_from_yaml(args.seed, cur)
            print("seeded " + "  ".join(f"{k}={v}" for k, v in counts.items()))
            return 0

        if args.record:
            try:
                phase_slug, gate_slug = args.record.split("/", 1)
            except ValueError:
                print(red("--pass/--fail take PHASE/GATE, e.g. sandbox/adversarial-suite"))
                return 2
            try:
                cur.record_gate(
                    phase_slug, gate_slug,
                    passed=args.passed,
                    evidence=args.evidence,
                    machine=args.machine or platform.node(),
                    commit_sha=_git_sha(),
                )
            except KeyError as exc:
                print(red(str(exc)))
                return 2
            verb = green("pass") if args.passed else red("FAIL")
            print(f"recorded {verb}  {phase_slug}/{gate_slug}")
            return 0

        drifted = cur.drift()
        if args.drift:
            # Exit non-zero so this can gate CI: a record that has run ahead of
            # its evidence should fail a build, not print a warning nobody sees.
            if not drifted:
                print(green("no drift"))
                return 0
            for item in drifted:
                how = red("overclaimed") if item.overclaimed else dim("understated")
                print(f"  {item.slug}: declared {item.declared}, evidence says "
                      f"{item.derived}  [{how}]")
            return 1

        text = render_status(cur)
        if args.write:
            out = pathlib.Path(args.write)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text)
            print(f"wrote {cyan(str(out))}  ({len(text.splitlines())} lines)")
            if drifted:
                print(red(f"  {len(drifted)} phase(s) drifting — see the file"))
        else:
            print(text)
        return 0


def cmd_backup(args: argparse.Namespace, cfg: Config) -> int:
    """Snapshot, verify, list or restore the system-of-record database.

    ADR-0004 C13. `snapshot` is the scheduled path; `--restore` is the one you
    run at 2am, so it prints exactly what it did and never deletes anything.
    """
    snap_dir = cfg.db_path.parent / "snapshots"

    if args.list:
        found = sorted(snap_dir.glob(backup.SNAP_GLOB), reverse=True)
        if not found:
            print(dim(f"no snapshots in {snap_dir}"))
            return 0
        for path in found:
            verdict = backup.integrity(path)
            mark = green("ok") if verdict == "ok" else red(verdict)
            print(f"  {path.name}  {_bytes(path.stat().st_size):>10}  {mark}")
        return 0

    if args.verify:
        target = pathlib.Path(args.verify)
        verdict = backup.integrity(target)
        print(f"{target}: {green('ok') if verdict == 'ok' else red(verdict)}")
        return 0 if verdict == "ok" else 1

    if args.restore:
        src: pathlib.Path | None = (
            pathlib.Path(args.restore) if args.restore != "latest" else backup.latest(snap_dir)
        )
        if src is None:
            print(red(f"no snapshots in {snap_dir} to restore from"))
            return 2
        try:
            aside = backup.restore(src, cfg.db_path)
        except ValueError as exc:
            print(red(str(exc)))
            return 1
        print(f"restored {cyan(src.name)} → {cfg.db_path}")
        print(dim(f"  previous file kept at {aside.name} — delete it once you are happy"))
        print(dim("  restart `trainwatch serve`: it holds an open handle to the old file"))
        return 0

    # default: take one
    try:
        snap = backup.snapshot(cfg.db_path, snap_dir)
    except FileExistsError as exc:
        print(dim(f"a snapshot for this second already exists: {exc}"))
        return 0
    verdict = backup.integrity(snap)
    print(f"snapshot {cyan(snap.name)}  {_bytes(snap.stat().st_size)}  "
          f"{green('ok') if verdict == 'ok' else red(verdict)}")
    dropped = backup.prune_snapshots(snap_dir, hourly=args.hourly, daily=args.daily)
    if dropped:
        print(dim(f"  pruned {len(dropped)} old snapshot(s)"))
    return 0 if verdict == "ok" else 1


def cmd_tensorboard(args: argparse.Namespace, cfg: Config) -> int:
    """Launch TensorBoard bound so the iPad can actually reach it."""
    if shutil.which("tensorboard") is None:
        print(red("tensorboard is not installed:  uv pip install -e '.[tb]'"))
        return 2
    logdir = str(args.logdir or cfg.tensorboard_dir)
    port = str(args.port or 6006)
    print(f"tensorboard  ·  logdir={logdir}")
    for addr in _tailscale_ips():
        print(f"  from the iPad: {cyan(f'http://{addr}:{port}')}")
    print(dim("  --host 0.0.0.0 is required; bound to 127.0.0.1 the page is blank remotely."))
    cmd = ["tensorboard", "--logdir", logdir, "--host", "0.0.0.0", "--port", port]  # noqa: S104
    return subprocess.call(cmd)  # noqa: S603 - fixed argv, no shell


def cmd_doctor(args: argparse.Namespace, cfg: Config) -> int:
    """Check all four layers and say which one is broken."""
    problems = 0

    def check(layer: str, name: str, state: str, detail: str = "") -> None:
        nonlocal problems
        if state is FAIL:
            problems += 1
        print(f"[{state}] {dim(layer)} {name}" + (f"\n         {dim(detail)}" if detail else ""))

    print(bold(f"\ntrainwatch doctor  {dim(__version__)}\n"))

    # ── Layer 0 · Reach ──────────────────────────────────────────────
    if shutil.which("tailscale") is None:
        check("0 reach  ", "tailscale", FAIL, "not installed — run scripts/tailscale-up.sh")
    else:
        ips = _tailscale_ips()
        if ips:
            check("0 reach  ", "tailscale", OK, f"this machine is {', '.join(ips)}")
        else:
            check(
                "0 reach  ",
                "tailscale",
                FAIL,
                "installed but not connected: sudo tailscale up --ssh",
            )
    print(
        dim("         verify from the iPad over CELLULAR with wifi off — that is the real test\n")
    )

    # ── Layer 1 · Persist ────────────────────────────────────────────
    if shutil.which("tmux") is None:
        check("1 persist", "tmux", FAIL, "not installed — a wifi hiccup will kill your run")
    else:
        sessions = _tmux_sessions()
        check(
            "1 persist",
            "tmux",
            OK,
            f"{len(sessions)} live session(s): {', '.join(sessions)}"
            if sessions
            else "no live sessions",
        )
    if _is_wsl():
        check("1 persist", "runtime", OK, "WSL2 detected — correct for a Windows box")
    elif sys.platform == "win32":
        check(
            "1 persist",
            "runtime",
            FAIL,
            "native Windows: no clean tmux. Use WSL2 with CUDA passthrough.",
        )
    print()

    # ── Layer 2 · Emit ───────────────────────────────────────────────
    try:
        with Store(cfg.db_path) as store:
            runs = store.runs(limit=5)
        check("2 emit   ", "store", OK, f"{cfg.db_path} · {len(runs)} recent run(s)")
    except Exception as exc:  # noqa: BLE001 - doctor reports faults, never adds one
        check("2 emit   ", "store", FAIL, f"{cfg.db_path}: {exc}")

    if nvidia_smi_available():
        gpu_count = len(sample_gpus())
        check(
            "2 emit   ",
            "nvidia-smi",
            OK if gpu_count else WARN,
            f"{gpu_count} GPU(s) visible",
        )
    else:
        check("2 emit   ", "nvidia-smi", WARN, "not on PATH; on WSL2 add /usr/lib/wsl/lib")

    for sink in cfg.sinks:
        if sink == "store":
            continue
        mod = {"tensorboard": "tensorboardX", "tb": "tensorboardX", "wandb": "wandb"}.get(
            sink, sink
        )
        ok = _importable(mod) or (sink in ("tensorboard", "tb") and _importable("torch"))
        check(
            "2 emit   ",
            f"sink:{sink}",
            OK if ok else FAIL,
            "" if ok else f"configured but {mod} is not importable",
        )
    print()

    # ── Layer 3 · Notify ─────────────────────────────────────────────
    if not cfg.notify_enabled:
        check(
            "3 notify ",
            "ntfy topic",
            FAIL,
            "TRAINWATCH_NTFY_TOPIC unset or still the placeholder — see .env.example",
        )
    else:
        masked = cfg.ntfy_topic[:6] + "…" + cfg.ntfy_topic[-3:]
        weak = len(cfg.ntfy_topic) < 16
        check(
            "3 notify ",
            "ntfy topic",
            WARN if weak else OK,
            f"{cfg.ntfy_server}/{masked}"
            + (
                " — short topic; public ntfy topics are readable by anyone who guesses the string"
                if weak
                else ""
            ),
        )
        if args.send_test:
            notifier = Notifier(cfg.ntfy_url, token=cfg.ntfy_token)
            notifier.alert(
                "If you can read this on your iPad, layer 3 works.",
                title="trainwatch test",
                priority="default",
                rule="doctor",
            )
            notifier.close(timeout=10)
            s = notifier.stats()
            check(
                "3 notify ",
                "test push",
                OK if s["sent"] else FAIL,
                f"sent={s['sent']} failed={s['failed']}",
            )

    hb = read_heartbeat(cfg.heartbeat_path)
    if hb is None:
        check(
            "3 notify ",
            "heartbeat",
            WARN,
            f"{cfg.heartbeat_path} not written yet (no run has started)",
        )
    else:
        fresh = hb["age"] < cfg.heartbeat_timeout
        check(
            "3 notify ",
            "heartbeat",
            OK if fresh else WARN,
            f"{hb['age']:.0f}s old (limit {cfg.heartbeat_timeout}s)",
        )

    cron = _cron_has_liveness()
    check(
        "3 notify ",
        "liveness cron",
        OK if cron else FAIL,
        "installed"
        if cron
        else "NOT installed — value alerts cannot fire if nothing is running. Run scripts/install-liveness-cron.sh",
    )
    print()

    # ── Layer 4 · Client ─────────────────────────────────────────────
    static = Path(__file__).parent / "server" / "static" / "index.html"
    check(
        "4 client ",
        "dashboard bundle",
        OK if static.is_file() else FAIL,
        str(static.parent)
        if static.is_file()
        else "not built — cd dashboard && npm ci && npm run build",
    )
    check(
        "4 client ",
        "server extra",
        OK if _importable("fastapi") else FAIL,
        "" if _importable("fastapi") else "uv pip install -e '.[server]'",
    )

    # ── The device hub ───────────────────────────────────────────────
    serve_https = _tailscale_serve_url()
    if serve_https:
        check("hub      ", "https", OK, f"{serve_https} — secure context, clipboard API works")
    else:
        check(
            "hub      ",
            "https",
            WARN,
            "not served over TLS. navigator.clipboard does not exist without it, "
            "so one-tap copy/paste will silently do nothing. Fix: trainwatch share",
        )
    check(
        "hub      ",
        "host allowlist",
        OK,
        f"{len(_allowed_hosts_count())} accepted names (ADR-0003 C1, blocks DNS rebinding)",
    )
    check(
        "hub      ",
        "write token",
        OK if cfg.token else dim(" none "),
        "set" if cfg.token else "open on the tailnet — fine for one person's devices",
    )
    try:
        stats = HubClient(cfg.hub_url, token=cfg.token).hub().get("stats", {})
        check(
            "hub      ",
            "reachable",
            OK,
            f"{stats.get('clips', 0)} clips · {stats.get('files', 0)} files · {stats.get('notes', 0)} notes",
        )
    except HubError:
        check(
            "hub      ", "reachable", WARN, f"no server at {cfg.hub_url} (start `trainwatch serve`)"
        )
    print()

    if problems:
        print(
            red(bold(f"{problems} problem(s) found.")),
            "Fix from layer 0 up — each layer needs the one below it.\n",
        )
    else:
        print(green(bold("All four layers look healthy.\n")))
    return 1 if problems else 0


def cmd_demo(args: argparse.Namespace, cfg: Config) -> int:
    """A synthetic run that diverges, to prove the whole chain end to end."""
    from .monitor import DivergenceError, TrainMonitor

    steps = args.steps
    diverge_at = args.diverge_at if args.diverge_at > 0 else None
    print(
        f"{bold('demo run')} · {steps} steps"
        + (f" · diverges at {diverge_at}" if diverge_at else " · clean finish")
    )
    print(dim("  watch it at the dashboard, and on your phone if ntfy is configured\n"))

    rng = random.Random(7)  # noqa: S311 - synthetic demo data, not cryptography
    monitor = TrainMonitor(f"demo_{time.strftime('%H%M%S')}", config=cfg, meta={"synthetic": True})
    try:
        loss = 4.2
        for step in range(steps):
            loss = max(0.05, loss * 0.995 + rng.gauss(0, 0.02))
            gn = abs(rng.gauss(6, 2))
            scale = 1.0 + step / max(1, steps) * 0.4

            if diverge_at and step > diverge_at - 40:
                # Ramp the tell-tales before the blow-up, like a real divergence.
                ramp = (step - (diverge_at - 40)) / 40
                gn *= 1 + 40 * ramp
                scale *= 1 + 4 * ramp
            if diverge_at and step >= diverge_at:
                monitor.log({"loss": float("nan"), "grad_norm": gn}, step=step)

            monitor.log(
                {
                    "loss": loss,
                    "grad_norm": gn,
                    "lr": 3e-4 * (0.5 * (1 + math.cos(math.pi * step / steps))),
                    "entropy": max(0.02, 1.6 - 1.2 * step / steps),
                    **{f"resid_rms/layer_{i}": scale * (0.8 + 0.1 * i) for i in range(6)},
                    **{f"attn_logit_max/layer_{i}": 12 * scale + rng.gauss(0, 1) for i in range(6)},
                },
                step=step,
            )
            if step % 25 == 0:
                print(
                    f"\r  step {step:>5} · loss {loss:6.3f} · grad_norm {gn:7.2f}",
                    end="",
                    flush=True,
                )
            time.sleep(args.delay)
        print()
        monitor.finish("finished", summary=f"demo completed {steps} steps")
    except DivergenceError as exc:
        print(f"\n{red('diverged as designed:')} {exc}")
        return 0
    except KeyboardInterrupt:
        print()
        monitor.finish("stopped")
    return 0


# ── hub commands ─────────────────────────────────────────────────────────


def _client(cfg: Config) -> HubClient:
    return HubClient(cfg.hub_url, token=cfg.token)


def cmd_clip(args: argparse.Namespace, cfg: Config) -> int:
    """Push to / pull from the shared clipboard.

    The shape is deliberately Unix-ish, because on the training box you are in
    a tmux pane and the browser is the long way round:

        cat traceback.txt | trainwatch clip     # push stdin
        trainwatch clip                         # print the latest
        trainwatch clip --to-os                 # ...and into the OS clipboard
        trainwatch clip -l                      # history
    """
    c = _client(cfg)
    try:
        # ── read paths ───────────────────────────────────────────────────
        if args.list:
            clips = c.list_clips(limit=args.limit)
            if not clips:
                print(dim("  clipboard is empty"))
                return 0
            for cl in clips:
                pin = cyan("*") if cl.get("pinned") else " "
                tag = red("secret") if cl.get("secret") else dim(cl.get("device") or "?")
                head = str(cl.get("preview") or "").replace("\n", " ")[:70]
                print(f"  {pin} {bold(str(cl['id']).rjust(4))}  {head:<72} {tag}")
            return 0

        if args.id is not None:
            print(c.clip_body(args.id), end="")
            return 0

        body: str | None = None
        if args.text:
            body = args.text
        elif args.from_os:
            body = os_clipboard_read()
            if body is None:
                print(red("no OS clipboard tool found (need pbpaste/xclip/wl-paste)"))
                return 2
        elif not sys.stdin.isatty():
            body = sys.stdin.read()

        # ── write path ───────────────────────────────────────────────────
        if body is not None and body.strip():
            clip = c.push(body, secret=args.secret, pinned=args.pin)
            label = red(" [secret]") if args.secret else ""
            print(f"{green('pushed')} #{clip.get('id')} · {clip.get('bytes', 0)}B{label}")
            return 0

        # ── default: pull the latest ─────────────────────────────────────
        latest = c.latest()
        if not latest:
            print(dim("  clipboard is empty"))
            return 0
        if latest.get("secret"):
            text = c.clip_body(int(latest["id"]))
        else:
            text = c.clip_body(int(latest["id"]))

        if args.to_os:
            if os_clipboard_write(text):
                print(f"{green('copied')} #{latest['id']} to the local clipboard")
                return 0
            print(red("no OS clipboard tool found (need pbcopy/xclip/wl-copy)"))
            return 2
        print(text, end="" if text.endswith("\n") else "\n")
        return 0
    except HubError as exc:
        print(red(f"hub: {exc}"))
        return 1


def cmd_send(args: argparse.Namespace, cfg: Config) -> int:
    """Upload files to the hub so any other device can grab them."""
    c = _client(cfg)
    rc = 0
    for raw in args.paths:
        path = Path(raw)
        if not path.is_file():
            print(red(f"  not a file: {path}"))
            rc = 1
            continue
        try:
            meta = c.upload(path)
            print(
                f"  {green('sent')} {path.name} · {_bytes(meta.get('size', 0))} · id {meta.get('id')}"
            )
        except HubError as exc:
            print(red(f"  {path.name}: {exc}"))
            rc = 1
    return rc


def cmd_open(args: argparse.Namespace, cfg: Config) -> int:
    """Push a URL to another device (or all of them)."""
    try:
        link = _client(cfg).push_link(args.url, title=args.title, target=args.to or "")
        dest = args.to or "all devices"
        print(f"{green('pushed')} link #{link.get('id')} to {bold(dest)}")
        return 0
    except HubError as exc:
        print(red(f"hub: {exc}"))
        return 1


def cmd_hub(args: argparse.Namespace, cfg: Config) -> int:
    """Hub status: what is stored, and which devices have checked in."""
    try:
        data = _client(cfg).hub()
    except HubError as exc:
        print(red(f"hub: {exc}"))
        return 1
    st = data.get("stats", {})
    print(f"\n{bold('hub')} {dim(cfg.hub_url)}\n")
    print(
        f"  clips {bold(str(st.get('clips', 0)))}"
        f"  (pinned {st.get('pinned', 0)}, secret {st.get('secrets', 0)})"
    )
    print(f"  files {bold(str(st.get('files', 0)))}  ({_bytes(st.get('bytes', 0))})")
    print(f"  links {bold(str(st.get('links', 0)))}  ({st.get('unread_links', 0)} unread)")
    print(f"  notes {bold(str(st.get('notes', 0)))}")
    devices = data.get("devices", [])
    if devices:
        print(f"\n  {dim('devices')}")
        for d in devices:
            mark = green("online") if d.get("online") else dim(f"{d.get('age', 0):.0f}s ago")
            print(f"    {bold(str(d.get('name'))):<28} {d.get('kind')!s:<9} {mark}")
    print()
    return 0


def cmd_share(args: argparse.Namespace, cfg: Config) -> int:
    """Put the dashboard behind Tailscale's own HTTPS certificate.

    This is what makes the shared clipboard work at all: navigator.clipboard
    only exists in a secure context, so plain http:// on a tailnet IP silently
    has no Clipboard API.

    `tailscale serve` blocks indefinitely while it waits for a certificate it
    may never be allowed to get, so the account capability is probed first —
    a command that hangs for three minutes is worse than one that fails.
    """
    if shutil.which("tailscale") is None:
        print(red("tailscale is not installed — run scripts/tailscale-up.sh"))
        return 2

    port = str(args.port or cfg.port)
    if args.off:
        subprocess.call(["tailscale", "serve", "--https=443", "off"])  # noqa: S607
        print("serve disabled")
        return 0

    name = _magic_dns_name()
    if not name:
        print(red("could not read this machine's MagicDNS name — is Tailscale connected?"))
        return 2

    # Probe first. `serve` will sit there forever if certs are not enabled.
    probe_cmd = ["tailscale", "cert", "--cert-file", "-", "--key-file", "-", name]
    probe = subprocess.run(  # noqa: S603
        probe_cmd,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    if probe.returncode != 0:
        detail = (probe.stderr or probe.stdout).strip().splitlines()[-1:] or [""]
        print(red("\n  Tailscale cannot issue a certificate for this machine yet.\n"))
        print(f"    {dim(detail[0])}\n")
        if "does not support" in detail[0] or "not support" in detail[0]:
            print(f"  {bold('Fix (one-time, ~15 seconds):')}")
            print(f"    1. open {cyan('https://login.tailscale.com/admin/dns')}")
            print("    2. scroll to " + bold("HTTPS Certificates") + " and click Enable")
            print("    3. re-run " + bold("trainwatch share"))
            print(dim("\n  It is a per-tailnet switch, off by default, free on the personal plan."))
        print(dim(f"\n  Until then the dashboard still works over http://<tailscale-ip>:{port} —"))
        print(dim("  everything syncs, but the one-tap copy/paste buttons will not appear,"))
        print(dim("  because Safari does not expose navigator.clipboard without TLS.\n"))
        return 1

    print(f"\n{bold('exposing the dashboard on the tailnet over HTTPS')}\n")
    print(f"  local  : http://127.0.0.1:{port}")
    print(f"  tailnet: {cyan(f'https://{name}')}")
    print(dim("\n  Nothing to install on the iPad — Tailscale holds the cert."))
    print(dim("  Do NOT use `tailscale funnel`: that publishes to the public internet."))
    print()

    cmd = ["tailscale", "serve", "--bg", "--https=443", f"http://127.0.0.1:{port}"]
    # The subprocess writes straight to the fd, while our prints sit in Python's
    # block buffer whenever stdout is not a tty (e.g. piped). Without this flush
    # our header appears *after* tailscale's output, which reads as nonsense.
    sys.stdout.flush()
    try:
        rc = subprocess.run(cmd, timeout=60, check=False).returncode  # noqa: S603
    except subprocess.TimeoutExpired:
        print(red("  `tailscale serve` timed out. Check `tailscale serve status`."))
        return 1
    if rc == 0:
        print(
            green(
                "\n  done. `tailscale serve status` to check, `trainwatch share --off` to undo.\n"
            )
        )
    return rc


def _tailscale_serve_url() -> str:
    """The HTTPS URL `tailscale serve` is publishing, if any.

    Reported by doctor because the failure it prevents is silent: without TLS
    there is no Clipboard API, so the copy buttons just quietly do nothing.
    """
    out = _run(["tailscale", "serve", "status"])
    if not out or "no serve config" in out.lower():
        return ""
    name = _magic_dns_name()
    return f"https://{name}" if name else "(serving)"


def _allowed_hosts_count() -> set[str]:
    from .security import resolve_allowed_hosts

    return resolve_allowed_hosts()


def _magic_dns_name() -> str:
    out = _run(["tailscale", "status", "--json"])
    if not out:
        return ""
    try:
        import json as _json

        return str(_json.loads(out).get("Self", {}).get("DNSName", "")).rstrip(".")
    except (ValueError, AttributeError):
        return ""


# ── helpers ──────────────────────────────────────────────────────────────


def _fmt(value: float | None, unit: str) -> str:
    return dim("n/a") if value is None else f"{value:.0f}{unit}"


def _ago(ts: float | None) -> str:
    """Coarse relative time. Precision past "3d ago" is noise in a log listing."""
    if ts is None:
        return "never"
    delta = max(0.0, time.time() - ts)
    for size, unit in ((86400.0, "d"), (3600.0, "h"), (60.0, "m")):
        if delta >= size:
            return f"{int(delta // size)}{unit} ago"
    return "just now"


def _bytes(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TiB"


def _importable(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _run(cmd: list[str], timeout: float = 5.0) -> str:
    try:
        p = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
        return p.stdout.strip() if p.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _tailscale_ips() -> list[str]:
    if shutil.which("tailscale") is None:
        return []
    out = _run(["tailscale", "ip", "-4"])
    return [line.strip() for line in out.splitlines() if line.strip()]


def _tmux_sessions() -> list[str]:
    out = _run(["tmux", "list-sessions", "-F", "#{session_name}"])
    return [line.strip() for line in out.splitlines() if line.strip()]


def _cron_has_liveness() -> bool:
    return "trainwatch liveness" in _run(["crontab", "-l"])


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text(encoding="utf-8").lower()
    except OSError:
        return False


# ── entrypoint ───────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="trainwatch",
        description="Remote training monitoring, watched from an iPad.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Start with `trainwatch doctor` whenever something isn't arriving.",
    )
    p.add_argument("--version", action="version", version=f"trainwatch {__version__}")
    p.add_argument("--env", default=".env", help="path to the .env file (default: .env)")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="run the dashboard + API")
    s.add_argument("--host", default=None)
    s.add_argument("--port", type=int, default=None)
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("liveness", help="one-shot heartbeat check (the cron entry)")
    s.add_argument("-q", "--quiet", action="store_true", help="print only when unhealthy")
    s.set_defaults(func=cmd_liveness)

    s = sub.add_parser("doctor", help="diagnose all four layers")
    s.add_argument("--send-test", action="store_true", help="actually push a test notification")
    s.set_defaults(func=cmd_doctor)

    s = sub.add_parser("demo", help="synthetic run to test the whole chain")
    s.add_argument("--steps", type=int, default=400)
    s.add_argument("--diverge-at", type=int, default=320, help="0 to finish cleanly")
    s.add_argument("--delay", type=float, default=0.02, help="seconds per step")
    s.set_defaults(func=cmd_demo)

    s = sub.add_parser("gpu", help="one-shot GPU snapshot")
    s.set_defaults(func=cmd_gpu)

    s = sub.add_parser("tensorboard", help="launch TensorBoard bound for remote access")
    s.add_argument("--logdir", default=None)
    s.add_argument("--port", type=int, default=None)
    s.set_defaults(func=cmd_tensorboard)

    s = sub.add_parser("clip", help="push/pull the shared clipboard")
    s.add_argument("--text", default=None, help="text to push (else stdin, else pull)")
    s.add_argument("-l", "--list", action="store_true", help="show recent history")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--id", type=int, default=None, help="print one clip's full body")
    s.add_argument("--secret", action="store_true", help="redact in listings, expire fast")
    s.add_argument("--pin", action="store_true", help="never expire")
    s.add_argument("--from-os", action="store_true", help="push the local OS clipboard")
    s.add_argument("--to-os", action="store_true", help="pull into the local OS clipboard")
    s.set_defaults(func=cmd_clip)

    s = sub.add_parser("send", help="upload files to the hub")
    s.add_argument("paths", nargs="+")
    s.set_defaults(func=cmd_send)

    s = sub.add_parser("open", help="push a link to a device")
    s.add_argument("url")
    s.add_argument("--to", default="", help="target device name (default: all)")
    s.add_argument("--title", default="")
    s.set_defaults(func=cmd_open)

    s = sub.add_parser("hub", help="hub contents and device presence")
    s.set_defaults(func=cmd_hub)

    s = sub.add_parser("share", help="serve the dashboard over Tailscale HTTPS")
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--off", action="store_true", help="stop serving")
    s.set_defaults(func=cmd_share)

    s = sub.add_parser("user", help="the human account")
    s.add_argument("action", choices=["add", "passwd", "disable"])
    s.add_argument("name")
    s.add_argument("--role", choices=["owner", "viewer"], default="owner")
    s.set_defaults(func=cmd_user)

    s = sub.add_parser("token", help="machine identities for the TUF, cron, agents")
    s.add_argument("action", choices=["create", "list", "revoke"])
    s.add_argument("name", nargs="?", default="")
    s.add_argument("--scopes", default="", help="comma separated, e.g. telemetry:write")
    s.add_argument("--ttl", type=float, default=0.0, help="days until expiry; 0 = never")
    s.set_defaults(func=cmd_token)

    s = sub.add_parser("audit", help="who changed what, and whether the log is intact")
    s.add_argument("--limit", type=int, default=40)
    s.add_argument("--verify", action="store_true", help="recompute the hash chain")
    s.set_defaults(func=cmd_audit)

    s = sub.add_parser("curriculum", help="curriculum progress: seed, record, render")
    s.add_argument("--seed", metavar="YAML", default="", help="load declarations from YAML")
    s.add_argument("--write", metavar="PATH", default="", help="render Markdown to a file")
    s.add_argument("--drift", action="store_true",
                   help="exit 1 if any declared status outruns its evidence")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--pass", dest="record_pass", metavar="PHASE/GATE", default="")
    g.add_argument("--fail", dest="record_fail", metavar="PHASE/GATE", default="")
    s.add_argument("--evidence", default="", help="what proves it; a path or a number")
    s.add_argument("--machine", default="", help="defaults to this host's name")
    s.set_defaults(func=cmd_curriculum)

    s = sub.add_parser("backup", help="snapshot / verify / restore the database")
    s.add_argument("--list", action="store_true", help="list snapshots with integrity")
    s.add_argument("--verify", metavar="PATH", default="", help="integrity_check one file")
    s.add_argument(
        "--restore", metavar="PATH|latest", default="",
        help="restore a snapshot; the current file is moved aside, never deleted",
    )
    s.add_argument("--hourly", type=int, default=24, help="snapshots kept by recency")
    s.add_argument("--daily", type=int, default=30, help="calendar days kept")
    s.set_defaults(func=cmd_backup)

    s = sub.add_parser("prune", help="trim old telemetry")
    s.add_argument("--days", type=float, default=30.0)
    s.set_defaults(func=cmd_prune)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s · %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = load_config(args.env)
    # --pass/--fail are one action with a boolean outcome; argparse cannot
    # express that directly, so collapse them here rather than in the command.
    if hasattr(args, "record_pass"):
        args.record = args.record_pass or args.record_fail
        args.passed = bool(args.record_pass)
    func: Any = args.func
    try:
        return int(func(args, cfg))
    except KeyboardInterrupt:
        print()
        return 130


if __name__ == "__main__":
    sys.exit(main())
