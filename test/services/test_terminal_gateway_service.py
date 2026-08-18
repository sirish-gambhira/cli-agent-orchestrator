"""Tests for the loopback ttyd terminal attachment broker."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.services.terminal_gateway_service import (
    TerminalGatewayService,
    TerminalGatewayUnavailable,
)


class _Process:
    def __init__(self) -> None:
        self.terminated = False

    def poll(self):
        return 0 if self.terminated else None

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.terminated = True

    def wait(self, timeout: int):
        return 0


class _Response:
    def close(self) -> None:
        return None


def test_missing_ttyd_is_actionable():
    service = TerminalGatewayService(ttyd_binary=None)
    service.ttyd_binary = None

    with pytest.raises(TerminalGatewayUnavailable, match="install ttyd"):
        service.create(
            node="5c-01",
            terminal_id="term-1",
            session_name="session-1",
            window_name="window-1",
        )
    service.shutdown()


def test_attachment_uses_argv_only_ssh_tmux_and_reuses_target(monkeypatch):
    calls = []
    process = _Process()

    def popen(args, **kwargs):
        calls.append((args, kwargs))
        return process

    monkeypatch.setattr(TerminalGatewayService, "_reserve_port", staticmethod(lambda: 45678))
    service = TerminalGatewayService(
        ttyd_binary="/usr/local/bin/ttyd",
        popen=popen,
        urlopen=lambda *_args, **_kwargs: _Response(),
    )

    first = service.create(
        node="5c-01",
        terminal_id="term-1",
        session_name="session-1",
        window_name="window-1",
    )
    second = service.create(
        node="5c-01",
        terminal_id="term-1",
        session_name="session-1",
        window_name="window-1",
    )

    assert first.state == "live"
    assert second.id == first.id
    assert len(calls) == 1
    argv = calls[0][0]
    assert argv[0] == "/usr/local/bin/ttyd"
    assert argv[argv.index("--") + 1 :] == [
        "5c-01",
        "tmux",
        "-u",
        "attach-session",
        "-t",
        "session-1:window-1",
    ]
    assert calls[0][1]["stdin"] is not None
    service.shutdown()


def test_attachment_limit_evicts_least_recently_used(monkeypatch):
    processes = [_Process(), _Process()]
    popen = Mock(side_effect=processes)
    ports = iter([45001, 45002])
    monkeypatch.setattr(
        TerminalGatewayService,
        "_reserve_port",
        staticmethod(lambda: next(ports)),
    )
    service = TerminalGatewayService(
        ttyd_binary="ttyd",
        popen=popen,
        urlopen=lambda *_args, **_kwargs: _Response(),
        max_attachments=1,
    )

    first = service.create(
        node="5c-01",
        terminal_id="term-1",
        session_name="session-1",
        window_name="window-1",
    )
    service.create(
        node="5c-01",
        terminal_id="term-2",
        session_name="session-2",
        window_name="window-2",
    )

    assert processes[0].terminated is True
    assert service.delete(first.id) is False
    service.shutdown()
