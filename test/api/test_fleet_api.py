"""API contract tests for the laptop fleet endpoints."""

from unittest.mock import AsyncMock

from cli_agent_orchestrator.models.fleet import (
    FleetNode,
    FleetNodeCheck,
    FleetNodeOverview,
    FleetTerminalAttachment,
    RemoteDirectoryListing,
)
from cli_agent_orchestrator.services import fleet_service
from cli_agent_orchestrator.services.fleet_service import FleetProxyResponse, NodeNotReadyError
from cli_agent_orchestrator.services.fleet_state_service import fleet_state_monitor
from cli_agent_orchestrator.services.terminal_gateway_service import terminal_gateway_service


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
    monkeypatch.setenv("CAO_FLEET_NODES", "jbom-02")
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
    monkeypatch.setenv("CAO_FLEET_NODES", "secure-02")
    monkeypatch.setattr(
        fleet_state_monitor.cache,
        "view",
        lambda nodes, monitored_nodes: [
            {
                "name": "secure-02",
                "status": "stale",
                "sessions": [{"id": "cao-one"}],
                "sequence": 4,
                "last_seen": "2026-08-10T00:00:00+00:00",
                "detail": "reconnecting",
            }
        ],
    )

    response = client.get("/fleet/state")

    assert response.status_code == 200
    assert response.json()[0]["status"] == "stale"
    assert response.json()[0]["sessions"] == [{"id": "cao-one"}]


def test_fleet_configuration_reports_authoritative_inventory(client, monkeypatch):
    monkeypatch.setenv("CAO_FLEET_NODES", "5c-01, secure-02,5c-01")

    response = client.get("/fleet/config")

    assert response.status_code == 200
    assert response.json() == {
        "nodes": ["5c-01", "secure-02"],
        "terminal_transport": "ttyd",
    }


def test_fleet_state_with_40_nodes_is_cache_only(client, monkeypatch):
    nodes = [f"node-{index:02d}" for index in range(40)]
    monkeypatch.setenv("CAO_FLEET_NODES", ",".join(nodes))
    calls = []

    def view(selected, monitored_nodes):
        calls.append((selected, monitored_nodes))
        return [
            {
                "name": "node-00",
                "status": "live",
                "sessions": [{"id": "session-1"}],
                "sequence": 1,
                "last_seen": "2026-08-18T00:00:00+00:00",
                "detail": None,
            }
        ]

    monkeypatch.setattr(fleet_state_monitor.cache, "view", view)

    response = client.get("/fleet/state")

    assert response.status_code == 200
    assert response.json()[0]["sessions"] == [{"id": "session-1"}]
    assert calls == [(nodes, nodes)]


def test_create_ttyd_attachment_uses_verified_remote_terminal(client, monkeypatch):
    monkeypatch.setenv("CAO_FLEET_NODES", "5c-01")
    proxy = AsyncMock(
        return_value=FleetProxyResponse(
            200,
            b'{"id":"term-1","session_name":"session-1","name":"window-1"}',
            "application/json",
        )
    )
    create = AsyncMock(
        return_value=FleetTerminalAttachment(
            id="attach-1",
            node="5c-01",
            terminal_id="term-1",
            state="live",
            view_url="/fleet/attachments/attach-1/view",
            expires_at="2026-08-19T00:00:00+00:00",
        )
    )
    monkeypatch.setattr(fleet_service.fleet_service, "proxy_request_async", proxy)
    monkeypatch.setattr(terminal_gateway_service, "create_async", create)

    response = client.post("/fleet/nodes/5c-01/terminals/term-1/attachments")

    assert response.status_code == 201
    assert response.json()["view_url"] == "/fleet/attachments/attach-1/view"
    create.assert_awaited_once_with(
        node="5c-01",
        terminal_id="term-1",
        session_name="session-1",
        window_name="window-1",
    )


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


def test_successful_remote_session_delete_updates_fleet_cache(client, monkeypatch):
    marked = []

    monkeypatch.setattr(
        fleet_service.fleet_service,
        "proxy_request",
        lambda **kwargs: FleetProxyResponse(200, b'{"success":true}', "application/json"),
    )
    monkeypatch.setattr(
        fleet_state_monitor.cache,
        "mark_session_deleted",
        lambda node, name: marked.append((node, name)),
    )

    response = client.delete("/fleet/nodes/secure-02/proxy/sessions/tgt-deleted")

    assert response.status_code == 200
    assert marked == [("secure-02", "tgt-deleted")]


def test_proxy_rejects_non_cao_surface(client, monkeypatch):
    def proxy_request(**kwargs):
        raise AssertionError("proxy must not be invoked")

    monkeypatch.setattr(fleet_service.fleet_service, "proxy_request", proxy_request)

    response = client.get("/fleet/nodes/jbom-02/proxy/fleet/nodes")

    assert response.status_code == 404


def test_proxy_fails_fast_while_node_actor_connects(client, monkeypatch):
    monkeypatch.setattr(
        fleet_service.fleet_service,
        "proxy_request_async",
        AsyncMock(side_effect=NodeNotReadyError("5c-01", "connecting")),
    )

    response = client.get("/fleet/nodes/5c-01/proxy/health")

    assert response.status_code == 503
    assert response.headers["retry-after"] == "2"
    assert response.json()["detail"]["kind"] == "node_not_ready"


def test_legacy_remote_terminal_websocket_route_is_removed(client):
    paths = {getattr(route, "path", None) for route in client.app.routes}

    assert "/fleet/nodes/{node}/terminals/{terminal_id}/ws" not in paths
