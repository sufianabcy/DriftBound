"""Milestone 4: with 10% label noise, robust mode recovers while exact mode raises false alarms."""

from engine.runner import RunConfig, Runner


def detections(runner: Runner) -> list[dict]:
    return [e for e in runner.events if e["type"] == "detected"]


def test_robust_mode_recovers_from_an_abrupt_drift_under_10pct_noise():
    runner = Runner(RunConfig(seed=21, mode="robust", noise=0.1, theta=300))
    for _ in range(3_000):
        runner.step()
    runner.inject("abrupt", theta=800)
    for _ in range(1_500):
        runner.step()
    start = runner.mistakes
    for _ in range(1_000):
        runner.step()
    assert (runner.mistakes - start) / 1_000 < 0.05
    assert any(not e["false_alarm"] for e in detections(runner))


def test_exact_mode_raises_false_alarms_under_the_same_noise():
    runner = Runner(RunConfig(seed=21, mode="exact", noise=0.1, theta=300))
    for _ in range(3_000):
        runner.step()
    assert runner.false_alarms > 0


def test_robust_mode_stays_quiet_without_drift():
    runner = Runner(RunConfig(seed=22, mode="robust", noise=0.1))
    for _ in range(20_000):
        runner.step()
    assert runner.false_alarms == 0


def test_robust_mode_reuses_a_stored_model_when_a_rule_returns():
    runner = Runner(RunConfig(seed=23, mode="robust", theta=300))
    for _ in range(3_000):
        runner.step()
    runner.inject("abrupt", theta=800)
    for _ in range(3_000):
        runner.step()
    runner.inject("recurring", theta=300)
    for _ in range(1_500):
        runner.step()
    true_alarms = [e for e in detections(runner) if not e["false_alarm"]]
    assert len(true_alarms) >= 2
    assert true_alarms[-1]["reused"]
    assert abs(runner.robust.boundary() - 300) <= 10
