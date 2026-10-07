"""The closed-form bounds, and the statistical ones checked by simulation."""

import pytest

from engine import bounds
from engine.exact import ExactEngine
from engine.runner import RunConfig, Runner
from tests.helpers import event_of, has_event, identify, memory_with, run_until, settle

N = 1023


def test_closed_forms():
    assert [bounds.ceil_log2(m) for m in (1, 2, 3, 4, 1024, 1025)] == [0, 1, 2, 2, 10, 11]
    assert bounds.recovery_labels(N) == 10
    assert [bounds.recall_labels(k) for k in range(1, 9)] == [2, 3, 4, 4, 5, 5, 5, 5]
    assert bounds.recall_fallback_labels(3, N) == 14
    assert bounds.mistakes_per_drift(N) == 11
    assert bounds.halving_mistakes(N + 1) == 10
    assert bounds.threshold_littlestone_dimension(N) == 10
    assert bounds.expected_mistakes_before_detection(0.25) == 4
    assert bounds.expected_mistakes_before_detection(0.0) is None
    assert bounds.noise_floor(0.1) == 0.1
    assert bounds.recall_is_worthwhile(8, N)
    assert not bounds.recall_is_worthwhile(4, 15)


def test_binary_search_is_kraft_tight():
    depths = [identify(ExactEngine(N), theta) for theta in range(1, N + 2)]
    assert bounds.kraft_sum(depths) == 1.0


def test_memory_has_a_price():
    """Theorem 6: faster on stored rules means slower on some new rule."""
    memory = memory_with([100, 400, 900])
    depths = [identify(ExactEngine(N, memory), theta) for theta in range(1, N + 2)]
    assert bounds.kraft_sum(depths) <= 1.0
    assert min(depths) < bounds.recovery_labels(N) < max(depths)


def test_mistakes_before_detection_average_one_over_p():
    p = 0.25
    samples = []
    for seed in range(300):
        runner = Runner(RunConfig(seed=seed, p=p, memory=False))
        settle(runner)
        runner.inject("abrupt")
        detected = event_of(run_until(runner, has_event("detected")), "detected")
        samples.append(detected["mistakes_before_detection"])
    mean = sum(samples) / len(samples)
    # Geometric with mean 1/p = 4 and sd about 3.5: three standard errors is 0.6.
    assert abs(mean - 1 / p) < 0.6


def test_noisy_detection_cost_grows_like_one_over_eps():
    big = bounds.noisy_detection_labels(eps=0.1, noise=0.1, delta=0.01)
    small = bounds.noisy_detection_labels(eps=0.01, noise=0.1, delta=0.01)
    assert small == pytest.approx(10 * big)
    with pytest.raises(ValueError):
        bounds.noisy_detection_labels(eps=0.1, noise=0.0, delta=0.01)
