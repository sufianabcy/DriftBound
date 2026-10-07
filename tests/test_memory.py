"""Concept memory: Theorem 5 of docs/theory.md, plus the memory mechanics."""

import random

from engine import bounds
from engine.exact import ExactEngine
from engine.memory import ConceptMemory
from engine.runner import RunConfig, Runner
from tests.helpers import event_of, has_event, identify, memory_with, run_until, settle

N = 1023


def test_returning_rule_is_recovered_within_log2k_plus_2_labels():
    rng = random.Random(0)
    for k in range(1, 9):
        for _ in range(30):
            stored = rng.sample(range(1, N + 2), k)
            memory = memory_with(stored)
            for target in stored:
                engine = ExactEngine(N, memory)
                labels = identify(engine, target)
                assert engine.lo == target
                assert engine.path == "memory"
                assert labels <= bounds.recall_labels(k)


def test_new_rule_falls_back_and_stays_within_its_bound():
    rng = random.Random(1)
    for k in range(1, 9):
        for _ in range(30):
            stored = rng.sample(range(1, N + 2), k)
            memory = memory_with(stored)
            target = rng.choice([t for t in range(1, N + 2) if t not in stored])
            engine = ExactEngine(N, memory)
            labels = identify(engine, target)
            assert engine.lo == target
            assert engine.path == "memory_fallback"
            assert labels <= bounds.recall_fallback_labels(k, N)


def test_recall_skips_the_rule_that_was_just_contradicted():
    memory = memory_with([300])
    engine = ExactEngine(N, memory)
    identify(engine, 300)
    assert engine.update(250, 1)  # a clean label no remaining rule explains
    engine.reset_after_drift()
    assert engine.recall_k == 0
    assert engine.path == "full"
    assert identify(engine, 700) == 10


def test_recall_is_skipped_when_it_cannot_beat_plain_search():
    n = 15  # 16 rules: plain binary search needs 4 labels, recall of 4 rules too
    engine = ExactEngine(n, memory_with([2, 5, 9, 14]))
    assert engine.recall_k == 0
    assert engine.path == "full"


def test_least_recently_used_rule_is_evicted():
    memory = ConceptMemory(capacity=2)
    memory.remember(10, step=1)
    memory.remember(20, step=2)
    _, reused, _ = memory.remember(10, step=3)
    assert reused
    _, _, evicted = memory.remember(30, step=4)
    assert evicted.theta == 20
    assert memory.thetas() == [10, 30]
    assert memory.get(10).reuse_count == 1


def test_recurring_drift_end_to_end():
    runner = Runner(RunConfig(seed=2))
    settle(runner)
    first = runner.stream.theta
    runner.inject("abrupt")
    run_until(runner, has_event("recovered"))
    runner.inject("recurring", theta=first)
    recovered = event_of(run_until(runner, has_event("recovered")), "recovered")
    assert recovered["path"] == "memory"
    assert recovered["correct"]
    assert recovered["labels"] <= recovered["bound"] == bounds.recall_labels(recovered["recall_k"])
    assert recovered["labels"] < bounds.recovery_labels(N)
