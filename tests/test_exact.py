"""Theorems 1 to 3 of docs/theory.md, as tests."""

import random

import pytest

from engine import bounds
from engine.exact import ExactEngine
from engine.runner import RunConfig, Runner
from tests.helpers import event_of, has_event, identify, run_until, settle

N = 1023


def test_every_rule_is_identified_in_exactly_ten_labels():
    for theta in range(1, N + 2):
        engine = ExactEngine(N)
        assert identify(engine, theta) == 10
        assert engine.lo == engine.hi == theta


@pytest.mark.parametrize("n", [1, 2, 3, 6, 7, 100, 1000, 1024])
def test_binary_search_meets_the_upper_bound_for_any_n(n):
    worst = 0
    for theta in range(1, n + 2):
        engine = ExactEngine(n)
        worst = max(worst, identify(engine, theta))
        assert engine.lo == theta
    assert worst == bounds.recovery_labels(n)


def test_version_space_is_exactly_the_set_of_consistent_rules():
    n = 40
    rng = random.Random(0)
    for _ in range(300):
        theta = rng.randint(1, n + 1)
        engine = ExactEngine(n)
        seen = []
        for _ in range(rng.randint(0, 15)):
            x = rng.randint(1, n)
            y = int(x >= theta)
            seen.append((x, y))
            engine.update(x, y)
        consistent = [t for t in range(1, n + 2) if all(int(x >= t) == y for x, y in seen)]
        assert consistent == list(range(engine.lo, engine.hi + 1))


def test_zero_false_alarms_and_zero_error_over_100k_drift_free_steps():
    runner = Runner(RunConfig(seed=11, p=1.0, memory=False))
    settle(runner)
    mistakes_while_learning = runner.mistakes
    for _ in range(100_000):
        runner.step()
    assert runner.detections == 0
    assert runner.false_alarms == 0
    assert runner.mistakes == mistakes_while_learning


def test_harmful_drift_is_caught_at_its_first_labeled_mistake():
    for seed in range(25):
        runner = Runner(RunConfig(seed=seed, p=1.0))
        settle(runner)
        runner.inject("abrupt")
        first_mistake = None
        while True:
            tick = runner.step()
            if first_mistake is None and tick["y_pred"] != tick["y_true"]:
                first_mistake = tick["step"]
            if has_event("detected")(tick):
                detected = event_of(tick, "detected")
                assert tick["step"] == first_mistake
                assert detected["mistakes_before_detection"] == 1
                assert not detected["false_alarm"]
                break


def test_with_sparse_labels_only_a_labeled_mistake_triggers_detection():
    runner = Runner(RunConfig(seed=3, p=0.2))
    settle(runner)
    runner.inject("abrupt")
    unlabeled_mistakes = 0
    while True:
        tick = runner.step()
        wrong = tick["y_pred"] != tick["y_true"]
        if has_event("detected")(tick):
            assert tick["labeled"] and wrong
            break
        if wrong:
            assert not tick["labeled"]
            unlabeled_mistakes += 1
    assert runner.detections == 1


def test_harmless_drift_is_ignored_and_costs_nothing():
    engine = ExactEngine(N)
    identify(engine, 500)
    # The new rule 510 differs from 500 only on inputs 500..509.
    outside = [v for v in range(1, N + 1) if not 500 <= v < 510]
    rng = random.Random(1)
    for _ in range(10_000):
        x = rng.choice(outside)
        y_new = int(x >= 510)
        assert engine.predict(x) == y_new
        assert not engine.update(x, y_new)
    assert engine.lo == engine.hi == 500


def test_zero_error_after_every_adaptation():
    runner = Runner(RunConfig(seed=5, memory=False))
    settle(runner)
    for _ in range(8):
        runner.inject("abrupt")
        run_until(runner, has_event("recovered"))
        before = runner.mistakes
        for _ in range(2_000):
            runner.step()
        assert runner.mistakes == before


def test_recovery_after_abrupt_drift_takes_exactly_ten_labels():
    runner = Runner(RunConfig(seed=9, memory=False))
    settle(runner)
    for _ in range(25):
        mistakes_at_drift = runner.mistakes
        runner.inject("abrupt")
        tick = run_until(runner, has_event("recovered"))
        recovered = event_of(tick, "recovered")
        assert recovered["labels"] == recovered["bound"] == 10
        assert recovered["correct"]
        # One detecting mistake plus at most one per recovery step.
        assert runner.mistakes - mistakes_at_drift <= bounds.mistakes_per_drift(N)
        for _ in range(50):
            runner.step()
