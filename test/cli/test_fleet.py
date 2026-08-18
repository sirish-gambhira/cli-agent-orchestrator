"""Tests for the laptop fleet launcher."""

from unittest.mock import patch

from click.testing import CliRunner

from cli_agent_orchestrator.cli.fleet import main


def test_existing_controller_is_reused():
    runner = CliRunner()
    with (
        patch("cli_agent_orchestrator.cli.fleet._controller_is_healthy", return_value=True),
        patch(
            "cli_agent_orchestrator.cli.fleet._controller_nodes",
            return_value=["jbom-03", "secure-02"],
        ),
        patch("cli_agent_orchestrator.cli.fleet._open_dashboard") as open_dashboard,
    ):
        result = runner.invoke(main, ["--nodes", "jbom-03, secure-02"])

    assert result.exit_code == 0
    assert "already running" in result.output
    open_dashboard.assert_called_once_with("http://127.0.0.1:9890")


def test_existing_controller_rejects_different_inventory():
    runner = CliRunner()
    with (
        patch("cli_agent_orchestrator.cli.fleet._controller_is_healthy", return_value=True),
        patch("cli_agent_orchestrator.cli.fleet._controller_nodes", return_value=["5c-01"]),
    ):
        result = runner.invoke(main, ["--nodes", "jbom-03", "--no-open"])

    assert result.exit_code == 1
    assert "Stop it before changing --nodes" in result.output


def test_empty_node_list_is_rejected():
    result = CliRunner().invoke(main, ["--nodes", " , ", "--no-open"])

    assert result.exit_code == 2
    assert "At least one SSH node is required" in result.output


def test_legacy_terminal_transport_option_is_removed():
    result = CliRunner().invoke(main, ["--help"])

    assert result.exit_code == 0
    assert "--terminal-transport" not in result.output
