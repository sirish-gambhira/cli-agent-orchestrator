"""Authoritative configured inventory for the laptop fleet controller."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable

FLEET_NODES_ENV = "CAO_FLEET_NODES"


def parse_fleet_nodes(raw: str) -> list[str]:
    """Parse a comma-separated inventory, preserving order and removing duplicates."""

    result: list[str] = []
    seen: set[str] = set()
    for value in raw.split(","):
        node = value.strip()
        if node and node not in seen:
            result.append(node)
            seen.add(node)
    return result


def configured_fleet_nodes() -> list[str]:
    """Return the process-level fleet inventory."""

    return parse_fleet_nodes(os.environ.get(FLEET_NODES_ENV, ""))


@dataclass(frozen=True)
class FleetInventory:
    """Immutable inventory projection shared by API, monitor, and launcher."""

    nodes: tuple[str, ...]

    @classmethod
    def from_environment(cls) -> "FleetInventory":
        return cls(tuple(configured_fleet_nodes()))

    @classmethod
    def from_nodes(cls, nodes: Iterable[str]) -> "FleetInventory":
        return cls(tuple(parse_fleet_nodes(",".join(nodes))))

    def contains(self, node: str) -> bool:
        return node in self.nodes

    def as_list(self) -> list[str]:
        return list(self.nodes)
