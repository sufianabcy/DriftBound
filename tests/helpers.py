"""Small helpers shared by the engine tests."""

from __future__ import annotations

from engine.exact import ExactEngine
from engine.memory import ConceptMemory
from engine.runner import Runner


def run_until(runner: Runner, predicate, limit: int = 100_000) -> dict:
    """Step until predicate(tick) is true; return that tick."""
    for _ in range(limit):
        tick = runner.step()
        if predicate(tick):
            return tick
    raise AssertionError(f"condition not reached within {limit} steps")


def has_event(kind: str):
    return lambda tick: any(e["type"] == kind for e in tick["events"])


def event_of(tick: dict, kind: str) -> dict:
    return next(e for e in tick["events"] if e["type"] == kind)


def settle(runner: Runner, limit: int = 10_000) -> None:
    """Step until the engine is monitoring (one rule left)."""
    if runner.state != "monitoring":
        run_until(runner, lambda t: t["state"] == "monitoring", limit)


def identify(engine: ExactEngine, theta: int, answer=None) -> int:
    """Run a recovery against a fixed rule (or an answering function); return labels used."""
    labels = 0
    while (q := engine.next_query()) is not None:
        assert 1 <= q <= engine.n, "queries must be real inputs"
        y = int(q >= theta) if answer is None else answer(engine, q)
        engine.update(q, y)
        labels += 1
    return labels


def memory_with(thetas: list[int], capacity: int = 8) -> ConceptMemory:
    memory = ConceptMemory(capacity)
    for step, theta in enumerate(thetas):
        memory.remember(theta, step)
    return memory
