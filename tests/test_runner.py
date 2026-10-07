"""Runner mechanics: determinism, scenarios, mode switches and the records it hands over."""

import pytest

from engine.runner import RunConfig, Runner
from tests.helpers import event_of, has_event, run_until, settle


def test_same_seed_gives_the_same_run():
    def play(seed):
        runner = Runner(RunConfig(seed=seed))
        ticks = [runner.step() for _ in range(300)]
        runner.inject("abrupt")
        ticks += [runner.step() for _ in range(300)]
        return ticks

    assert play(42) == play(42)
    assert play(42) != play(43)


def test_gradual_drift_raises_repeated_detections_that_are_not_false_alarms():
    runner = Runner(RunConfig(seed=31))
    settle(runner)
    runner.inject("gradual", width=300)
    for _ in range(400):
        runner.step()
    found = [e for e in runner.events if e["type"] == "detected"]
    assert len(found) >= 2
    assert not any(e["false_alarm"] for e in found)
    assert any(e["cause"] == "gradual" for e in found)
    assert runner.stream.gradual is None  # the window has closed


def test_out_of_family_rule_defeats_exact_mode():
    runner = Runner(RunConfig(seed=32))
    settle(runner)
    runner.apply_scenario("out_of_family")
    for _ in range(2_000):
        runner.step()
    found = [e for e in runner.events if e["type"] == "detected"]
    assert len(found) >= 10
    assert all(e["cause"] == "out_of_family" for e in found)
    assert runner.false_alarms == 0
    assert runner.summary()["error_rate"] > 0.2
    assert not runner.conditions()["rule_family"]


def test_monitoring_off_scenario_hides_the_drift():
    runner = Runner(RunConfig(seed=33))
    runner.apply_scenario("monitoring_off")
    before = runner.mistakes
    for _ in range(3_000):
        runner.step()
    injected = [e for e in runner.events if e["type"] == "injected"]
    assert len(injected) == 1
    assert runner.detections == 0
    assert runner.mistakes > before
    assert not runner.conditions()["label_access"]


def test_noisy_labels_scenario_causes_false_alarms():
    runner = Runner(RunConfig(seed=34))
    runner.apply_scenario("noisy_labels")
    for _ in range(3_000):
        runner.step()
    assert runner.false_alarms > 0
    assert not runner.summary()["guarantee"]


def test_all_clear_restores_every_condition():
    runner = Runner(RunConfig(seed=35))
    runner.apply_scenario("out_of_family")
    for _ in range(200):
        runner.step()
    runner.apply_scenario("all_clear")
    settle(runner)
    summary = runner.summary()
    assert all(summary["conditions"].values())
    assert summary["guarantee"]


def test_mode_switch_round_trip():
    runner = Runner(RunConfig(seed=36))
    settle(runner)
    runner.set_mode("robust")
    for _ in range(500):
        runner.step()
    assert runner.summary()["mode"] == "robust"
    runner.set_mode("exact")
    tick = run_until(runner, has_event("recovered"))
    assert event_of(tick, "recovered")["initial"]
    assert [e["mode"] for e in runner.events if e["type"] == "mode"] == ["robust", "exact"]


def test_drain_hands_over_each_record_once():
    runner = Runner(RunConfig(seed=37, metric_every=5))
    for _ in range(200):
        runner.step()
    runner.inject("abrupt")
    for _ in range(200):
        runner.step()
    metrics, events, concepts = runner.drain()
    assert [m["step"] for m in metrics] == list(range(5, 401, 5))
    sources = [e["source"] for e in events]
    assert sources == ["injected", "detected"]
    detected = events[1]
    assert detected["labels_to_recover"] == 10
    assert detected["bound"] == 10
    assert detected["details"]["outcome"] == "recovered"
    assert {c["key"] for c in concepts} == {f"theta:{t}" for t in runner.stream.history}
    assert runner.drain() == ([], [], [])


def test_bad_commands_are_rejected():
    runner = Runner(RunConfig(seed=38))
    with pytest.raises(ValueError):
        runner.inject("recurring")  # nothing to return to yet
    with pytest.raises(ValueError):
        runner.inject("abrupt", theta=5_000)
    with pytest.raises(ValueError):
        runner.inject("sideways")
    with pytest.raises(ValueError):
        runner.set_p(1.5)
    with pytest.raises(ValueError):
        runner.set_noise(0.5)
    with pytest.raises(ValueError):
        runner.set_mode("fast")
    with pytest.raises(ValueError):
        runner.apply_scenario("nope")
    with pytest.raises(ValueError):
        runner.set_adversary("chaos", True)
    with pytest.raises(ValueError):
        RunConfig(n=0).validate()


def test_summary_reports_whether_the_guarantee_holds():
    runner = Runner(RunConfig(seed=39))
    settle(runner)
    assert runner.summary()["guarantee"]
    runner.set_noise(0.1)
    summary = runner.summary()
    assert not summary["conditions"]["labels_clean"]
    assert not summary["guarantee"]


def test_a_chosen_input_is_processed_like_any_other():
    runner = Runner(RunConfig(seed=40, theta=600))
    settle(runner)
    tick = runner.step(x=700)
    assert tick["x"] == 700 and tick["y_true"] == 1 and tick["y_pred"] == 1
    runner.inject("abrupt", theta=300)
    tick = runner.step(x=450)  # fraud now, but below the old cutoff: missed, and the check reveals it
    assert tick["y_true"] == 1 and tick["y_pred"] == 0
    assert has_event("detected")(tick)
    for bad in (0, runner.config.n + 1):
        with pytest.raises(ValueError):
            runner.step(x=bad)


def test_outcomes_are_counted_against_the_true_rule():
    runner = Runner(RunConfig(seed=41))
    for _ in range(300):
        runner.step()
    runner.inject("abrupt")
    for _ in range(300):
        runner.step()
    c = runner.summary()["counters"]["confusion"]
    assert sum(c.values()) == runner.t
    assert c["fp"] + c["fn"] == runner.mistakes
    assert len(runner.snapshot()["ticks"]) == 50
