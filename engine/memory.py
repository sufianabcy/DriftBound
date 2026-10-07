"""Concept memory: the rules the engine has learned, searched first after a drift."""

from __future__ import annotations

import bisect
from dataclasses import dataclass


@dataclass
class StoredRule:
    theta: int
    learned_at_step: int
    reuse_count: int = 0
    last_used_step: int = 0

    @property
    def key(self) -> str:
        return f"theta:{self.theta}"


class ConceptMemory:
    """At most `capacity` thresholds; the least recently used one is evicted.

    The cap keeps recall cheap: recall costs ceil(log2 K) + 2 labels, so a
    large memory would cost more than the plain 10-label search it replaces.
    """

    def __init__(self, capacity: int = 8):
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self.capacity = capacity
        self._rules: dict[int, StoredRule] = {}

    def __len__(self) -> int:
        return len(self._rules)

    def __contains__(self, theta: int) -> bool:
        return theta in self._rules

    def thetas(self) -> list[int]:
        return sorted(self._rules)

    def candidates(self, lo: int, hi: int) -> list[int]:
        """Stored thresholds still consistent with the version space [lo, hi]."""
        ts = self.thetas()
        return ts[bisect.bisect_left(ts, lo) : bisect.bisect_right(ts, hi)]

    def get(self, theta: int) -> StoredRule | None:
        return self._rules.get(theta)

    def remember(self, theta: int, step: int) -> tuple[StoredRule, bool, StoredRule | None]:
        """Store a learned rule. Returns (entry, was_already_stored, evicted)."""
        entry = self._rules.get(theta)
        if entry is not None:
            entry.reuse_count += 1
            entry.last_used_step = step
            return entry, True, None
        evicted = None
        if len(self._rules) >= self.capacity:
            evicted = min(self._rules.values(), key=lambda r: r.last_used_step)
            del self._rules[evicted.theta]
        entry = StoredRule(theta=theta, learned_at_step=step, last_used_step=step)
        self._rules[theta] = entry
        return entry, False, evicted

    def clear(self) -> None:
        self._rules.clear()
