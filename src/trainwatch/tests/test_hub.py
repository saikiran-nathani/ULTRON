"""Hub storage: redaction, dedup, TTLs, and the paths that touch the filesystem."""

from __future__ import annotations

import time

import pytest

from src.trainwatch.hub import REDACTED, SECRET_TTL, Hub, looks_secret

# ── secrets ──────────────────────────────────────────────────────────────


def test_secret_body_never_appears_in_a_listing(hub: Hub) -> None:
    """The whole point. A clipboard history is a credential archive; a secret
    must not be readable by anything that merely lists entries."""
    hub.add_clip("ghp_realtokenvalue1234567890", secret=True)
    (row,) = hub.clips()
    assert row["body"] == REDACTED
    assert row["preview"] == REDACTED
    assert "realtoken" not in str(row)


def test_secret_is_revealable_only_by_explicit_id(hub: Hub) -> None:
    c = hub.add_clip("ghp_realtokenvalue1234567890", secret=True)
    assert hub.clip_body(int(c["id"])) == "ghp_realtokenvalue1234567890"


def test_secrets_are_excluded_from_search(hub: Hub) -> None:
    """Matching on a redacted entry would leak it one character at a time."""
    hub.add_clip("ghp_findme_token_abcdefghij", secret=True)
    hub.add_clip("findme in the clear")
    results = hub.clips(query="findme")
    assert len(results) == 1
    assert results[0]["secret"] is False


def test_secrets_expire_fast(hub: Hub) -> None:
    c = hub.add_clip("token", secret=True)
    assert c["expires_at"] is not None
    assert c["expires_at"] - time.time() <= SECRET_TTL + 1


def test_digest_is_never_exposed(hub: Hub) -> None:
    """The digest is a content hash; publishing it lets a short secret be
    brute-forced offline."""
    hub.add_clip("s3cret", secret=True)
    assert "digest" not in hub.clips()[0]


@pytest.mark.parametrize(
    "text",
    [
        "ghp_abcdefghijklmnopqrstuvwxyz01",
        "sk-abcdefghijklmnopqrstuvwx",
        "AKIAIOSFODNN7EXAMPLE",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "export WANDB_API_KEY=abcdefgh12345678",
        "tskey-auth-abcdef1234567890",
        # This project's own ntfy topic: a credential that looks like a name.
        "TRAINWATCH_NTFY_TOPIC=trainwatch-aBc123XyZ890qWeRtY",
        "trainwatch-aBc123XyZ890qWeRtY",
    ],
)
def test_credential_detector_fires(text: str) -> None:
    assert looks_secret(text)


@pytest.mark.parametrize(
    "text", ["100.69.221.23", "loss 0.4063", "checkpoints/run_042/step_1400.pt", "hello world"]
)
def test_credential_detector_does_not_cry_wolf(text: str) -> None:
    """A detector that fires on an IP address is one you learn to ignore."""
    assert not looks_secret(text)


# ── dedup + pinning ──────────────────────────────────────────────────────


def test_recopying_the_same_text_refreshes_rather_than_duplicating(hub: Hub) -> None:
    """You re-copy things to be sure. That should not fill the history."""
    a = hub.add_clip("100.69.221.23", device="mac")
    b = hub.add_clip("100.69.221.23", device="asus")
    assert a["id"] == b["id"]
    assert len(hub.clips()) == 1
    assert hub.clips()[0]["device"] == "asus"  # most recent sender wins


def test_a_different_clip_in_between_defeats_dedup(hub: Hub) -> None:
    hub.add_clip("aaa")
    hub.add_clip("bbb")
    hub.add_clip("aaa")
    assert len(hub.clips()) == 3


def test_pinned_clips_never_expire(hub: Hub) -> None:
    c = hub.add_clip("ssh one-liner", pinned=True)
    assert c["expires_at"] is None


def test_pinning_sorts_to_the_top(hub: Hub) -> None:
    hub.add_clip("older")
    hub.add_clip("newer")
    pinned = hub.add_clip("pin me")
    hub.pin_clip(int(pinned["id"]), True)
    assert hub.clips()[0]["id"] == pinned["id"]


def test_unpinning_restores_an_expiry(hub: Hub) -> None:
    c = hub.add_clip("x", pinned=True)
    hub.pin_clip(int(c["id"]), False)
    assert hub.clips()[0]["expires_at"] is not None


def test_clear_keeps_pinned_by_default(hub: Hub) -> None:
    hub.add_clip("throwaway")
    hub.pin_clip(int(hub.add_clip("keeper", pinned=True)["id"]), True)
    hub.clear_clips()
    assert [c["preview"] for c in hub.clips()] == ["keeper"]


def test_expired_clips_are_not_listed(hub: Hub) -> None:
    hub.add_clip("gone", ttl=-1)
    assert hub.clips() == []


def test_expired_clip_body_is_unreadable(hub: Hub) -> None:
    c = hub.add_clip("gone", ttl=-1)
    assert hub.clip_body(int(c["id"])) is None


def test_oversized_clip_is_rejected(hub: Hub) -> None:
    with pytest.raises(ValueError, match="exceeds"):
        hub.add_clip("x" * 2_000_000)


def test_empty_clip_is_rejected(hub: Hub) -> None:
    with pytest.raises(ValueError):
        hub.add_clip("")


# ── files ────────────────────────────────────────────────────────────────


def test_client_filename_never_reaches_the_filesystem(hub: Hub) -> None:
    """The on-disk name is generated, so path traversal has no surface at all
    rather than relying on sanitising '..' correctly."""
    meta = hub.add_file("../../../../etc/passwd", b"data")
    assert meta["name"] == "passwd"  # display only
    path = hub.file_path(str(meta["id"]))
    assert path is not None
    assert path.parent == hub.blob_dir.resolve()


def test_control_characters_are_stripped_from_display_names(hub: Hub) -> None:
    meta = hub.add_file("evil\x00\x1fname.png", b"x")
    assert "\x00" not in str(meta["name"])


def test_file_path_rejects_a_crafted_id(hub: Hub) -> None:
    assert hub.file_path("../../etc/passwd") is None
    assert hub.file_path("nonexistent") is None


def test_deleting_a_file_removes_the_blob(hub: Hub) -> None:
    meta = hub.add_file("x.bin", b"data")
    path = hub.file_path(str(meta["id"]))
    assert path is not None and path.is_file()
    hub.delete_file(str(meta["id"]))
    assert not path.is_file()


def test_images_are_flagged(hub: Hub) -> None:
    assert hub.add_file("a.png", b"x", mime="image/png")["is_image"]
    assert not hub.add_file("b.log", b"x", mime="text/plain")["is_image"]


# ── links ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>", "not a url", ""],
)
def test_non_web_urls_are_rejected(hub: Hub, url: str) -> None:
    with pytest.raises(ValueError, match="http"):
        hub.add_link(url)


def test_broadcast_links_reach_everyone(hub: Hub) -> None:
    hub.add_link("https://example.com/all")
    hub.add_link("https://example.com/ipad", target="ipad")
    assert len(hub.links(device="mac")) == 1  # only the broadcast
    assert len(hub.links(device="ipad")) == 2  # broadcast + its own


def test_marking_a_link_opened_is_idempotent(hub: Hub) -> None:
    link = hub.add_link("https://example.com")
    assert hub.mark_link_opened(int(link["id"])) is True
    assert hub.mark_link_opened(int(link["id"])) is False


# ── notes ────────────────────────────────────────────────────────────────


def test_note_ids_are_slugified(hub: Hub) -> None:
    note = hub.put_note("My Notes! 2026", body="x")
    assert note["id"] == "my-notes-2026"


def test_note_upsert_replaces_body(hub: Hub) -> None:
    hub.put_note("scratch", body="first")
    hub.put_note("scratch", body="second")
    assert len(hub.notes()) == 1
    assert hub.note("scratch")["body"] == "second"  # type: ignore[index]


def test_empty_note_id_falls_back(hub: Hub) -> None:
    assert hub.put_note("   ", body="x")["id"] == "scratch"


# ── presence + revision ──────────────────────────────────────────────────


def test_presence_tracks_last_seen(hub: Hub) -> None:
    hub.seen("ipad", kind="ipad")
    (d,) = hub.devices()
    assert d["name"] == "ipad"
    assert d["online"] is True


def test_a_stale_device_is_offline(hub: Hub) -> None:
    hub.seen("old")
    assert hub.devices(online_window=-1)[0]["online"] is False


def test_revision_moves_on_writes_only(hub: Hub) -> None:
    """The SSE stream polls this integer; if reads bumped it the stream would
    push constantly and cost real cellular data."""
    r0 = hub.revision()
    hub.clips()
    hub.devices()
    assert hub.revision() == r0
    hub.add_clip("x")
    assert hub.revision() > r0


# ── purge ────────────────────────────────────────────────────────────────


def test_purge_removes_expired_clips_and_blobs(hub: Hub) -> None:
    hub.add_clip("gone", ttl=-1)
    meta = hub.add_file("gone.bin", b"x", ttl=-1)
    path = hub.blob_dir / str(meta["id"])
    counts = hub.purge_expired()
    assert counts["clips"] == 1
    assert counts["files"] == 1
    assert not path.is_file()


def test_purge_reaps_orphaned_blobs(hub: Hub) -> None:
    """An interrupted upload would otherwise leak disk forever, invisibly."""
    (hub.blob_dir / "orphan-blob").write_bytes(b"x")
    assert hub.purge_expired()["orphan_blobs"] == 1
    assert not (hub.blob_dir / "orphan-blob").is_file()


def test_purge_spares_pinned_items(hub: Hub) -> None:
    hub.add_clip("keeper", pinned=True)
    hub.purge_expired()
    assert len(hub.clips()) == 1
