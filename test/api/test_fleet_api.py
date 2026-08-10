"""API contract tests for the laptop fleet endpoints."""

from cli_agent_orchestrator.models.fleet import (
    FleetNode,
    FleetNodeCheck,
    FleetNodeOverview,
    RemoteDirectoryListing,
)
from cli_agent_orchestrator.services import fleet_service
from cli_agent_orchestrator.services.fleet_service import FleetProxyResponse
from cli_agent_orchestrator.services.fleet_state_service import fleet_state_monitor


def test_list_fleet_nodes(client, monkeypatch):
    monkeypatch.setattr(
        fleet_service.fleet_service,
        "list_nodes",
        lambda: [FleetNode(name="jbom-02"), FleetNode(name="secure-02")],
    )

    response = client.get("/fleet/nodes")

    assert response.status_code == 200
    assert response.json() == [{"name": "jbom-02"}, {"name": "secure-02"}]


def test_check_fleet_node(client, monkeypatch):
    monkeypatch.setattr(
        fleet_service.fleet_service,
        "check_node",
        lambda node: FleetNodeCheck(name=node, status="reachable"),
    )

    response = client.get("/fleet/nodes/jbom-02/check")

    assert response.status_code == 200
    assert response.json() == {"name": "jbom-02", "status": "reachable", "detail": None}


def test_browse_fleet_node_directories(client, monkeypatch):
    def browse(node, path, include_hidden, limit):
        assert (node, path, include_hidden, limit) == ("jbom-02", "/work", True, 25)
        return RemoteDirectoryListing(
            node=node,
            path=path,
            parent="/",
            home="/home/dev",
            entries=[],
        )

    monkeypatch.setattr(fleet_service.fleet_service, "browse_directories", browse)

    response = client.get(
        "/fleet/nodes/jbom-02/directories",
        params={"path": "/work", "include_hidden": "true", "limit": 25},
    )

    assert response.status_code == 200
    assert response.json()["path"] == "/work"


def test_browse_limit_is_bounded(client):
    response = client.get("/fleet/nodes/jbom-02/directories", params={"limit": 501})

    assert response.status_code == 422


def test_fleet_overview(client, monkeypatch):
    monkeypatch.setattr(
        fleet_service.fleet_service,
        "fleet_overview",
        lambda nodes: [
            FleetNodeOverview(
                name="jbom-02",
                status="reachable",
                sessions=[{"id": "cao-one", "name": "one", "status": "active"}],
            )
        ],
    )

    response = client.get("/fleet/overview")

    assert response.status_code == 200
    assert response.json()[0]["sessions"][0]["id"] == "cao-one"


def test_cached_fleet_state(client, monkeypatch):
    monkeypatch.setattr(
        fleet_state_monitor.cache,
        "view",
        lambda nodes: [{
            "name": "secure-02",
            "status": "stale",
            "sessions": [{"id": "cao-one"}],
            "sequence": 4,
            "last_seen": "2026-08-10T00:00:00+00:00",
            "detail": "reconnecting",
        }],
    )

    response = client.get("/fleet/state")

    assert response.status_code == 200
    assert response.json()[0]["status"] == "stale"
    assert response.json()[0]["sessions"] == [{"id": "cao-one"}]


def test_proxy_forwards_allowlisted_remote_api(client, monkeypatch):
    calls = []

    def proxy_request(**kwargs):
        calls.append(kwargs)
        return FleetProxyResponse(200, b'[{"id":"cao-one"}]', "application/json")

    monkeypatch.setattr(fleet_service.fleet_service, "proxy_request", proxy_request)

    response = client.get("/fleet/nodes/jbom-02/proxy/sessions", params={"limit": 2})

    assert response.status_code == 200
    assert response.json() == [{"id": "cao-one"}]
    assert calls[0]["remote_path"] == "/sessions"
    assert calls[0]["query"] == "limit=2"


def test_proxy_rejects_non_cao_surface(client, monkeypatch):
    def proxy_request(**kwargs):
        raise AssertionError("proxy must not be invoked")

    monkeypatch.setattr(fleet_service.fleet_service, "proxy_request", proxy_request)

    response = client.get("/fleet/nodes/jbom-02/proxy/fleet/nodes")

    assert response.status_code == 404
