import asyncio
import threading
import time
from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.services.fleet_state_service import (
    MONITOR_POOL_WORKERS,
    FleetStateCache,
    FleetStateMonitor,
)


def test_cache_persists_snapshot_and_survives_failure(tmp_path):
    path = tmp_path / "fleet-state.json"
    cache = FleetStateCache(path)
    sessions = [{"id": "cao-one", "terminals": [{"id": "agent-one"}]}]

    cache.update("secure-02", "stream-a", 1, sessions)
    cache.failure("secure-02", "temporary disconnect")
    cache.flush()

    restored = FleetStateCache(path).view(["secure-02"])[0]
    assert restored["sessions"] == sessions
    assert restored["detail"] == "temporary disconnect"
    assert restored["status"] == "live"


def test_stream_updates_debounce_disk_writes(tmp_path):
    path = tmp_path / "fleet-state.json"
    cache = FleetStateCache(path)

    cache.update("secure-02", "stream-a", 1, [{"id": "cao-one"}])
    assert not path.exists()

    cache.flush()
    assert FleetStateCache(path).view(["secure-02"])[0]["sessions"] == [{"id": "cao-one"}]


def test_stream_updates_flush_after_debounce_interval(tmp_path):
    path = tmp_path / "fleet-state.json"
    cache = FleetStateCache(path, flush_interval=0.01)

    cache.update("secure-02", "stream-a", 1, [{"id": "cao-one"}])

    deadline = time.monotonic() + 1.0
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert FleetStateCache(path).view(["secure-02"])[0]["sessions"] == [{"id": "cao-one"}]


@pytest.mark.asyncio
async def test_monitor_uses_dedicated_executor(tmp_path):
    cache = FleetStateCache(tmp_path / "fleet-state.json")
    monitor = FleetStateMonitor(service=Mock(), cache=cache)

    try:
        thread_name = await monitor._run_tunnel_op(lambda: threading.current_thread().name)
    finally:
        await monitor.stop()

    assert thread_name.startswith("fleet-monitor")


@pytest.mark.asyncio
async def test_blocked_tunnel_pool_does_not_starve_default_executor(tmp_path):
    cache = FleetStateCache(tmp_path / "fleet-state.json")
    monitor = FleetStateMonitor(service=Mock(), cache=cache)
    release = threading.Event()
    all_started = threading.Barrier(MONITOR_POOL_WORKERS + 1)

    def block_tunnel_worker() -> None:
        all_started.wait()
        release.wait()

    blocked = [
        asyncio.ensure_future(monitor._run_tunnel_op(block_tunnel_worker))
        for _ in range(MONITOR_POOL_WORKERS)
    ]
    try:
        await asyncio.wait_for(asyncio.to_thread(all_started.wait), timeout=1.0)
        result = await asyncio.wait_for(asyncio.to_thread(lambda: "available"), timeout=1.0)
    finally:
        release.set()
        await asyncio.gather(*blocked)
        await monitor.stop()

    assert result == "available"


def test_cache_rejects_duplicate_sequence_within_one_connection(tmp_path):
    cache = FleetStateCache(tmp_path / "fleet-state.json")
    cache.update("secure-02", "stream-a", 2, [{"id": "new"}])
    cache.update("secure-02", "stream-a", 1, [{"id": "old"}])

    assert cache.view()[0]["sessions"] == [{"id": "new"}]


def test_new_connection_may_restart_sequence(tmp_path):
    cache = FleetStateCache(tmp_path / "fleet-state.json")
    cache.update("secure-02", "stream-a", 20, [{"id": "old"}])
    cache.update("secure-02", "stream-b", 1, [{"id": "reconciled"}])

    assert cache.view()[0]["sessions"] == [{"id": "reconciled"}]


def test_unconfigured_historical_node_is_not_reported_offline(tmp_path):
    cache = FleetStateCache(tmp_path / "fleet-state.json")
    cache.update("old-node", "stream-a", 1, [])

    view = cache.view(["old-node"], monitored_nodes=["current-node"])

    assert view[0]["status"] == "unmonitored"


def test_delete_tombstone_prevents_stale_snapshot_resurrection(tmp_path):
    cache = FleetStateCache(tmp_path / "fleet-state.json")
    cache.update("secure-02", "stream-a", 1, [{"id": "tgt-deleted"}, {"id": "tgt-live"}])

    cache.mark_session_deleted("secure-02", "tgt-deleted")
    assert cache.view()[0]["sessions"] == [{"id": "tgt-live"}]

    cache.update(
        "secure-02",
        "stream-a",
        2,
        [{"id": "tgt-deleted"}, {"id": "tgt-live"}],
    )
    assert cache.view()[0]["sessions"] == [{"id": "tgt-live"}]


def test_delete_tombstone_clears_after_stream_confirms_absence(tmp_path):
    cache = FleetStateCache(tmp_path / "fleet-state.json")
    cache.update("secure-02", "stream-a", 1, [{"id": "tgt-reusable"}])
    cache.mark_session_deleted("secure-02", "tgt-reusable")

    cache.update("secure-02", "stream-a", 2, [])
    cache.update("secure-02", "stream-a", 3, [{"id": "tgt-reusable"}])

    assert cache.view()[0]["sessions"] == [{"id": "tgt-reusable"}]


def test_delete_tombstone_survives_controller_restart(tmp_path):
    path = tmp_path / "fleet-state.json"
    cache = FleetStateCache(path)
    cache.update("secure-02", "stream-a", 1, [{"id": "tgt-deleted"}])
    cache.mark_session_deleted("secure-02", "tgt-deleted")

    restored = FleetStateCache(path)
    restored.update("secure-02", "stream-a", 2, [{"id": "tgt-deleted"}])

    assert restored.view()[0]["sessions"] == []
