"""Plain-terminal provider that does not launch an agent CLI."""

from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.providers.base import BaseProvider


class NoneProvider(BaseProvider):
    """Keep the newly created pane at its shell prompt."""

    @property
    def paste_enter_count(self) -> int:
        return 1

    async def initialize(self) -> bool:
        self._status = TerminalStatus.IDLE
        return True

    def get_status(self, buffer: str) -> TerminalStatus:
        return TerminalStatus.IDLE

    def extract_last_message_from_script(self, script_output: str) -> str:
        return script_output

    def exit_cli(self) -> str:
        return "exit"

    def cleanup(self) -> None:
        return None
