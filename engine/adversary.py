"""Adversary strategies. Each one acts out one result from docs/theory.md.

The adversary runs after the engine has predicted on the arriving point and
before any label is drawn, so it is adaptive: it sees the input, the
prediction and the engine's state.
"""

from __future__ import annotations

import copy
import random
from typing import TYPE_CHECKING

from .exact import ExactEngine

if TYPE_CHECKING:
    from .runner import Runner


def worst_case_threshold(engine: ExactEngine, avoid: set[int], rng: random.Random) -> int:
    """The new rule that makes `engine` spend the most labels to recover.

    The adversary answers every query of the recovery so that the larger part
    of the surviving rules stays alive. Because the engine is deterministic,
    the adversary can play the whole recovery ahead of time on a copy, then
    commit to the one rule left. Every answer it gave is consistent with that
    rule, so the stream's truth stays well defined at every step.

    Rules in `avoid` (the current rule and everything in memory) are not
    counted, so the result is always a new rule and recall cannot shortcut it.
    """
    sim = copy.copy(engine)  # shares the memory, which the search only reads
    sim.reset_after_drift()  # exactly what the real engine will do on detection

    def alive(lo: int, hi: int) -> int:
        return (hi - lo + 1) - sum(1 for t in avoid if lo <= t <= hi)

    while (q := sim.next_query()) is not None:
        keep_one = alive(sim.lo, q)  # answer 1 keeps thresholds <= q
        keep_zero = alive(q + 1, sim.hi)  # answer 0 keeps thresholds > q
        if keep_one != keep_zero:
            answer = int(keep_one > keep_zero)
        else:
            answer = rng.randint(0, 1)
        sim.update(q, answer)
    return sim.lo


class Adversary:
    def __init__(self, seed: int = 0):
        self.rng = random.Random(seed)
        self.worst_case = False
        self.worst_case_gap = 100  # steps of monitoring before the next attack
        self.rapid_fire: int | None = None  # change the rule every k steps
        self.rapid_changes = 0
        self.stealth = False
        self.stealth_period = 50
        self._stealth_dir = 1
        self._monitoring_for = 0

    @property
    def active(self) -> bool:
        return self.worst_case or self.rapid_fire is not None or self.stealth

    def describe(self) -> dict:
        return {
            "worst_case": self.worst_case,
            "worst_case_gap": self.worst_case_gap,
            "rapid_fire": self.rapid_fire,
            "rapid_changes": self.rapid_changes,
            "stealth": self.stealth,
            "stealth_period": self.stealth_period,
        }

    def act(self, run: Runner, step: int, x: int, y_pred: int) -> list[dict]:
        events: list[dict] = []
        stream = run.stream

        if self.rapid_fire is not None and step % self.rapid_fire == 0:
            # Pick a rule that labels x opposite to the prediction.
            if stream.theta is None or stream.concept(x) == y_pred or stream.gradual is not None:
                n = stream.n
                theta = self.rng.randint(x + 1, n + 1) if y_pred == 1 else self.rng.randint(1, x)
                if run.injector.set_threshold(step, theta, "rapid_fire", record=False) is not None:
                    self.rapid_changes += 1
                    run.note_change(step, "rapid_fire")

        if self.stealth and step % self.stealth_period == 0 and stream.theta is not None:
            theta = stream.theta + self._stealth_dir
            if not 1 <= theta <= stream.n + 1:
                self._stealth_dir *= -1
                theta = stream.theta + self._stealth_dir
            event = run.injector.set_threshold(step, theta, "stealth", record=False)
            if event is not None:
                events.append(event)

        if self.worst_case and run.mode == "exact":
            engine = run.exact
            self._monitoring_for = self._monitoring_for + 1 if engine.converged else 0
            if self._monitoring_for >= self.worst_case_gap and stream.theta is not None:
                avoid = set(engine.memory.thetas()) if engine.memory else set()
                avoid.add(stream.theta)
                theta = worst_case_threshold(engine, avoid, self.rng)
                event = run.injector.set_threshold(step, theta, "worst_case")
                if event is not None:
                    events.append(event)
                self._monitoring_for = 0
        return events
