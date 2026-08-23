"""The hub's HTTP surface: uploads, inline-vs-attachment, and the write paths."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from src.trainwatch.config import Config
from src.trainwatch.server.app import create_app

W = {"X-Trainwatch": "1", "X-Trainwatch-Device": "macbook"}

# A tiny but genuinely valid PNG.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080200000090"
    "7753de0000000c49444154789c63f8ffff3f0005fe02fea735a09c000000"
    "0049454e44ae426082"
)


@pytest.fixture
def client(cfg: Config) -> Iterator[TestClient]:
    with TestClient(create_app(cfg)) as c:
        yield c


# ── device attribution ───────────────────────────────────────────────────


def test_device_header_is_recorded(client: TestClient) -> None:
    """Regression: the Header() alias was once declared inside the router
    factory, where `from __future__ import annotations` made FastAPI unable to
    resolve it — so the marker was silently dropped and every write was
    attributed to "unknown", with no error raised anywhere."""
    body = client.post("/api/clip", json={"body": "hi"}, headers=W).json()
    assert body["device"] == "macbook"


def test_device_falls_back_to_the_user_agent(client: TestClient) -> None:
    r = client.post(
        "/api/clip",
        json={"body": "from an ipad"},
        headers={"X-Trainwatch": "1", "User-Agent": "Mozilla/5.0 (iPad; CPU OS 17_0)"},
    )
    assert r.json()["device"] == "ipad"


def test_devices_appear_in_the_snapshot(client: TestClient) -> None:
    client.post("/api/clip", json={"body": "x"}, headers=W)
    names = [d["name"] for d in client.get("/api/hub", headers=W).json()["devices"]]
    assert "macbook" in names


# ── clipboard ────────────────────────────────────────────────────────────


def test_empty_clip_is_422(client: TestClient) -> None:
    assert client.post("/api/clip", json={"body": "   "}, headers=W).status_code == 422


def test_secret_is_redacted_in_the_snapshot_but_readable_by_id(client: TestClient) -> None:
    cid = client.post(
        "/api/clip", json={"body": "ghp_tokenvalue123456", "secret": True}, headers=W
    ).json()["id"]
    snapshot = client.get("/api/hub", headers=W).json()
    assert "tokenvalue" not in str(snapshot)
    assert client.get(f"/api/clip/{cid}/body").text == "ghp_tokenvalue123456"


def test_clip_body_is_no_store(client: TestClient) -> None:
    """A revealed secret must not be left sitting in a disk cache."""
    cid = client.post("/api/clip", json={"body": "s3cret"}, headers=W).json()["id"]
    r = client.get(f"/api/clip/{cid}/body")
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["content-type"].startswith("text/plain")


def test_missing_clip_body_is_404(client: TestClient) -> None:
    assert client.get("/api/clip/99999/body").status_code == 404


def test_inspect_reports_without_storing(client: TestClient) -> None:
    r = client.post("/api/clips/inspect", json={"body": "ghp_abcdefghijklmnopqrstuvwx"}, headers=W)
    assert r.json()["looks_secret"] is True
    assert client.get("/api/hub", headers=W).json()["clips"] == []


def test_pin_and_delete(client: TestClient) -> None:
    cid = client.post("/api/clip", json={"body": "x"}, headers=W).json()["id"]
    assert client.post(f"/api/clip/{cid}/pin?pinned=true", headers=W).status_code == 200
    assert client.get("/api/hub", headers=W).json()["clips"][0]["pinned"] is True
    assert client.delete(f"/api/clip/{cid}", headers=W).status_code == 204
    assert client.delete(f"/api/clip/{cid}", headers=W).status_code == 404


# ── files ────────────────────────────────────────────────────────────────


def test_image_is_served_inline(client: TestClient) -> None:
    fid = client.post(
        "/api/files", files={"file": ("shot.png", PNG, "image/png")}, headers=W
    ).json()["id"]
    r = client.get(f"/api/files/{fid}/raw")
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["content-type"] == "image/png"
    assert r.content == PNG


@pytest.mark.parametrize(
    ("name", "mime"),
    [
        ("payload.html", "text/html"),
        ("payload.svg", "image/svg+xml"),
        ("notes.txt", "text/plain"),
        ("script.js", "application/javascript"),
    ],
)
def test_anything_scriptable_is_forced_to_download(
    client: TestClient, name: str, mime: str
) -> None:
    """ADR-0003 T3. SVG matters most: it is an XML document that can carry
    <script>, so serving it inline would hand an uploader script execution on
    the dashboard's own origin."""
    fid = client.post(
        "/api/files", files={"file": (name, b"<script>alert(1)</script>", mime)}, headers=W
    ).json()["id"]
    r = client.get(f"/api/files/{fid}/raw")
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_download_flag_forces_attachment_even_for_images(client: TestClient) -> None:
    fid = client.post("/api/files", files={"file": ("a.png", PNG, "image/png")}, headers=W).json()[
        "id"
    ]
    r = client.get(f"/api/files/{fid}/raw?download=true")
    assert r.headers["content-disposition"].startswith("attachment")


def test_empty_upload_is_422(client: TestClient) -> None:
    r = client.post(
        "/api/files", files={"file": ("empty.bin", b"", "application/octet-stream")}, headers=W
    )
    assert r.status_code == 422


def test_oversized_upload_is_413(cfg: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("src.trainwatch.server.hub_api.MAX_UPLOAD_BYTES", 1024)
    with TestClient(create_app(cfg)) as c:
        r = c.post(
            "/api/files",
            files={"file": ("big.bin", b"x" * 5000, "application/octet-stream")},
            headers=W,
        )
        assert r.status_code == 413


def test_traversal_filename_is_neutralised(client: TestClient) -> None:
    meta = client.post(
        "/api/files",
        files={"file": ("../../../etc/passwd", b"data", "text/plain")},
        headers=W,
    ).json()
    assert meta["name"] == "passwd"
    assert "/" not in meta["id"]


def test_unknown_file_is_404(client: TestClient) -> None:
    assert client.get("/api/files/nope/raw").status_code == 404


# ── links + notes ────────────────────────────────────────────────────────


def test_link_round_trip(client: TestClient) -> None:
    lid = client.post(
        "/api/links", json={"url": "https://example.com", "title": "t"}, headers=W
    ).json()["id"]
    assert client.post(f"/api/links/{lid}/opened", headers=W).json()["opened"] is True
    assert client.delete(f"/api/links/{lid}", headers=W).status_code == 204


@pytest.mark.parametrize("url", ["javascript:alert(1)", "file:///etc/passwd", "nope"])
def test_dangerous_link_schemes_are_422(client: TestClient, url: str) -> None:
    assert client.post("/api/links", json={"url": url}, headers=W).status_code == 422


def test_note_round_trip(client: TestClient) -> None:
    assert client.put("/api/notes/scratch", json={"body": "hello"}, headers=W).status_code == 200
    assert client.get("/api/notes/scratch").json()["body"] == "hello"
    assert client.delete("/api/notes/scratch", headers=W).status_code == 204
    assert client.get("/api/notes/scratch").status_code == 404


# ── snapshot + revision ──────────────────────────────────────────────────


def test_snapshot_shape(client: TestClient) -> None:
    body = client.get("/api/hub", headers=W).json()
    assert set(body) >= {
        "revision",
        "clips",
        "files",
        "links",
        "notes",
        "devices",
        "stats",
        "limits",
    }


def test_revision_advances_on_write_only(client: TestClient) -> None:
    r0 = client.get("/api/hub", headers=W).json()["revision"]
    assert client.get("/api/hub", headers=W).json()["revision"] == r0
    client.post("/api/clip", json={"body": "x"}, headers=W)
    assert client.get("/api/hub", headers=W).json()["revision"] > r0


def test_purge_endpoint_reports_counts(client: TestClient) -> None:
    body = client.post("/api/hub/purge", headers=W).json()
    assert set(body) == {"clips", "files", "orphan_blobs"}
