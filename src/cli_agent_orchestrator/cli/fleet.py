"""Laptop-facing launcher for the CAO remote-node fleet dashboard."""

from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.request
import webbrowser

import click

from cli_agent_orchestrator.services.fleet_inventory import parse_fleet_nodes

DEFAULT_NODES = "jbom-03,secure-02"


def _controller_is_healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=1.0) as response:
            return int(response.status) == 200
    except (OSError, urllib.error.URLError):
        return False


def _controller_nodes(url: str) -> list[str] | None:
    """Return the running controller inventory, or None for an incompatible controller."""

    try:
        with urllib.request.urlopen(f"{url}/fleet/config", timeout=1.0) as response:
            payload = json.load(response)
        nodes = payload.get("nodes") if isinstance(payload, dict) else None
        if not isinstance(nodes, list) or not all(isinstance(node, str) for node in nodes):
            return None
        return parse_fleet_nodes(",".join(nodes))
    except (OSError, ValueError, TypeError, urllib.error.URLError):
        return None


def _open_dashboard(url: str) -> None:
    webbrowser.open(url)


@click.command(context_settings={"help_option_names": ["-h", "--help"]})
@click.option(
    "--nodes",
    default=lambda: os.environ.get("CAO_FLEET_NODES", DEFAULT_NODES),
    show_default=DEFAULT_NODES,
    help="Comma-separated SSH host aliases monitored by the laptop controller.",
)
@click.option("--host", default="127.0.0.1", show_default=True, help="Controller bind host.")
@click.option("--port", default=9890, show_default=True, type=click.IntRange(1, 65535))
@click.option("--open/--no-open", "open_browser", default=True, show_default=True)
def main(nodes: str, host: str, port: int, open_browser: bool) -> None:
    """Start or open the remote agent fleet dashboard."""

    requested_nodes = parse_fleet_nodes(nodes)
    if not requested_nodes:
        raise click.UsageError("At least one SSH node is required via --nodes")
    normalized_nodes = ",".join(requested_nodes)

    browser_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{browser_host}:{port}"
    if _controller_is_healthy(url):
        running_nodes = _controller_nodes(url)
        if running_nodes is None:
            raise click.ClickException(
                f"A controller is already running at {url}, but its fleet inventory "
                "cannot be verified. Stop it before changing --nodes."
            )
        if running_nodes != requested_nodes:
            raise click.ClickException(
                f"A controller is already running at {url} for nodes "
                f"{','.join(running_nodes) or '(none)'}; requested {normalized_nodes}. "
                "Stop it before changing --nodes."
            )
        click.echo(f"Fleet controller is already running: {url}")
        if open_browser:
            _open_dashboard(url)
        return

    os.environ["CAO_FLEET_NODES"] = normalized_nodes
    os.environ["CAO_API_HOST"] = host
    os.environ["CAO_API_PORT"] = str(port)

    click.echo(f"Starting fleet controller at {url}")
    click.echo(f"Nodes: {normalized_nodes}")
    click.echo("Press Ctrl-C to stop.")
    if open_browser:
        threading.Timer(0.8, _open_dashboard, args=(url,)).start()

    # Import only after the environment is established: API constants and the
    # fleet state monitor intentionally read their defaults at import time.
    from cli_agent_orchestrator.api.main import main as server_main

    sys.argv = ["cao-server", "--host", host, "--port", str(port)]
    server_main()


if __name__ == "__main__":
    main()
