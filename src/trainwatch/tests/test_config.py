"""Config resolution — 12-factor env, with a hand-rolled .env reader."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.trainwatch.config import Config, load_config, load_dotenv


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(dict(__import__("os").environ)):
        if key.startswith(("TRAINWATCH_", "WANDB_")):
            monkeypatch.delenv(key, raising=False)


def test_defaults_are_usable_with_no_configuration() -> None:
    cfg = load_config(dotenv=None)
    assert cfg.db_path == Path("var/trainwatch.db")
    assert cfg.sinks == ("store",)
    assert cfg.heartbeat_timeout == 900
    assert cfg.notify_enabled is False


def test_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRAINWATCH_DB", "var/custom/x.db")
    monkeypatch.setenv("TRAINWATCH_SINKS", "store, tensorboard ,wandb")
    monkeypatch.setenv("TRAINWATCH_GRAD_NORM_CEIL", "42.5")
    monkeypatch.setenv("TRAINWATCH_PORT", "9000")
    cfg = load_config(dotenv=None)
    assert cfg.db_path == Path("var/custom/x.db")
    assert cfg.sinks == ("store", "tensorboard", "wandb")
    assert cfg.grad_norm_ceil == 42.5
    assert cfg.port == 9000


def test_a_malformed_number_falls_back_instead_of_crashing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo in .env must not stop a run from starting."""
    monkeypatch.setenv("TRAINWATCH_GRAD_NORM_CEIL", "not-a-number")
    monkeypatch.setenv("TRAINWATCH_PORT", "")
    cfg = load_config(dotenv=None)
    assert cfg.grad_norm_ceil == 100.0
    assert cfg.port == 8730


def test_empty_sinks_falls_back_to_store(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRAINWATCH_SINKS", "  ,, ")
    assert load_config(dotenv=None).sinks == ("store",)


# ── the .env reader ──────────────────────────────────────────────────────


def test_dotenv_parses_comments_quotes_and_blanks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = tmp_path / ".env"
    env.write_text(
        "\n".join(
            [
                "# a comment",
                "",
                "TRAINWATCH_NTFY_TOPIC='quoted-topic'",
                'TRAINWATCH_NTFY_SERVER="https://ntfy.example"',
                "TRAINWATCH_PORT = 8888 ",
                "MALFORMED_LINE_NO_EQUALS",
            ]
        )
    )
    cfg = load_config(env)
    assert cfg.ntfy_topic == "quoted-topic"
    assert cfg.ntfy_server == "https://ntfy.example"
    assert cfg.port == 8888


def test_real_env_wins_over_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Otherwise a stale .env silently overrides what systemd or CI set."""
    env = tmp_path / ".env"
    env.write_text("TRAINWATCH_PORT=1111\n")
    monkeypatch.setenv("TRAINWATCH_PORT", "2222")
    assert load_config(env).port == 2222


def test_missing_dotenv_is_not_an_error(tmp_path: Path) -> None:
    load_dotenv(tmp_path / "nope.env")  # must not raise


# ── derived properties ───────────────────────────────────────────────────


def test_ntfy_url_is_joined_without_double_slashes() -> None:
    cfg = Config(ntfy_server="https://ntfy.sh/", ntfy_topic="/my-topic")
    assert cfg.ntfy_url == "https://ntfy.sh/my-topic"


def test_no_topic_means_no_url_and_notify_disabled() -> None:
    cfg = Config(ntfy_topic="")
    assert cfg.ntfy_url == ""
    assert cfg.notify_enabled is False


def test_the_placeholder_topic_counts_as_unconfigured() -> None:
    """.env.example ships a CHANGE-ME topic; shipping alerts to it is worse
    than not sending them, because you'd believe layer 3 was armed."""
    cfg = Config(ntfy_topic="trainwatch-CHANGE-ME-to-a-random-string")
    assert cfg.notify_enabled is False
