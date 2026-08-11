"""Helpers for managing CAO environment variables."""

import os
from pathlib import Path
from string import Template

from dotenv import dotenv_values, set_key, unset_key

from cli_agent_orchestrator.constants import CAO_ENV_FILE


def ensure_user_executable_path() -> bool:
    """Make standard per-user CLI installs visible to server subprocesses.

    Background launchers such as tmux, systemd, and non-login SSH commands do
    not necessarily source shell startup files.  Provider installers commonly
    place their launchers in ``~/.local/bin``, so a server started by one of
    those launchers could report an installed provider as unavailable and fail
    to launch it.  Mirror the usual login-shell behaviour at process startup.

    Returns ``True`` when ``PATH`` was changed.  Existing entries are preserved
    and the operation is idempotent.
    """
    user_bin = Path.home() / ".local" / "bin"
    if not user_bin.is_dir():
        return False

    user_bin_text = str(user_bin)
    current_path = os.environ.get("PATH", "")
    entries = [entry for entry in current_path.split(os.pathsep) if entry]
    if user_bin_text in entries:
        return False

    os.environ["PATH"] = os.pathsep.join([user_bin_text, *entries])
    return True


def load_env_vars() -> dict[str, str]:
    """Load managed environment variables from the CAO .env file."""
    if not CAO_ENV_FILE.exists():
        return {}

    env_values = dotenv_values(CAO_ENV_FILE)
    return {key: value for key, value in env_values.items() if value is not None}


def resolve_env_vars(raw_text: str) -> str:
    """Resolve ``${VAR}`` placeholders from the managed CAO .env file."""
    return Template(raw_text).safe_substitute(load_env_vars())


def set_env_var(key: str, value: str) -> None:
    """Create or update a managed environment variable."""
    CAO_ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not CAO_ENV_FILE.exists():
        CAO_ENV_FILE.touch(mode=0o600, exist_ok=True)
    set_key(str(CAO_ENV_FILE), key, value)


def unset_env_var(key: str) -> None:
    """Remove a managed environment variable if the env file exists."""
    if not CAO_ENV_FILE.exists():
        return
    unset_key(str(CAO_ENV_FILE), key)


def list_env_vars() -> dict[str, str]:
    """Return the current managed environment variables."""
    return load_env_vars()
