"""Models for the laptop-hosted remote node fleet surface."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class FleetNode(BaseModel):
    """A concrete SSH host alias available to the laptop controller."""

    name: str


class FleetNodeCheck(BaseModel):
    """Result of a non-interactive SSH reachability check."""

    name: str
    status: Literal["reachable", "unreachable"]
    detail: Optional[str] = None


class FleetNodeOverview(BaseModel):
    """Sessions visible on one node during an on-demand fleet refresh."""

    name: str
    status: Literal["reachable", "unreachable"]
    sessions: list[dict] = Field(default_factory=list)
    detail: Optional[str] = None


class FleetConfiguration(BaseModel):
    """Controller inventory and terminal transport configuration."""

    nodes: list[str] = Field(default_factory=list)
    terminal_transport: Literal["ttyd"] = "ttyd"


class FleetTerminalAttachment(BaseModel):
    """One controller-owned ttyd attachment to a remote tmux target."""

    id: str
    node: str
    terminal_id: str
    state: Literal["starting", "live", "failed", "closed"]
    view_url: str
    expires_at: str
    detail: Optional[str] = None


class FleetCachedNode(BaseModel):
    """Last-known state for one persistently monitored execution node."""

    name: str
    status: Literal["live", "stale", "offline", "unmonitored"]
    sessions: list[dict] = Field(default_factory=list)
    sequence: int = 0
    last_seen: Optional[str] = None
    detail: Optional[str] = None
    connection_state: Optional[Literal["connecting", "live", "backoff", "stopped"]] = None


class RemoteDirectoryEntry(BaseModel):
    """One child directory returned by the remote folder browser."""

    name: str
    path: str
    is_git_repository: bool = False
    is_worktree: bool = False


class RemoteDirectoryListing(BaseModel):
    """A bounded, directory-only listing from one SSH node."""

    node: str
    path: str
    parent: Optional[str]
    home: str
    entries: list[RemoteDirectoryEntry] = Field(default_factory=list)
    truncated: bool = False
    is_git_repository: bool = False
    is_worktree: bool = False
    git_branch: Optional[str] = None
