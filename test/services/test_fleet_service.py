"""Tests for SSH node discovery and bounded remote directory browsing."""

import json
import subprocess
import threading
import urllib.error

import pytest

from cli_agent_orchestrator.services.fleet_service import (
    FleetProxyResponse,
    FleetService,
    NodeNotReadyError,
    NodeTunnelManager,
    NodeUnavailableError,
    RemoteBrowseError,
    UnknownNodeError,
    discover_ssh_aliases,
)


def test_discovers_concrete_aliases_and_follows_includes(tmp_path):
    included = tmp_path / "nodes.conf"
    included.write_text("Host jbom-03 secure-* !secure-01\n")
    config = tmp_path / "config"
    config.write_text(
        "Host *\n  ServerAliveInterval 30\n"
        "Host jbom-02 jbom-02-alt # controller aliases\n"
        "Include nodes.conf\n"
    )

    assert discover_ssh_aliases(config) == ["jbom-02", "jbom-02-alt", "jbom-03"]


def test_include_cycle_is_safe(tmp_path):
    first = tmp_path / "config"
    second = tmp_path / "other.conf"
    first.write_text("Include other.conf\nHost first\n")
    second.write_text("Include config\nHost second\n")

    assert discover_ssh_aliases(first) == ["first", "second"]


def test_check_node_uses_strict_noninteractive_ssh(tmp_path):
    config = tmp_path / "config"
    config.write_text("Host jbom-02\n")
    calls = []

    def runner(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, "", "")

    result = FleetService(config, runner=runner).check_node("jbom-02")

    assert result.status == "reachable"
    assert calls[0][0][-2:] == ["jbom-02", "true"]
    assert "BatchMode=yes" in calls[0][0]
    assert "StrictHostKeyChecking=yes" in calls[0][0]
    assert calls[0][1]["timeout"] == 20


def test_tunnel_waits_for_slow_ssh_authentication(monkeypatch):
    clock = [0.0]

    class Process:
        terminated = False

        def poll(self):
            return 0 if self.terminated else None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout):
            assert timeout == 2
            return 0

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def urlopen(_url, timeout):
        assert timeout == 0.5
        if clock[0] < 10:
            raise urllib.error.URLError("tunnel not ready")
        return Response()

    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.time.monotonic", lambda: clock[0]
    )
    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.time.sleep",
        lambda seconds: clock.__setitem__(0, clock[0] + seconds),
    )
    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.urllib.request.urlopen", urlopen
    )
    monkeypatch.setattr(NodeTunnelManager, "_reserve_port", staticmethod(lambda: 43210))

    manager = NodeTunnelManager(popen=lambda *_args, **_kwargs: Process())
    tunnel = manager.ensure("jbom-03")

    assert tunnel.local_port == 43210
    assert clock[0] >= 10
    manager.close()


def test_concurrent_tunnel_callers_wait_for_startup(monkeypatch):
    urlopen_entered = threading.Event()
    release_urlopen = threading.Event()
    second_finished = threading.Event()
    process = type(
        "Process",
        (),
        {
            "poll": lambda self: None,
            "terminate": lambda self: None,
            "wait": lambda self, timeout: 0,
        },
    )()

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def urlopen(_url, timeout):
        urlopen_entered.set()
        assert release_urlopen.wait(timeout=1)
        return Response()

    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.urllib.request.urlopen", urlopen
    )
    monkeypatch.setattr(NodeTunnelManager, "_reserve_port", staticmethod(lambda: 43210))
    manager = NodeTunnelManager(popen=lambda *_args, **_kwargs: process, startup_timeout=1)
    results = []

    first = threading.Thread(target=lambda: results.append(manager.ensure("jbom-03")))

    def ensure_second():
        results.append(manager.ensure("jbom-03"))
        second_finished.set()

    second = threading.Thread(target=ensure_second)
    first.start()
    assert urlopen_entered.wait(timeout=1)
    second.start()
    assert not second_finished.wait(timeout=0.05)
    release_urlopen.set()
    first.join(timeout=1)
    second.join(timeout=1)

    assert len(results) == 2
    assert results[0] is results[1]
    manager.close()


def test_get_live_fails_fast_before_connection_actor_starts():
    manager = NodeTunnelManager()

    with pytest.raises(NodeNotReadyError, match="stopped"):
        manager.get_live("jbom-03")


def test_tunnel_uses_keepalive_and_requires_forward_success(monkeypatch):
    calls = []

    class Process:
        stderr = None

        def poll(self):
            return None

        def terminate(self):
            return None

        def wait(self, timeout):
            return 0

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.urllib.request.urlopen",
        lambda *_args, **_kwargs: Response(),
    )
    monkeypatch.setattr(NodeTunnelManager, "_reserve_port", staticmethod(lambda: 43210))

    def popen(args, **kwargs):
        calls.append((args, kwargs))
        return Process()

    manager = NodeTunnelManager(popen=popen)
    manager.ensure("jbom-03")

    args = calls[0][0]
    # ClearAllForwardings cannot be combined with this command's managed -L:
    # OpenSSH clears command-line forwards too, leaving no listener to probe.
    assert "ClearAllForwardings=yes" not in args
    assert "ExitOnForwardFailure=yes" in args
    assert "ServerAliveInterval=15" in args
    assert "ServerAliveCountMax=3" in args
    manager.close()


def test_tunnel_recovers_from_backoff_on_next_actor_attempt(monkeypatch):
    clock = [0.0]
    available = [False]

    class Process:
        stderr = None

        def __init__(self):
            self.terminated = False

        def poll(self):
            return 0 if self.terminated else None

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

        def wait(self, timeout):
            return 0

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def urlopen(*_args, **_kwargs):
        if not available[0]:
            raise urllib.error.URLError("not ready")
        return Response()

    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.time.monotonic",
        lambda: clock[0],
    )
    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.time.sleep",
        lambda seconds: clock.__setitem__(0, clock[0] + seconds),
    )
    monkeypatch.setattr(
        "cli_agent_orchestrator.services.fleet_service.urllib.request.urlopen",
        urlopen,
    )
    ports = iter([43210, 43211])
    monkeypatch.setattr(
        NodeTunnelManager,
        "_reserve_port",
        staticmethod(lambda: next(ports)),
    )
    manager = NodeTunnelManager(popen=lambda *_args, **_kwargs: Process(), startup_timeout=0.2)

    with pytest.raises(NodeUnavailableError, match="not ready"):
        manager.ensure("jbom-03")
    assert manager.connection_status("jbom-03").phase.value == "backoff"

    available[0] = True
    tunnel = manager.ensure("jbom-03")
    assert tunnel.local_port == 43211
    assert manager.connection_status("jbom-03").phase.value == "live"
    manager.close()


def test_unknown_node_never_invokes_ssh(tmp_path):
    config = tmp_path / "config"
    config.write_text("Host jbom-02\n")

    def runner(*args, **kwargs):
        raise AssertionError("runner must not be called")

    with pytest.raises(UnknownNodeError, match="Unknown SSH node"):
        FleetService(config, runner=runner).check_node("-oProxyCommand=bad")


def test_browse_parses_remote_listing_and_does_not_embed_plain_path(tmp_path):
    config = tmp_path / "config"
    config.write_text("Host jbom-02\n")
    payload = {
        "path": "/work/project",
        "parent": "/work",
        "home": "/home/dev",
        "entries": [
            {
                "name": "src",
                "path": "/work/project/src",
                "is_git_repository": False,
                "is_worktree": False,
            }
        ],
        "truncated": False,
        "is_git_repository": True,
        "is_worktree": False,
        "git_branch": "main",
    }
    calls = []

    def runner(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")

    listing = FleetService(config, runner=runner).browse_directories(
        "jbom-02", "/work/project with spaces"
    )

    assert listing.node == "jbom-02"
    assert listing.git_branch == "main"
    assert listing.entries[0].name == "src"
    assert "/work/project with spaces" not in calls[0][-1]


def test_browse_rejects_invalid_remote_json(tmp_path):
    config = tmp_path / "config"
    config.write_text("Host jbom-02\n")

    def runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 0, "not-json", "")

    with pytest.raises(RemoteBrowseError, match="invalid directory listing"):
        FleetService(config, runner=runner).browse_directories("jbom-02")


def test_fleet_overview_combines_sessions_and_unavailable_nodes(tmp_path, monkeypatch):
    config = tmp_path / "config"
    config.write_text("Host jbom-02 jbom-03\n")
    service = FleetService(config)

    def proxy(node, method, remote_path, **kwargs):
        assert method == "GET"
        if node == "jbom-03":
            raise RemoteBrowseError("offline")
        if remote_path == "/sessions/cao-one":
            return FleetProxyResponse(
                200,
                b'{"session":{"id":"cao-one"},"terminals":[{"id":"worker-1","status":"WAITING_USER_ANSWER"}]}',
                "application/json",
            )
        assert remote_path == "/sessions"
        return FleetProxyResponse(
            200, b'[{"id":"cao-one","name":"one","status":"active"}]', "application/json"
        )

    monkeypatch.setattr(service, "proxy_request", proxy)

    overview = service.fleet_overview(["jbom-02", "jbom-03"])

    assert overview[0].name == "jbom-02"
    assert overview[0].status == "reachable"
    assert overview[0].sessions[0]["id"] == "cao-one"
    assert overview[0].sessions[0]["terminals"][0]["status"] == "WAITING_USER_ANSWER"
    assert overview[1].status == "unreachable"
    assert overview[1].detail == "offline"
