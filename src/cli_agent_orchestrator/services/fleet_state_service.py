"""Reliable cross-node fleet state streaming and controller-side caching."""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import random
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Sequence

import websockets

from cli_agent_orchestrator.constants import CAO_HOME_DIR
from cli_agent_orchestrator.services import session_service
from cli_agent_orchestrator.services.fleet_inventory import configured_fleet_nodes
from cli_agent_orchestrator.services.fleet_service import FleetService, fleet_service

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
SNAPSHOT_INTERVAL_SECONDS = 2.0
HEARTBEAT_INTERVAL_SECONDS = 10.0
STALE_AFTER_SECONDS = 30.0
OFFLINE_AFTER_SECONDS = 120.0
DEFAULT_CACHE_PATH = Path(CAO_HOME_DIR) / "fleet-state.json"
# Stream updates coalesce into one disk write per interval. With N monitored
# nodes each snapshotting every SNAPSHOT_INTERVAL_SECONDS, per-update writes
# scale as N/2 per second and serialize behind the cache lock — at fleet scale
# that stalls every thread touching the cache (observed as wedged /fleet
# requests with 33 nodes). Crash-loss window is this interval; tombstones
# bypass it (see mark_session_deleted).
CACHE_FLUSH_INTERVAL_SECONDS = 5.0
# Blocking tunnel operations run on their own bounded pool. They must never
# share asyncio.to_thread's default executor with request handlers: one slow
# node per worker would starve every proxied /fleet request behind tunnel
# timeouts. Cache mutations stay synchronous because they only update memory
# and schedule the debounced writer.
MONITOR_POOL_WORKERS = 8


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_local_snapshot() -> list[dict[str, Any]]:
    """Return one authoritative, status-enriched snapshot of local sessions."""

    sessions: list[dict[str, Any]] = []
    for summary in session_service.list_sessions():
        try:
            detail = session_service.get_session(summary["id"])
            sessions.append({**summary, "terminals": detail.get("terminals", [])})
        except (KeyError, ValueError):
            # A tmux session can disappear between list and detail. The next
            # snapshot reconciles it; never fail the entire stream for that race.
            continue
    return sessions


class FleetStateCache:
    """Thread-safe last-known node snapshots with atomic disk persistence."""

    def __init__(
        self,
        path: Path = DEFAULT_CACHE_PATH,
        flush_interval: float = CACHE_FLUSH_INTERVAL_SECONDS,
    ) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._nodes: dict[str, dict[str, Any]] = {}
        self._deleted_sessions: dict[str, set[str]] = {}
        self._dirty = False
        self._flush_timer: threading.Timer | None = None
        self._flush_interval = flush_interval
        self._load()

    def _load(self) -> None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("nodes"), dict):
                self._nodes = payload["nodes"]
                tombstones = payload.get("deleted_sessions", {})
                if isinstance(tombstones, dict):
                    self._deleted_sessions = {
                        str(node): {str(name) for name in names}
                        for node, names in tombstones.items()
                        if isinstance(names, list)
                    }
        except (OSError, ValueError, TypeError):
            self._nodes = {}
            self._deleted_sessions = {}

    def _write(self) -> None:
        """Atomically replace the cache file. Caller must hold ``self._lock``.

        No fsync: the atomic rename already prevents torn reads, and this is
        reconstructable last-known state — after a crash the monitor streams
        repopulate it within one snapshot interval, so the durability an fsync
        would buy is worth less than the per-write stall it costs.
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, raw_path = tempfile.mkstemp(prefix="fleet-state-", suffix=".json", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "version": 2,
                        "nodes": self._nodes,
                        "deleted_sessions": {
                            node: sorted(names)
                            for node, names in self._deleted_sessions.items()
                            if names
                        },
                    },
                    handle,
                    separators=(",", ":"),
                )
            os.replace(raw_path, self.path)
        finally:
            try:
                os.unlink(raw_path)
            except FileNotFoundError:
                pass
        self._dirty = False

    def _mark_dirty(self) -> None:
        """Record a pending change and arm the debounced flush. Caller must hold ``self._lock``."""
        self._dirty = True
        if self._flush_timer is None:
            timer = threading.Timer(self._flush_interval, self._flush_due)
            timer.daemon = True
            self._flush_timer = timer
            timer.start()

    def _flush_due(self) -> None:
        try:
            self.flush()
        except OSError:
            logger.warning("Deferred fleet-state flush to %s failed", self.path, exc_info=True)

    def flush(self) -> None:
        """Persist pending changes immediately (timer expiry and shutdown path)."""
        with self._lock:
            if self._flush_timer is not None:
                self._flush_timer.cancel()
                self._flush_timer = None
            if self._dirty:
                self._write()

    def update(
        self, node: str, connection_id: str, sequence: int, sessions: list[dict[str, Any]]
    ) -> None:
        with self._lock:
            current = self._nodes.get(node, {})
            if current.get("connection_id") == connection_id and sequence <= int(
                current.get("sequence", -1)
            ):
                return
            deleted = self._deleted_sessions.get(node, set())
            incoming_names = {
                str(session.get("id") or session.get("name"))
                for session in sessions
                if session.get("id") or session.get("name")
            }
            # A snapshot that no longer contains a tombstoned session is the
            # authoritative stream acknowledgement for that delete. Until then,
            # filter it so an older in-flight snapshot cannot resurrect the row.
            deleted.intersection_update(incoming_names)
            if deleted:
                sessions = [
                    session
                    for session in sessions
                    if str(session.get("id") or session.get("name")) not in deleted
                ]
                self._deleted_sessions[node] = deleted
            else:
                self._deleted_sessions.pop(node, None)
            self._nodes[node] = {
                "name": node,
                "status": "live",
                "sessions": sessions,
                "sequence": sequence,
                "connection_id": connection_id,
                "last_seen": utc_now(),
                "detail": None,
            }
            self._mark_dirty()

    def mark_session_deleted(self, node: str, session_name: str) -> None:
        """Apply a successful remote delete to the cache synchronously.

        The durable tombstone remains until the node stream publishes a
        snapshot where the session is absent, providing read-after-write
        consistency across controller restarts and in-flight snapshots.
        """
        with self._lock:
            deleted = self._deleted_sessions.setdefault(node, set())
            deleted.add(session_name)
            current = self._nodes.setdefault(node, {"name": node, "sessions": [], "sequence": 0})
            current["sessions"] = [
                session
                for session in current.get("sessions", [])
                if str(session.get("id") or session.get("name")) != session_name
            ]
            # Tombstones are the read-after-write guarantee this docstring
            # promises across restarts, so they skip the debounce window.
            self._write()

    def clear_session_tombstone(self, node: str, session_name: str) -> None:
        """Allow an explicitly recreated session name to appear again."""
        with self._lock:
            deleted = self._deleted_sessions.get(node)
            if not deleted or session_name not in deleted:
                return
            deleted.discard(session_name)
            if not deleted:
                self._deleted_sessions.pop(node, None)
            self._write()

    def heartbeat(self, node: str, connection_id: str, sequence: int) -> None:
        with self._lock:
            current = self._nodes.setdefault(node, {"name": node, "sessions": []})
            if current.get("connection_id") == connection_id and sequence <= int(
                current.get("sequence", -1)
            ):
                return
            current.update(
                connection_id=connection_id, sequence=sequence, last_seen=utc_now(), detail=None
            )
            self._mark_dirty()

    def failure(self, node: str, detail: str) -> None:
        with self._lock:
            current = self._nodes.setdefault(node, {"name": node, "sessions": [], "sequence": 0})
            current["detail"] = detail[:300]
            self._mark_dirty()

    def view(
        self,
        nodes: Sequence[str] | None = None,
        monitored_nodes: Sequence[str] | None = None,
    ) -> list[dict[str, Any]]:
        now = datetime.now(timezone.utc)
        selected = set(nodes) if nodes is not None else None
        monitored = set(monitored_nodes) if monitored_nodes is not None else None
        with self._lock:
            result = []
            for name, raw in self._nodes.items():
                if selected is not None and name not in selected:
                    continue
                item = dict(raw)
                try:
                    age = (now - datetime.fromisoformat(item["last_seen"])).total_seconds()
                except (KeyError, TypeError, ValueError):
                    age = float("inf")
                if monitored is not None and name not in monitored:
                    item["status"] = "unmonitored"
                else:
                    item["status"] = (
                        "live"
                        if age <= STALE_AFTER_SECONDS
                        else "stale" if age <= OFFLINE_AFTER_SECONDS else "offline"
                    )
                result.append(item)
            return sorted(result, key=lambda item: item["name"].lower())


class FleetStateMonitor:
    """Maintain one reconnecting WebSocket stream per explicitly managed node."""

    def __init__(self, service: FleetService, cache: FleetStateCache | None = None) -> None:
        self.service = service
        self.cache = cache or FleetStateCache()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._executor: ThreadPoolExecutor | None = None

    def _run_tunnel_op(self, fn: Callable[..., Any], *args: Any) -> Awaitable[Any]:
        """Run a blocking tunnel operation on the monitor's bounded pool.

        Deliberately not asyncio.to_thread: that shares one default executor
        with the request handlers (/fleet proxy and overview), so monitor
        tasks blocked on tunnel startup would starve every proxied request.
        """
        if self._executor is None:
            self._executor = ThreadPoolExecutor(
                max_workers=MONITOR_POOL_WORKERS, thread_name_prefix="fleet-monitor"
            )
        return asyncio.get_running_loop().run_in_executor(
            self._executor, functools.partial(fn, *args)
        )

    @staticmethod
    def configured_nodes() -> list[str]:
        return configured_fleet_nodes()

    def start(self) -> None:
        self.ensure_nodes(self.configured_nodes())

    def ensure_nodes(self, nodes: Sequence[str]) -> None:
        for node in nodes:
            self.service.validate_node(node)
            if node not in self._tasks or self._tasks[node].done():
                self._tasks[node] = asyncio.create_task(
                    self._monitor(node), name=f"fleet-state-{node}"
                )

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        executor, self._executor = self._executor, None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)
        await asyncio.to_thread(self.cache.flush)

    async def _monitor(self, node: str) -> None:
        delay = 1.0
        while True:
            try:
                tunnel = await self._run_tunnel_op(self.service.tunnels.ensure, node)
                url = f"ws://127.0.0.1:{tunnel.local_port}/fleet/state/ws"
                async with websockets.connect(
                    url, origin=None, ping_interval=15, ping_timeout=15
                ) as remote:
                    delay = 1.0
                    async for raw in remote:
                        message = json.loads(raw)
                        if message.get("protocol") != PROTOCOL_VERSION:
                            raise ValueError("unsupported fleet state protocol")
                        sequence = int(message.get("sequence", 0))
                        connection_id = str(message.get("connection_id", ""))
                        if not connection_id:
                            raise ValueError("fleet message missing connection id")
                        if message.get("type") == "snapshot":
                            sessions = message.get("sessions", [])
                            if not isinstance(sessions, list):
                                raise ValueError("invalid fleet snapshot")
                            self.cache.update(node, connection_id, sequence, sessions)
                        elif message.get("type") == "heartbeat":
                            self.cache.heartbeat(node, connection_id, sequence)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._run_tunnel_op(self.service.tunnels.drop, node)
                self.cache.failure(node, f"{type(exc).__name__}: {exc}")
                await asyncio.sleep(delay * random.uniform(0.8, 1.2))
                delay = min(delay * 2, 30.0)


fleet_state_monitor = FleetStateMonitor(fleet_service)
