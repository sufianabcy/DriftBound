"""The adversary strategies, each one showing a result from docs/theory.md."""

import random

from engine import bounds
from engine.runner import RunConfig, Runner
from tests.helpers import has_event, run_until, settle

N = 1023


def recoveries_under_attack(runner: Runner, steps: int) -> list[dict]:
    found = []
    for _ in range(steps):
        tick = runner.step()
        found += [e for e in tick["events"] if e["type"] == "recovered" and not e["initial"]]
    return found


def test_worst_case_answers_force_exactly_ten_labels_without_memory():
    runner = Runner(RunConfig(seed=4, memory=False))
    settle(runner)
    runner.set_adversary("worst_case", True, gap=20)
    recs = recoveries_under_attack(runner, 3_000)
    assert len(recs) >= 5
    assert all(r["labels"] == bounds.recovery_labels(N) for r in recs)
    assert all(r["correct"] for r in recs)


def test_worst_case_answers_defeat_memory():
    runner = Runner(RunConfig(seed=4))
    settle(runner)
    for _ in range(4):  # fill the memory with a few rules
        runner.inject("abrupt")
        run_until(runner, has_event("recovered"))
    runner.set_adversary("worst_case", True, gap=20)
    recs = recoveries_under_attack(runner, 3_000)
    assert len(recs) >= 5
    assert all(r["labels"] >= bounds.recovery_labels(N) for r in recs)
    assert all(r["labels"] <= r["bound"] for r in recs)


def test_halving_adversary_beats_every_query_strategy():
    """After 9 answers at least 2 rules survive, whatever the learner asks."""
    rng = random.Random(0)
    strategies = {
        "binary search": lambda lo, hi, i: (lo + hi - 1) // 2,
        "scan from the left": lambda lo, hi, i: lo,
        "random point": lambda lo, hi, i: rng.randint(lo, hi - 1),
        "guess near 500 first": lambda lo, hi, i: min(max(lo, 499 + i), hi - 1),
        "one third": lambda lo, hi, i: lo + (hi - lo) // 3,
    }
    for name, ask in strategies.items():
        lo, hi = 1, N + 1
        for i in range(bounds.recovery_labels(N) - 1):
            q = ask(lo, hi, i)
            assert lo <= q < hi, name
            if q - lo + 1 >= hi - q:  # answer 1 keeps [lo, q], answer 0 keeps [q + 1, hi]
                hi = q
            else:
                lo = q + 1
        assert hi - lo + 1 >= 2, name


def test_rapid_fire_at_k1_makes_every_prediction_wrong():
    runner = Runner(RunConfig(seed=8))
    settle(runner)
    runner.set_adversary("rapid_fire", True, k=1)
    start = runner.mistakes
    for _ in range(500):
        runner.step()
    assert runner.mistakes - start == 500


def test_rapid_fire_keeps_the_error_above_zero():
    for k in (2, 5, 10):
        runner = Runner(RunConfig(seed=k))
        settle(runner)
        runner.set_adversary("rapid_fire", True, k=k)
        start = runner.mistakes
        for _ in range(2_000):
            runner.step()
        assert runner.mistakes - start >= 2_000 // k


def test_stealth_drift_hides_while_monitoring_is_off():
    runner = Runner(RunConfig(seed=6))
    settle(runner)
    runner.set_p(0.0)
    runner.set_adversary("stealth", True, period=10)
    for _ in range(5_000):
        runner.step()
    assert runner.detections == 0
    assert runner.mistakes > 0


def test_stealth_drift_is_caught_once_labels_flow():
    runner = Runner(RunConfig(seed=6))
    settle(runner)
    runner.set_adversary("stealth", True, period=10)
    for _ in range(5_000):
        runner.step()
    assert runner.detections > 0
    assert runner.false_alarms == 0
