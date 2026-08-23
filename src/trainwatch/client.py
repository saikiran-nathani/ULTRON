"""Stdlib-only HTTP client for the hub — powers the `trainwatch clip` commands.

Why a CLI at all, when the point was "everything through the dashboard": on the
Asus you are in a tmux pane, not a browser. Reaching for Safari to move a
traceback is friction that stops you using the thing. `... | trainwatch clip`
is the Linux half of the Linux<->Apple bridge.

Zero third-party dependencies, same rule as the rest of the core: urllib and a
hand-rolled multipart encoder rather than `requests`.
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import shutil
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .security import GUARD_HEADER

__all__ = ["HubClient", "HubError", "os_clipboard_read", "os_clipboard_write"]


class HubError(RuntimeError):
    """A hub request failed. Message is already human-readable."""


class HubClient:
    def __init__(self, base_url: str, *, token: str = "", device: str = "", timeout: float = 15.0):
        self.base = base_url.rstrip("/")
        self.token = token
        self.device = device or _default_device_name()
        self.timeout = timeout

    # ── plumbing ─────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        h = {
            # ADR-0003 C3: writes require this, and sending it always is
            # simpler than remembering which verbs need it.
            GUARD_HEADER: "1",
            "X-Trainwatch-Device": self.device,
            "Accept": "application/json",
        }
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def _request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        raw: bytes | None = None,
        content_type: str = "",
        expect_json: bool = True,
    ) -> Any:
        url = f"{self.base}{path}"
        headers = self._headers()
        body: bytes | None = raw
        if payload is not None:
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        if content_type:
            headers["Content-Type"] = content_type

        req = urllib.request.Request(url, data=body, headers=headers, method=method)  # noqa: S310
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
                data = resp.read()
                if not expect_json:
                    return data.decode("utf-8", "replace")
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise HubError(_explain(exc.code, detail, url)) from exc
        except urllib.error.URLError as exc:
            raise HubError(
                f"cannot reach the hub at {self.base} ({exc.reason}).\n"
                f"  Is `trainwatch serve` running on the host, and is Tailscale up?"
            ) from exc

    def _obj(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        """A JSON object response, narrowed. A malformed body becomes {}."""
        data = self._request(method, path, **kw)
        return data if isinstance(data, dict) else {}

    def _text(self, method: str, path: str, **kw: Any) -> str:
        data = self._request(method, path, expect_json=False, **kw)
        return data if isinstance(data, str) else str(data)

    # ── clipboard ────────────────────────────────────────────────────────

    def push(
        self, body: str, *, secret: bool = False, pinned: bool = False, kind: str = "text"
    ) -> dict[str, Any]:
        return self._obj(
            "POST",
            "/api/clip",
            payload={"body": body, "secret": secret, "pinned": pinned, "kind": kind},
        )

    def latest(self) -> dict[str, Any]:
        return self._obj("GET", "/api/clip/latest")

    def clip_body(self, clip_id: int) -> str:
        return self._text("GET", f"/api/clip/{clip_id}/body")

    def list_clips(self, limit: int = 20) -> list[dict[str, Any]]:
        return list(self._obj("GET", "/api/hub").get("clips", []))[:limit]

    def hub(self) -> dict[str, Any]:
        return self._obj("GET", "/api/hub")

    # ── files ────────────────────────────────────────────────────────────

    def upload(self, path: Path) -> dict[str, Any]:
        data = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        boundary = f"----trainwatch{secrets.token_hex(12)}"
        body = b"".join(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode(),
                f"Content-Type: {mime}\r\n\r\n".encode(),
                data,
                f"\r\n--{boundary}--\r\n".encode(),
            ]
        )
        return self._obj(
            "POST",
            "/api/files",
            raw=body,
            content_type=f"multipart/form-data; boundary={boundary}",
        )

    def download(self, file_id: str, dest: Path) -> Path:
        url = f"{self.base}/api/files/{file_id}/raw?download=true"
        req = urllib.request.Request(url, headers=self._headers())  # noqa: S310
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
            dest.write_bytes(resp.read())
        return dest

    # ── links / notes ────────────────────────────────────────────────────

    def push_link(self, url: str, *, title: str = "", target: str = "") -> dict[str, Any]:
        return self._obj(
            "POST", "/api/links", payload={"url": url, "title": title, "target": target}
        )

    def put_note(self, note_id: str, body: str, *, title: str = "") -> dict[str, Any]:
        return self._obj(
            "PUT",
            f"/api/notes/{urllib.parse.quote(note_id)}",
            payload={"body": body, "title": title},
        )

    def note(self, note_id: str) -> dict[str, Any]:
        return self._obj("GET", f"/api/notes/{urllib.parse.quote(note_id)}")


def _explain(code: int, detail: str, url: str) -> str:
    """Turn the guard's refusals into something actionable, not a bare 403."""
    if code == 421:
        return (
            f"the hub refused the Host header for {url} (ADR-0003 C1 — DNS-rebinding guard).\n"
            f"  Add the name you are using to TRAINWATCH_ALLOWED_HOSTS on the host.\n  {detail}"
        )
    if code == 401:
        return "the hub requires a token. Set TRAINWATCH_TOKEN to match the host's value."
    if code == 403:
        return f"the hub refused the request (origin/guard-header check).\n  {detail}"
    if code == 413:
        return "file is larger than the hub's upload limit (64 MB)."
    return f"hub returned HTTP {code}: {detail}"


def _default_device_name() -> str:
    """Prefer the Tailscale machine name — that is how you think of the device."""
    if shutil.which("tailscale"):
        try:
            cmd = ["tailscale", "status", "--json"]
            out = subprocess.run(  # noqa: S603 - fixed argv, no shell
                cmd, capture_output=True, text=True, timeout=3, check=False
            )
            if out.returncode == 0:
                dns = json.loads(out.stdout).get("Self", {}).get("DNSName", "")
                if dns:
                    return str(dns).split(".")[0]
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, AttributeError):
            pass
    return socket.gethostname().split(".")[0]


# ── OS clipboard bridges ─────────────────────────────────────────────────
# On-demand only. There is deliberately no daemon that watches the system
# clipboard: that design captures every password you copy, forever, and the
# convenience is not worth building a credential archive by accident.


def os_clipboard_read() -> str | None:
    """Read the local OS clipboard, or None if no tool is available."""
    for cmd in (
        ["pbpaste"],
        ["wl-paste", "--no-newline"],
        ["xclip", "-selection", "clipboard", "-o"],
        ["xsel", "--clipboard", "--output"],
        ["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"],
    ):
        # Partial paths are intentional: which tool exists varies per platform
        # (macOS / Wayland / X11 / WSL), and shutil.which resolves it on PATH.
        if shutil.which(cmd[0]):
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False)  # noqa: S603
                if p.returncode == 0:
                    return p.stdout.rstrip("\r\n") if cmd[0] == "powershell.exe" else p.stdout
            except (OSError, subprocess.TimeoutExpired):
                continue
    return None


def os_clipboard_write(text: str) -> bool:
    """Write to the local OS clipboard. True on success."""
    for cmd in (
        ["pbcopy"],
        ["wl-copy"],
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
        ["clip.exe"],
    ):
        if shutil.which(cmd[0]):  # see note above re: partial paths
            try:
                p = subprocess.run(cmd, input=text, text=True, timeout=5, check=False)  # noqa: S603
                if p.returncode == 0:
                    return True
            except (OSError, subprocess.TimeoutExpired):
                continue
    return False


def clipboard_tool_hint() -> str:
    if os.name == "posix" and not shutil.which("pbcopy"):
        return "install xclip (X11) or wl-clipboard (Wayland) for --to-os/--from-os"
    return ""
