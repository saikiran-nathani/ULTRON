"""The liveness check — the only alert that can fire when the trainer is dead.

The three bugs the naive version in the guide has, each pinned by a test.
"""

from __future__ import annotations

import time

from src.trainwatch.config import Config
from src.trainwatch.heartbeat import read_heartbeat, write_heartbeat
from src.trainwatch.liveness import check_liveness
from src.trainwatch.notify import NullNotifier
from src.trainwatch.store import Store


def _run(cfg: Config, *, status: str = "running", beat_age: float = 0.0) -> None:
    with Store(cfg.db_path) as s:
        s.start_run("r1", "run_042")
        s.beat("r1", 100, ts=time.time() - beat_age)
        s._db.commit()
        if status != "running":
            s.finish_run("r1", status)


def test_no_runs_at_all_is_not_an_alert(cfg: Config) -> None:
    result = check_liveness(cfg, notifier=NullNotifier())
    assert result.status == "unknown"
    assert result.healthy


def test_fresh_heartbeat_is_ok(cfg: Config) -> None:
    _run(cfg, beat_age=10)
    result = check_liveness(cfg, notifier=NullNotifier())
    assert result.status == "ok"
    assert result.healthy


def test_stale_heartbeat_on_a_running_run_alerts(cfg: Config) -> None:
    _run(cfg, beat_age=cfg.heartbeat_timeout + 60)
    n = NullNotifier()
    result = check_liveness(cfg, notifier=n)

    assert result.status == "dead"
    assert not result.healthy
    assert result.exit_code == 1
    assert result.notified
    assert n.messages[0].priority == "urgent"
    assert "DEAD" in n.messages[0].title


# ── bug 1: pages you forever after a clean finish ────────────────────────


def test_a_finished_run_never_alerts_however_old_its_heartbeat(cfg: Config) -> None:
    """A completed run leaves a permanently-stale heartbeat. `age > 900` stays
    true for all eternity, so a naive check pages you every 10 minutes until
    you start another run."""
    _run(cfg, status="finished", beat_age=86400 * 7)
    n = NullNotifier()
    result = check_liveness(cfg, notifier=n)

    assert result.status == "idle"
    assert result.healthy
    assert n.messages == []


def test_a_failed_run_also_does_not_re_alert(cfg: Config) -> None:
    _run(cfg, status="failed", beat_age=86400)
    n = NullNotifier()
    assert check_liveness(cfg, notifier=n).status == "idle"
    assert n.messages == []


# ── bug 2: pages you every 10 minutes while the run stays dead ───────────


def test_a_dead_run_is_reported_once_not_every_cron_tick(cfg: Config) -> None:
    _run(cfg, beat_age=cfg.heartbeat_timeout + 60)

    first = check_liveness(cfg, notifier=NullNotifier())
    assert first.notified

    # Cron fires again 10 minutes later. The run is not going to get less dead,
    # and the first check marked it so — the corpse is no longer "active", so
    # subsequent ticks are quiet and exit 0 instead of mailing you forever.
    n = NullNotifier()
    second = check_liveness(cfg, notifier=n)
    assert not second.notified
    assert n.messages == []
    assert second.exit_code == 0
    assert "dead" in second.message


def test_a_dead_run_is_marked_dead_so_the_dashboard_agrees(cfg: Config) -> None:
    _run(cfg, beat_age=cfg.heartbeat_timeout + 60)
    check_liveness(cfg, notifier=NullNotifier())
    with Store(cfg.db_path) as s:
        run = s.run("r1")
        assert run is not None
        assert run["status"] == "dead"


# ── bug 3: only reads the file ───────────────────────────────────────────


def test_progress_in_the_store_counts_even_with_no_heartbeat_file(cfg: Config) -> None:
    """The store's last_beat updates every logged step; the file only every N.
    Either is proof of life."""
    _run(cfg, beat_age=5)
    assert not cfg.heartbeat_path.exists()
    assert check_liveness(cfg, notifier=NullNotifier()).status == "ok"


def test_heartbeat_file_counts_even_if_the_store_row_is_stale(cfg: Config) -> None:
    _run(cfg, beat_age=cfg.heartbeat_timeout + 60)
    write_heartbeat(cfg.heartbeat_path, run_id="r1", step=500)  # fresh file
    assert check_liveness(cfg, notifier=NullNotifier()).status == "ok"


def test_running_run_that_never_reported_is_flagged_differently(cfg: Config) -> None:
    with Store(cfg.db_path) as s:
        s.start_run("r1", "never-started")
    result = check_liveness(cfg, notifier=NullNotifier())
    assert result.status == "stale-heartbeat"
    assert not result.healthy


# ── the heartbeat file itself ────────────────────────────────────────────


def test_heartbeat_plain_file_stays_shell_readable(cfg: Config) -> None:
    """The guide's cron one-liner does `$(cat /tmp/heartbeat)` in arithmetic.
    The plain file must contain a bare epoch and nothing else."""
    write_heartbeat(cfg.heartbeat_path, run_id="r", step=1)
    raw = cfg.heartbeat_path.read_text().strip()
    assert float(raw) > 0
    assert "\n" not in raw


def test_heartbeat_rich_file_carries_context(cfg: Config) -> None:
    write_heartbeat(cfg.heartbeat_path, run_id="r7", step=321)
    hb = read_heartbeat(cfg.heartbeat_path)
    assert hb is not None
    assert hb["run_id"] == "r7"
    assert hb["step"] == 321
    assert hb["age"] < 5


def test_reading_a_missing_heartbeat_returns_none(cfg: Config) -> None:
    assert read_heartbeat(cfg.heartbeat_path) is None


def test_write_heartbeat_never_raises_on_a_bad_path() -> None:
    write_heartbeat("/proc/definitely/not/writable/hb")  # must not raise


def test_corrupt_rich_heartbeat_falls_back_to_the_plain_file(cfg: Config) -> None:
    write_heartbeat(cfg.heartbeat_path, run_id="r", step=1)
    cfg.heartbeat_path.with_suffix(cfg.heartbeat_path.suffix + ".json").write_text("{ broken")
    hb = read_heartbeat(cfg.heartbeat_path)
    assert hb is not None
    assert hb["age"] < 5
