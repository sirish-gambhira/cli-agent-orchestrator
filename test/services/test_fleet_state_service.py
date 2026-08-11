from cli_agent_orchestrator.services.fleet_state_service import FleetStateCache


def test_cache_persists_snapshot_and_survives_failure(tmp_path):
    path = tmp_path / "fleet-state.json"
    cache = FleetStateCache(path)
    sessions = [{"id": "cao-one", "terminals": [{"id": "agent-one"}]}]

    cache.update("secure-02", "stream-a", 1, sessions)
    cache.failure("secure-02", "temporary disconnect")

    restored = FleetStateCache(path).view(["secure-02"])[0]
    assert restored["sessions"] == sessions
    assert restored["detail"] == "temporary disconnect"
    assert restored["status"] == "live"


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
