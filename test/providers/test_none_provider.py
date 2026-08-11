"""Tests for the plain-terminal provider."""

import asyncio

from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.providers.manager import ProviderManager
from cli_agent_orchestrator.providers.none import NoneProvider


def test_none_provider_initializes_without_launching_a_cli():
    provider = NoneProvider("abcd1234", "shell-session", "terminal-1234")

    assert asyncio.run(provider.initialize()) is True
    assert provider.get_status("any shell output") == TerminalStatus.IDLE
    assert provider.paste_enter_count == 1
    assert provider.exit_cli() == "exit"


def test_provider_manager_creates_none_provider_without_profile():
    manager = ProviderManager()

    provider = manager.create_provider(
        "none",
        "abcd1234",
        "shell-session",
        "terminal-1234",
        agent_profile=None,
    )

    assert isinstance(provider, NoneProvider)
    assert manager.get_provider("abcd1234") is provider
