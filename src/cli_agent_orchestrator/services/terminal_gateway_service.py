"""Loopback ttyd broker for browser attachment to remote tmux sessions."""

from __future__ import annotations

import asyncio
import atexit
import functools
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal, cast

from cli_agent_orchestrator.models.fleet import FleetTerminalAttachment
from cli_agent_orchestrator.utils.terminal import validate_tmux_name

DEFAULT_ATTACHMENT_TTL_SECONDS = 8 * 60 * 60
DEFAULT_ATTACHMENT_LIMIT = 8
DEFAULT_STARTUP_TIMEOUT_SECONDS = 5.0


class TerminalGatewayError(RuntimeError):
    """Base error for the local terminal gateway."""


class TerminalGatewayUnavailable(TerminalGatewayError):
    """Raised when ttyd is not installed or cannot be started."""


class TerminalAttachmentNotFound(TerminalGatewayError):
    """Raised when an attachment ID is unknown or expired."""


@dataclass
class _Attachment:
    id: str
    node: str
    terminal_id: str
    session_name: str
    window_name: str
    local_port: int
    base_path: str
    process: subprocess.Popen[bytes]
    created_at: float
    last_accessed: float
    expires_at: float
    state: str = "starting"
    detail: str | None = None


class TerminalGatewayService:
    """Create bounded, reusable ttyd processes on the laptop controller."""

    def __init__(
        self,
        *,
        ttyd_binary: str | None = None,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        startup_timeout: float = DEFAULT_STARTUP_TIMEOUT_SECONDS,
        ttl_seconds: int = DEFAULT_ATTACHMENT_TTL_SECONDS,
        max_attachments: int = DEFAULT_ATTACHMENT_LIMIT,
        clock: Callable[[], float] = time.monotonic,
        urlopen: Callable[..., object] = urllib.request.urlopen,
    ) -> None:
        self.ttyd_binary = ttyd_binary or shutil.which("ttyd")
        self._popen = popen
        self.startup_timeout = startup_timeout
        self.ttl_seconds = ttl_seconds
        self.max_attachments = max_attachments
        self._clock = clock
        self._urlopen = urlopen
        self._attachments: dict[str, _Attachment] = {}
        self._by_target: dict[tuple[str, str], str] = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix="fleet-terminal-gateway",
        )

    @staticmethod
    def _reserve_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def _expires_at(self, value: float) -> str:
        remaining = max(0.0, value - self._clock())
        return datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() + remaining,
            tz=timezone.utc,
        ).isoformat()

    def _projection(self, attachment: _Attachment) -> FleetTerminalAttachment:
        return FleetTerminalAttachment(
            id=attachment.id,
            node=attachment.node,
            terminal_id=attachment.terminal_id,
            state=cast(Literal["starting", "live", "failed", "closed"], attachment.state),
            view_url=f"/fleet/attachments/{attachment.id}/view",
            expires_at=self._expires_at(attachment.expires_at),
            detail=attachment.detail,
        )

    def _remove_locked(self, attachment_id: str) -> None:
        attachment = self._attachments.pop(attachment_id, None)
        if attachment is None:
            return
        self._by_target.pop((attachment.node, attachment.terminal_id), None)
        if attachment.process.poll() is None:
            attachment.process.terminate()
            try:
                attachment.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                attachment.process.kill()
                attachment.process.wait(timeout=2)
        attachment.state = "closed"

    def prune(self) -> None:
        now = self._clock()
        with self._lock:
            expired = [
                attachment_id
                for attachment_id, attachment in self._attachments.items()
                if attachment.expires_at <= now or attachment.process.poll() is not None
            ]
            for attachment_id in expired:
                self._remove_locked(attachment_id)

    def create(
        self,
        *,
        node: str,
        terminal_id: str,
        session_name: str,
        window_name: str,
    ) -> FleetTerminalAttachment:
        if not self.ttyd_binary:
            raise TerminalGatewayUnavailable(
                "ttyd is not installed on the controller; install ttyd to open fleet terminals"
            )
        session_name = validate_tmux_name(session_name, "session_name")
        window_name = validate_tmux_name(window_name, "window_name")
        target_key = (node, terminal_id)
        now = self._clock()

        self.prune()
        with self._lock:
            existing_id = self._by_target.get(target_key)
            if existing_id:
                existing = self._attachments.get(existing_id)
                if existing and existing.process.poll() is None:
                    existing.last_accessed = now
                    existing.expires_at = now + self.ttl_seconds
                    return self._projection(existing)
            if len(self._attachments) >= self.max_attachments:
                oldest = min(self._attachments.values(), key=lambda item: item.last_accessed)
                self._remove_locked(oldest.id)

            attachment_id = secrets.token_urlsafe(18)
            base_path = f"/{secrets.token_urlsafe(24)}"
            local_port = self._reserve_port()
            command = [
                self.ttyd_binary,
                "-W",
                "-O",
                "-m",
                "1",
                "-i",
                "127.0.0.1",
                "-p",
                str(local_port),
                "-b",
                base_path,
                "ssh",
                "-tt",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectionAttempts=1",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "--",
                node,
                "tmux",
                "-u",
                "attach-session",
                "-t",
                f"{session_name}:{window_name}",
            ]
            try:
                process = self._popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except OSError as exc:
                raise TerminalGatewayUnavailable(f"Could not start ttyd: {exc}") from exc
            attachment = _Attachment(
                id=attachment_id,
                node=node,
                terminal_id=terminal_id,
                session_name=session_name,
                window_name=window_name,
                local_port=local_port,
                base_path=base_path,
                process=process,
                created_at=now,
                last_accessed=now,
                expires_at=now + self.ttl_seconds,
            )
            self._attachments[attachment_id] = attachment
            self._by_target[target_key] = attachment_id

        health_url = f"http://127.0.0.1:{local_port}{base_path}/"
        deadline = self._clock() + self.startup_timeout
        last_error: Exception | None = None
        while self._clock() < deadline:
            if process.poll() is not None:
                break
            try:
                response = self._urlopen(health_url, timeout=0.25)
                close = getattr(response, "close", None)
                if close:
                    close()
                with self._lock:
                    attachment.state = "live"
                return self._projection(attachment)
            except (OSError, urllib.error.URLError) as exc:
                last_error = exc
                time.sleep(0.05)

        detail = str(last_error) if last_error else "ttyd exited during startup"
        with self._lock:
            attachment.state = "failed"
            attachment.detail = detail
            projection = self._projection(attachment)
            self._remove_locked(attachment.id)
        raise TerminalGatewayUnavailable(projection.detail or "ttyd failed to start")

    def get(self, attachment_id: str, *, touch: bool = True) -> FleetTerminalAttachment:
        self.prune()
        with self._lock:
            attachment = self._attachments.get(attachment_id)
            if attachment is None:
                raise TerminalAttachmentNotFound("Terminal attachment not found or expired")
            if touch:
                now = self._clock()
                attachment.last_accessed = now
                attachment.expires_at = now + self.ttl_seconds
            return self._projection(attachment)

    async def create_async(
        self,
        *,
        node: str,
        terminal_id: str,
        session_name: str,
        window_name: str,
    ) -> FleetTerminalAttachment:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            functools.partial(
                self.create,
                node=node,
                terminal_id=terminal_id,
                session_name=session_name,
                window_name=window_name,
            ),
        )

    async def cleanup_daemon(self, interval: float = 60.0) -> None:
        while True:
            await asyncio.sleep(interval)
            await asyncio.get_running_loop().run_in_executor(self._executor, self.prune)

    def target_url(self, attachment_id: str) -> str:
        self.get(attachment_id)
        with self._lock:
            attachment = self._attachments[attachment_id]
            return f"http://127.0.0.1:{attachment.local_port}{attachment.base_path}/"

    def delete(self, attachment_id: str) -> bool:
        with self._lock:
            if attachment_id not in self._attachments:
                return False
            self._remove_locked(attachment_id)
            return True

    def close(self) -> None:
        with self._lock:
            for attachment_id in list(self._attachments):
                self._remove_locked(attachment_id)

    def shutdown(self) -> None:
        self.close()
        self._executor.shutdown(wait=False, cancel_futures=True)


terminal_gateway_service = TerminalGatewayService()
atexit.register(terminal_gateway_service.shutdown)
