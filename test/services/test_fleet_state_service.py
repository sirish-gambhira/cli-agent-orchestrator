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
