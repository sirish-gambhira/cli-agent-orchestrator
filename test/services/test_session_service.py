"""Tests for the session service."""

from unittest.mock import ANY, MagicMock, patch

import pytest

from cli_agent_orchestrator.models.inbox import OrchestrationType
from cli_agent_orchestrator.services.session_service import (
    create_session,
    delete_session,
    get_session,
    list_sessions,
)


class TestCreateSession:
    """Tests for create_session function."""

    @pytest.mark.asyncio
    @patch("cli_agent_orchestrator.services.session_service.dispatch_plugin_event")
    @patch("cli_agent_orchestrator.services.session_service.create_terminal")
    async def test_create_session_defaults_to_plain_terminal(
        self, mock_create_terminal, mock_dispatch
    ):
        """An omitted provider opens a plain terminal without a profile."""
        mock_terminal = MagicMock()
        mock_terminal.session_name = "test"
        mock_create_terminal.return_value = mock_terminal

        await create_session(provider=None, agent_profile=None, session_name="test")

        call_kwargs = mock_create_terminal.call_args.kwargs
        assert call_kwargs["provider"] == "none"
        assert call_kwargs["agent_profile"] is None
        assert call_kwargs["defer_init"] is False
        assert call_kwargs["initial_message"] is None
        assert call_kwargs["model"] is None

    @pytest.mark.asyncio
    @patch("cli_agent_orchestrator.services.session_service.dispatch_plugin_event")
    @patch("cli_agent_orchestrator.services.session_service.create_terminal")
    async def test_create_session_uses_explicit_provider(self, mock_create_terminal, mock_dispatch):
        """An explicit agent provider and profile are forwarded."""
        mock_terminal = MagicMock()
        mock_terminal.session_name = "cao-test"
        mock_create_terminal.return_value = mock_terminal

        await create_session(provider="kiro_cli", agent_profile="my_agent")

        assert mock_create_terminal.call_args.kwargs["provider"] == "kiro_cli"

    @pytest.mark.asyncio
    @patch("cli_agent_orchestrator.services.session_service.create_terminal")
    async def test_agent_provider_requires_profile(self, mock_create_terminal):
        with pytest.raises(ValueError, match="requires an agent profile"):
            await create_session(provider="codex", agent_profile=None)

        mock_create_terminal.assert_not_called()

    @pytest.mark.asyncio
    @patch("cli_agent_orchestrator.services.session_service.dispatch_plugin_event")
    @patch("cli_agent_orchestrator.services.session_service.create_terminal")
    async def test_create_blank_session_can_defer_provider_initialization(
        self, mock_create_terminal, mock_dispatch
    ):
        mock_terminal = MagicMock()
        mock_terminal.session_name = "tgt-test-copy"
        mock_create_terminal.return_value = mock_terminal

        await create_session(
            provider="codex",
            agent_profile="developer",
            session_name="tgt-test-copy",
            defer_init=True,
        )

        call_kwargs = mock_create_terminal.call_args.kwargs
        assert call_kwargs["defer_init"] is True
        assert call_kwargs["initial_message"] is None

    @pytest.mark.asyncio
    @patch("cli_agent_orchestrator.services.session_service.dispatch_plugin_event")
    @patch("cli_agent_orchestrator.services.session_service.create_terminal")
    async def test_create_session_forwards_launch_payload(
        self, mock_create_terminal, mock_dispatch
    ):
        """A first task selects the existing deferred-init path and reaches
        terminal creation alongside the model override."""
        mock_terminal = MagicMock()
        mock_terminal.session_name = "cao-test"
        mock_create_terminal.return_value = mock_terminal

        await create_session(
            provider="codex",
            agent_profile="my_agent",
            session_name="cao-test",
            initial_message="Review the current change",
            initial_message_orchestration_type=OrchestrationType.SEND_MESSAGE,
            model="gpt-5.1-codex",
        )

        call_kwargs = mock_create_terminal.call_args.kwargs
        assert call_kwargs["new_session"] is True
        assert call_kwargs["defer_init"] is True
        assert call_kwargs["initial_message"] == "Review the current change"
        assert call_kwargs["initial_message_orchestration_type"] == OrchestrationType.SEND_MESSAGE
        assert call_kwargs["model"] == "gpt-5.1-codex"

    @pytest.mark.asyncio
    @patch("cli_agent_orchestrator.services.session_service.create_terminal")
    async def test_create_session_rejects_orchestration_type_without_message(
        self, mock_create_terminal
    ):
        """An incomplete initial-message payload fails instead of being dropped."""
        with pytest.raises(
            ValueError, match="initial_message_orchestration_type requires initial_message"
        ):
            await create_session(
                provider="codex",
                agent_profile="my_agent",
                initial_message_orchestration_type=OrchestrationType.SEND_MESSAGE,
            )

        mock_create_terminal.assert_not_called()

    @pytest.mark.asyncio
    @patch("cli_agent_orchestrator.services.session_service.create_terminal")
    async def test_create_session_rejects_empty_initial_message(self, mock_create_terminal):
        """Direct callers cannot turn an empty first task into deferred initialization."""
        with pytest.raises(ValueError, match="initial_message must not be empty"):
            await create_session(
                provider="codex",
                agent_profile="my_agent",
                initial_message="",
            )

        mock_create_terminal.assert_not_called()


class TestListSessions:
    """Tests for list_sessions function."""

    @patch("cli_agent_orchestrator.services.session_service.list_all_terminals")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_list_sessions_success(self, mock_get_backend, mock_list_all):
        """Test listing sessions successfully."""
        mock_get_backend.return_value.list_sessions.return_value = [
            {"id": "cao-session1", "name": "Session 1"},
            {"id": "cao-session2", "name": "Session 2"},
            {"id": "other-session", "name": "Other"},
        ]

        mock_list_all.return_value = [{"tmux_session": "custom-session"}]
        mock_get_backend.return_value.list_sessions.return_value.append(
            {"id": "custom-session", "name": "Custom"}
        )

        result = list_sessions()

        assert [session["id"] for session in result] == [
            "cao-session1",
            "cao-session2",
            "custom-session",
        ]

    @patch("cli_agent_orchestrator.services.session_service.list_all_terminals", return_value=[])
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_list_sessions_empty(self, mock_get_backend, mock_list_all):
        """Test listing sessions when none exist."""
        mock_get_backend.return_value.list_sessions.return_value = []

        result = list_sessions()

        assert result == []

    @patch("cli_agent_orchestrator.services.session_service.list_all_terminals", return_value=[])
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_list_sessions_no_cao_sessions(self, mock_get_backend, mock_list_all):
        """Test listing sessions when no CAO sessions exist."""
        mock_get_backend.return_value.list_sessions.return_value = [
            {"id": "other-session1", "name": "Other 1"},
            {"id": "other-session2", "name": "Other 2"},
        ]

        result = list_sessions()

        assert result == []

    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_list_sessions_error(self, mock_get_backend):
        """Test listing sessions with error."""
        mock_get_backend.return_value.list_sessions.side_effect = Exception("Tmux error")

        result = list_sessions()

        assert result == []


class TestGetSession:
    """Tests for get_session function."""

    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_get_session_success(self, mock_get_backend, mock_list_terminals):
        """Test getting session successfully."""
        mock_get_backend.return_value.session_exists.return_value = True
        mock_get_backend.return_value.list_sessions.return_value = [
            {"id": "cao-test", "name": "Test Session"}
        ]
        mock_list_terminals.return_value = [{"id": "terminal1", "session": "cao-test"}]

        result = get_session("cao-test")

        assert result["session"]["id"] == "cao-test"
        assert len(result["terminals"]) == 1
        mock_get_backend.return_value.session_exists.assert_called_once_with("cao-test")

    @patch("cli_agent_orchestrator.services.status_monitor.status_monitor.get_status")
    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_get_session_enriches_terminals_with_live_status(
        self, mock_get_backend, mock_list_terminals, mock_get_status
    ):
        """Each terminal should carry its live status (consumed by the web UI
        and the cao-ops-mcp get_session_info tool an external supervisor polls)."""
        from cli_agent_orchestrator.models.terminal import TerminalStatus

        mock_get_backend.return_value.session_exists.return_value = True
        mock_get_backend.return_value.list_sessions.return_value = [{"id": "cao-test"}]
        mock_list_terminals.return_value = [
            {"id": "term-a", "tmux_session": "cao-test"},
            {"id": "term-b", "tmux_session": "cao-test"},
        ]
        mock_get_status.side_effect = lambda tid: {
            "term-a": TerminalStatus.PROCESSING,
            "term-b": TerminalStatus.COMPLETED,
        }[tid]

        result = get_session("cao-test")

        assert result["terminals"][0]["status"] == "processing"
        assert result["terminals"][1]["status"] == "completed"

    @patch("cli_agent_orchestrator.services.status_monitor.status_monitor.get_status")
    @patch("cli_agent_orchestrator.services.session_service.db_delete_terminal")
    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_get_session_removes_missing_windows_and_prefers_newest_live_terminal(
        self,
        mock_get_backend,
        mock_list_terminals,
        mock_delete_terminal,
        mock_get_status,
    ):
        from cli_agent_orchestrator.models.terminal import TerminalStatus

        backend = mock_get_backend.return_value
        backend.session_exists.return_value = True
        backend.list_sessions.return_value = [{"id": "simulator"}]
        backend.window_exists.side_effect = lambda _session, window: window != "terminal-old"
        mock_list_terminals.return_value = [
            {
                "id": "stale",
                "tmux_session": "simulator",
                "tmux_window": "terminal-old",
                "last_active": "2026-08-14T00:00:00",
            },
            {
                "id": "older-live",
                "tmux_session": "simulator",
                "tmux_window": "terminal-a",
                "last_active": "2026-08-17T00:00:00",
            },
            {
                "id": "newest-live",
                "tmux_session": "simulator",
                "tmux_window": "terminal-b",
                "last_active": "2026-08-18T00:00:00",
            },
        ]
        mock_get_status.return_value = TerminalStatus.IDLE

        result = get_session("simulator")

        assert [item["id"] for item in result["terminals"]] == [
            "newest-live",
            "older-live",
        ]
        mock_delete_terminal.assert_called_once_with("stale")

    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_get_session_not_found(self, mock_get_backend):
        """Test getting non-existent session."""
        mock_get_backend.return_value.session_exists.return_value = False

        with pytest.raises(ValueError, match="Session 'cao-nonexistent' not found"):
            get_session("cao-nonexistent")

    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_get_session_not_in_list(self, mock_get_backend):
        """Test getting session that exists but not in list."""
        mock_get_backend.return_value.session_exists.return_value = True
        mock_get_backend.return_value.list_sessions.return_value = []

        with pytest.raises(ValueError, match="Session 'cao-test' not found"):
            get_session("cao-test")

    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_get_session_error(self, mock_get_backend):
        """Test getting session with error."""
        mock_get_backend.return_value.session_exists.side_effect = Exception("Tmux error")

        with pytest.raises(Exception, match="Tmux error"):
            get_session("cao-test")


class TestDeleteSession:
    """Tests for delete_session function."""

    @patch("cli_agent_orchestrator.services.terminal_service.delete_terminal")
    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_delete_session_success(
        self,
        mock_get_backend,
        mock_list_terminals,
        mock_delete_terminal,
    ):
        """Test deleting session successfully.

        delete_session delegates per-terminal teardown (FIFO reader, status
        buffer, provider, DB) to terminal_service.delete_terminal, then kills
        the backend session and returns the Dict result shape.
        """
        mock_get_backend.return_value.session_exists.return_value = True
        mock_list_terminals.return_value = [
            {"id": "terminal1"},
            {"id": "terminal2"},
        ]

        result = delete_session("cao-test")

        assert result == {"deleted": ["cao-test"], "errors": []}
        mock_get_backend.return_value.kill_session.assert_called_once_with("cao-test")
        # Each terminal is torn down via the event-driven delete_terminal path.
        assert mock_delete_terminal.call_count == 2
        mock_delete_terminal.assert_any_call("terminal1", registry=ANY)
        mock_delete_terminal.assert_any_call("terminal2", registry=ANY)

    @patch("cli_agent_orchestrator.services.terminal_service.delete_terminal")
    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_delete_session_when_backend_session_already_gone(
        self, mock_get_backend, mock_list_terminals, mock_delete_terminal
    ):
        """Backend session already gone — delete_session should not raise and not
        call kill_session, but still tear down each terminal via delete_terminal."""
        mock_get_backend.return_value.session_exists.return_value = False
        mock_list_terminals.return_value = [{"id": "terminal1"}]

        result = delete_session("cao-test")

        assert result == {"deleted": ["cao-test"], "errors": []}
        mock_get_backend.return_value.kill_session.assert_not_called()
        mock_delete_terminal.assert_called_once_with("terminal1", registry=ANY)

    @patch("cli_agent_orchestrator.services.terminal_service.delete_terminal")
    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_delete_session_no_terminals(
        self, mock_get_backend, mock_list_terminals, mock_delete_terminal
    ):
        """Test deleting session with no terminals."""
        mock_get_backend.return_value.session_exists.return_value = True
        mock_list_terminals.return_value = []

        result = delete_session("cao-test")

        assert result == {"deleted": ["cao-test"], "errors": []}
        mock_get_backend.return_value.kill_session.assert_called_once_with("cao-test")
        mock_delete_terminal.assert_not_called()

    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_delete_session_error(self, mock_get_backend, mock_list_terminals):
        """Test deleting session with error."""
        mock_get_backend.return_value.session_exists.return_value = True
        mock_list_terminals.side_effect = Exception("Database error")

        with pytest.raises(Exception, match="Database error"):
            delete_session("cao-test")

    @patch("cli_agent_orchestrator.services.terminal_service.delete_terminal")
    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_delete_session_continues_when_terminal_cleanup_fails(
        self, mock_get_backend, mock_list_terminals, mock_delete_terminal
    ):
        """Test that delete_session continues even when terminal teardown fails for some terminals."""
        mock_get_backend.return_value.session_exists.return_value = True
        mock_list_terminals.return_value = [
            {"id": "terminal1"},
            {"id": "terminal2"},
            {"id": "terminal3"},
        ]

        # First terminal teardown fails, others succeed
        mock_delete_terminal.side_effect = [
            Exception("Terminal teardown error for terminal1"),
            None,  # terminal2 succeeds
            None,  # terminal3 succeeds
        ]

        result = delete_session("cao-test")

        # Session should still be deleted despite per-terminal teardown failure
        assert result == {"deleted": ["cao-test"], "errors": []}
        mock_get_backend.return_value.kill_session.assert_called_once_with("cao-test")
        # All three terminal teardowns were attempted
        assert mock_delete_terminal.call_count == 3

    @patch("cli_agent_orchestrator.services.terminal_service.delete_terminal")
    @patch("cli_agent_orchestrator.services.session_service.list_terminals_by_session")
    @patch("cli_agent_orchestrator.services.session_service.get_backend")
    def test_delete_session_cleans_up_each_terminal(
        self, mock_get_backend, mock_list_terminals, mock_delete_terminal
    ):
        """Test that delete_session tears down every terminal in the session via delete_terminal."""
        mock_get_backend.return_value.session_exists.return_value = True
        mock_list_terminals.return_value = [
            {"id": "term-aaa"},
            {"id": "term-bbb"},
            {"id": "term-ccc"},
            {"id": "term-ddd"},
        ]

        result = delete_session("cao-multi-terminal")

        assert result == {"deleted": ["cao-multi-terminal"], "errors": []}
        # Verify delete_terminal was called for each terminal with the correct ID
        assert mock_delete_terminal.call_count == 4
        mock_delete_terminal.assert_any_call("term-aaa", registry=ANY)
        mock_delete_terminal.assert_any_call("term-bbb", registry=ANY)
        mock_delete_terminal.assert_any_call("term-ccc", registry=ANY)
        mock_delete_terminal.assert_any_call("term-ddd", registry=ANY)
