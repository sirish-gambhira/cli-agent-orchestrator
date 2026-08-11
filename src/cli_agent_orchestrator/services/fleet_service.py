"""SSH-backed node discovery and remote filesystem browsing.

The laptop controller deliberately delegates authentication, jump hosts, and
host-key policy to the operator's OpenSSH configuration.  Only concrete
``Host`` aliases discovered there may be used, so an API caller cannot turn
the controller into an arbitrary SSH target or inject SSH options.
"""

from __future__ import annotations

import atexit
import base64
import glob
import json
import logging
import shlex
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from cli_agent_orchestrator.models.fleet import (
    FleetNode,
    FleetNodeCheck,
    FleetNodeOverview,
    RemoteDirectoryListing,
)

logger = logging.getLogger(__name__)

DEFAULT_SSH_CONFIG = Path("~/.ssh/config").expanduser()
DEFAULT_CONNECT_TIMEOUT_SECONDS = 5
DEFAULT_COMMAND_TIMEOUT_SECONDS = 15
DEFAULT_SSH_READY_TIMEOUT_SECONDS = 20
MAX_DIRECTORY_ENTRIES = 500
DEFAULT_REMOTE_CAO_PORT = 9889

Runner = Callable[..., subprocess.CompletedProcess[str]]


class FleetError(RuntimeError):
    """Base error for the remote fleet boundary."""


class UnknownNodeError(FleetError):
    """Raised when a node is not a concrete alias in SSH config."""


class NodeUnavailableError(FleetError):
    """Raised when an SSH command cannot reach or run on a node."""


class RemoteBrowseError(FleetError):
    """Raised when the remote node rejects a directory browse request."""


@dataclass
class NodeTunnel:
    """One controller-owned OpenSSH local forward."""

    node: str
    local_port: int
    process: subprocess.Popen[bytes]


@dataclass
class FleetProxyResponse:
    """Raw HTTP response returned by a node's CAO server."""

    status_code: int
    body: bytes
    content_type: str | None


# Kept fixed and sent as a quoted ``python3 -c`` program. The only user value
# is a URL-safe base64 argument, never executable shell text.
_REMOTE_BROWSE_SCRIPT = r"""
import base64
import json
import os
import subprocess
import sys

limit = int(sys.argv[2])
show_hidden = sys.argv[3] == "1"
raw_path = base64.urlsafe_b64decode(sys.argv[1].encode("ascii")).decode("utf-8")
if "\x00" in raw_path:
    raise ValueError("path must not contain a NUL byte")
path = os.path.realpath(os.path.abspath(os.path.expanduser(raw_path or "~")))
if not os.path.isdir(path):
    raise ValueError("directory does not exist")

def git_info(directory):
    marker = os.path.join(directory, ".git")
    is_repo = os.path.isdir(marker) or os.path.isfile(marker)
    is_worktree = os.path.isfile(marker)
    branch = None
    if is_repo:
        result = subprocess.run(
            ["git", "-C", directory, "branch", "--show-current"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if result.returncode == 0:
            branch = result.stdout.strip() or None
    return is_repo, is_worktree, branch

children = []
with os.scandir(path) as iterator:
    for item in iterator:
        if not show_hidden and item.name.startswith("."):
            continue
        try:
            if not item.is_dir(follow_symlinks=True):
                continue
            child_path = os.path.realpath(item.path)
            child_marker = os.path.join(child_path, ".git")
            children.append({
                "name": item.name,
                "path": child_path,
                "is_git_repository": os.path.isdir(child_marker) or os.path.isfile(child_marker),
                "is_worktree": os.path.isfile(child_marker),
            })
        except OSError:
            continue
children.sort(key=lambda item: (item["name"].lower(), item["name"]))
truncated = len(children) > limit
children = children[:limit]
is_repo, is_worktree, branch = git_info(path)
parent = None if path == os.path.dirname(path) else os.path.dirname(path)
print(json.dumps({
    "path": path,
    "parent": parent,
    "home": os.path.realpath(os.path.expanduser("~")),
    "entries": children,
    "truncated": truncated,
    "is_git_repository": is_repo,
    "is_worktree": is_worktree,
    "git_branch": branch,
}, separators=(",", ":")))
""".strip()


def _strip_comment(line: str) -> str:
    """Strip SSH comments while respecting simple shell-style quoting."""

    lexer = shlex.shlex(line, posix=True)
    lexer.whitespace_split = True
    lexer.commenters = "#"
    return " ".join(lexer)


def _resolve_includes(value: str, config_path: Path) -> list[Path]:
    paths: list[Path] = []
    for pattern in shlex.split(value, comments=True, posix=True):
        candidate = Path(pattern).expanduser()
        if not candidate.is_absolute():
            candidate = config_path.parent / candidate
        paths.extend(Path(match) for match in sorted(glob.glob(str(candidate))))
    return paths


def discover_ssh_aliases(config_path: Path = DEFAULT_SSH_CONFIG) -> list[str]:
    """Return sorted concrete ``Host`` aliases, following ``Include`` files."""

    aliases: set[str] = set()
    visited: set[Path] = set()

    def visit(path: Path) -> None:
        resolved = path.expanduser().resolve()
        if resolved in visited or not resolved.is_file():
            return
        visited.add(resolved)
        try:
            lines = resolved.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as exc:
            logger.warning("Unable to read SSH config %s: %s", resolved, exc)
            return
        for raw_line in lines:
            line = _strip_comment(raw_line).strip()
            if not line:
                continue
            key, _, value = line.partition(" ")
            if key.lower() == "include":
                for included in _resolve_includes(value, resolved):
                    visit(included)
            elif key.lower() == "host":
                for alias in shlex.split(value, comments=True, posix=True):
                    if (
                        alias
                        and not alias.startswith("!")
                        and not any(wildcard in alias for wildcard in ("*", "?", "["))
                    ):
                        aliases.add(alias)

    visit(config_path)
    return sorted(aliases, key=lambda value: (value.lower(), value))


class NodeTunnelManager:
    """Lazily maintain one loopback-only SSH forward per selected node."""

    def __init__(
        self,
        remote_port: int = DEFAULT_REMOTE_CAO_PORT,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        startup_timeout: float = DEFAULT_SSH_READY_TIMEOUT_SECONDS,
    ) -> None:
        self.remote_port = remote_port
        self._popen = popen
        self.startup_timeout = startup_timeout
        self._tunnels: dict[str, NodeTunnel] = {}
        self._startup_locks: dict[str, threading.Lock] = {}
        self._lock = threading.Lock()
        atexit.register(self.close)

    @staticmethod
    def _reserve_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def ensure(self, node: str) -> NodeTunnel:
        """Return a live tunnel, starting and health-checking it when needed."""

        with self._lock:
            startup_lock = self._startup_locks.setdefault(node, threading.Lock())

        # Only serialize startup for the same node. Different fleet nodes may
        # still establish their tunnels concurrently.
        with startup_lock:
            with self._lock:
                existing = self._tunnels.get(node)
                if existing and existing.process.poll() is None:
                    return existing
                if existing:
                    self._tunnels.pop(node, None)

                local_port = self._reserve_port()
                args = [
                    "ssh",
                    "-N",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    f"ConnectTimeout={DEFAULT_CONNECT_TIMEOUT_SECONDS}",
                    "-o",
                    "ConnectionAttempts=1",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    # A Host alias may define unrelated LocalForward entries. One
                    # of those can be busy without invalidating our dynamic CAO
                    # forward; the /health probe below is its success criterion.
                    "-o",
                    "ExitOnForwardFailure=no",
                    "-L",
                    f"127.0.0.1:{local_port}:127.0.0.1:{self.remote_port}",
                    node,
                ]
                process = self._popen(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                tunnel = NodeTunnel(node=node, local_port=local_port, process=process)
                self._tunnels[node] = tunnel

            health_url = f"http://127.0.0.1:{local_port}/health"
            last_error: Exception | None = None
            deadline = time.monotonic() + self.startup_timeout
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(health_url, timeout=0.5) as response:
                        if response.status == 200:
                            return tunnel
                except (OSError, urllib.error.URLError) as exc:
                    last_error = exc
                remaining = deadline - time.monotonic()
                if remaining > 0:
                    time.sleep(min(0.1, remaining))

            self.drop(node)
            detail = f": {last_error}" if last_error else ""
            raise NodeUnavailableError(
                f"CAO server is not reachable on {node}:127.0.0.1:{self.remote_port}{detail}"
            )

    def drop(self, node: str) -> None:
        with self._lock:
            tunnel = self._tunnels.pop(node, None)
        if tunnel and tunnel.process.poll() is None:
            tunnel.process.terminate()
            try:
                tunnel.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                tunnel.process.kill()
                tunnel.process.wait(timeout=2)

    def close(self) -> None:
        for node in list(self._tunnels):
            self.drop(node)


class FleetService:
    """Run bounded OpenSSH operations for explicitly selected nodes."""

    def __init__(
        self,
        ssh_config_path: Path = DEFAULT_SSH_CONFIG,
        runner: Runner = subprocess.run,
        tunnel_manager: NodeTunnelManager | None = None,
    ) -> None:
        self.ssh_config_path = ssh_config_path
        self._runner = runner
        self.tunnels = tunnel_manager or NodeTunnelManager()

    def list_nodes(self) -> list[FleetNode]:
        return [FleetNode(name=name) for name in discover_ssh_aliases(self.ssh_config_path)]

    def _validated_node(self, node: str) -> str:
        if node not in discover_ssh_aliases(self.ssh_config_path):
            raise UnknownNodeError(f"Unknown SSH node: {node}")
        return node

    def validate_node(self, node: str) -> str:
        """Public validation boundary used before opening HTTP/WebSocket tunnels."""

        return self._validated_node(node)

    @staticmethod
    def _ssh_base_args(connect_timeout: int) -> list[str]:
        return [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={connect_timeout}",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "StrictHostKeyChecking=yes",
        ]

    def check_node(
        self, node: str, connect_timeout: int = DEFAULT_CONNECT_TIMEOUT_SECONDS
    ) -> FleetNodeCheck:
        node = self._validated_node(node)
        try:
            result = self._runner(
                [*self._ssh_base_args(connect_timeout), node, "true"],
                capture_output=True,
                text=True,
                timeout=max(DEFAULT_SSH_READY_TIMEOUT_SECONDS, connect_timeout + 2),
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return FleetNodeCheck(name=node, status="unreachable", detail=str(exc))
        if result.returncode == 0:
            return FleetNodeCheck(name=node, status="reachable")
        detail = (result.stderr or "SSH connection failed").strip().splitlines()[-1]
        return FleetNodeCheck(name=node, status="unreachable", detail=detail[:300])

    def browse_directories(
        self,
        node: str,
        path: str = "~",
        include_hidden: bool = False,
        limit: int = MAX_DIRECTORY_ENTRIES,
    ) -> RemoteDirectoryListing:
        node = self._validated_node(node)
        if not 1 <= limit <= MAX_DIRECTORY_ENTRIES:
            raise ValueError(f"limit must be between 1 and {MAX_DIRECTORY_ENTRIES}")
        encoded_path = base64.urlsafe_b64encode(path.encode("utf-8")).decode("ascii")
        remote_command = " ".join(
            [
                "python3",
                "-c",
                shlex.quote(_REMOTE_BROWSE_SCRIPT),
                encoded_path,
                str(limit),
                "1" if include_hidden else "0",
            ]
        )
        try:
            result = self._runner(
                [
                    *self._ssh_base_args(DEFAULT_CONNECT_TIMEOUT_SECONDS),
                    node,
                    remote_command,
                ],
                capture_output=True,
                text=True,
                timeout=DEFAULT_COMMAND_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise NodeUnavailableError(f"Timed out browsing {node}") from exc
        except OSError as exc:
            raise NodeUnavailableError(f"Could not start SSH: {exc}") from exc
        if result.returncode != 0:
            detail = (result.stderr or "Remote directory browse failed").strip().splitlines()[-1]
            raise RemoteBrowseError(detail[:300])
        try:
            payload = json.loads(result.stdout)
            payload["node"] = node
            return RemoteDirectoryListing.model_validate(payload)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise RemoteBrowseError("Remote node returned an invalid directory listing") from exc

    def proxy_request(
        self,
        node: str,
        method: str,
        remote_path: str,
        query: str = "",
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> FleetProxyResponse:
        """Forward one HTTP request through the node's controller-owned tunnel."""

        node = self._validated_node(node)
        if not remote_path.startswith("/") or ".." in remote_path.split("/"):
            raise ValueError("remote_path must be an absolute API path without traversal")
        tunnel = self.tunnels.ensure(node)
        url = f"http://127.0.0.1:{tunnel.local_port}{remote_path}"
        if query:
            url = f"{url}?{query}"
        headers = {"Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=95) as response:
                return FleetProxyResponse(
                    status_code=response.status,
                    body=response.read(),
                    content_type=response.headers.get("Content-Type"),
                )
        except urllib.error.HTTPError as exc:
            return FleetProxyResponse(
                status_code=exc.code,
                body=exc.read(),
                content_type=exc.headers.get("Content-Type"),
            )
        except (OSError, urllib.error.URLError) as exc:
            self.tunnels.drop(node)
            raise NodeUnavailableError(f"Lost connection to CAO server on {node}") from exc

    def fleet_overview(self, nodes: Sequence[str] | None = None) -> list[FleetNodeOverview]:
        """Fetch session summaries from all requested nodes with bounded concurrency."""

        selected = list(nodes) if nodes is not None else [node.name for node in self.list_nodes()]
        for node in selected:
            self._validated_node(node)

        def inspect(node: str) -> FleetNodeOverview:
            try:
                response = self.proxy_request(node, "GET", "/sessions")
                if response.status_code != 200:
                    return FleetNodeOverview(
                        name=node,
                        status="unreachable",
                        detail=f"CAO server returned HTTP {response.status_code}",
                    )
                sessions = json.loads(response.body)
                if not isinstance(sessions, list):
                    raise ValueError("sessions response is not a list")
                enriched_sessions = []
                for session in sessions:
                    if not isinstance(session, dict) or not isinstance(session.get("id"), str):
                        enriched_sessions.append(session)
                        continue
                    detail_response = self.proxy_request(
                        node,
                        "GET",
                        f"/sessions/{session['id']}",
                    )
                    if detail_response.status_code == 200:
                        detail = json.loads(detail_response.body)
                        if isinstance(detail, dict):
                            session = {**session, "terminals": detail.get("terminals", [])}
                    enriched_sessions.append(session)
                return FleetNodeOverview(
                    name=node,
                    status="reachable",
                    sessions=enriched_sessions,
                )
            except (FleetError, ValueError, json.JSONDecodeError) as exc:
                return FleetNodeOverview(name=node, status="unreachable", detail=str(exc)[:300])

        with ThreadPoolExecutor(max_workers=min(8, max(1, len(selected)))) as executor:
            results = list(executor.map(inspect, selected))
        return sorted(results, key=lambda item: (item.name.lower(), item.name))


fleet_service = FleetService()
