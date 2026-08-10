"""Tests for SSH node discovery and bounded remote directory browsing."""

import json
import subprocess

import pytest

from cli_agent_orchestrator.services.fleet_service import (
    FleetProxyResponse,
    FleetService,
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
    assert calls[0][1]["timeout"] == 7


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

    overview = service.fleet_overview()

    assert overview[0].name == "jbom-02"
    assert overview[0].status == "reachable"
    assert overview[0].sessions[0]["id"] == "cao-one"
    assert overview[0].sessions[0]["terminals"][0]["status"] == "WAITING_USER_ANSWER"
    assert overview[1].status == "unreachable"
    assert overview[1].detail == "offline"
