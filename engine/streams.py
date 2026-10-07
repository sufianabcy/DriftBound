"""Inputs, the true rule, label noise and the drift injector.

The stream is the only object that knows the truth. Engines see inputs and the
labels they pay for, never the concept itself.
"""

from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class Threshold:
    """The rule x -> 1 if x >= theta else 0. theta ranges over 1..n+1."""

    theta: int

    def __call__(self, x: int) -> int:
        return int(x >= self.theta)


@dataclass(frozen=True)
class LookupTable:
    """An arbitrary labeling: outside the threshold family on purpose."""

    labels: tuple[int, ...]  # labels[x - 1] is the label of x

    def __call__(self, x: int) -> int:
        return self.labels[x - 1]


@dataclass
class GradualWindow:
    """For `width` steps each label comes from old or new, new ever more likely."""

    old: Threshold
    new: Threshold
    start: int
    width: int

    def weight_new(self, step: int) -> float:
        return min(1.0, max(0.0, (step - self.start + 1) / self.width))

    def ends_at(self) -> int:
        return self.start + self.width - 1


class Stream:
    """One input per step, labeled by the concept currently in force."""

    def __init__(self, n: int = 1023, theta: int | None = None, noise: float = 0.0, seed: int = 0):
        if n < 1:
            raise ValueError("n must be at least 1")
        root = random.Random(seed)
        # Separate generators, so changing noise or drifts never changes the inputs.
        self._inputs = random.Random(root.getrandbits(64))
        self._labels = random.Random(root.getrandbits(64))
        self.rng = random.Random(root.getrandbits(64))  # drift choices
        self.n = n
        self.noise = noise
        if theta is None:
            theta = self.rng.randint(1, n + 1)
        self._check_theta(theta)
        self.concept: Threshold | LookupTable = Threshold(theta)
        self.gradual: GradualWindow | None = None
        self.version = 0  # bumps on every change of the labeling distribution
        self.history: list[int] = [theta]  # thresholds that have been in force

    @property
    def theta(self) -> int | None:
        """The threshold in force, or None while the rule is outside the family."""
        return self.concept.theta if isinstance(self.concept, Threshold) else None

    @property
    def in_family(self) -> bool:
        return isinstance(self.concept, Threshold)

    def next_x(self) -> int:
        return self._inputs.randint(1, self.n)

    def clean_label(self, x: int, step: int) -> int:
        """The label before noise. Inside a gradual window it is drawn from the mixture."""
        g = self.gradual
        if g is not None:
            rule = g.new if self._labels.random() < g.weight_new(step) else g.old
            return rule(x)
        return self.concept(x)

    def observe(self, clean: int) -> int:
        """Flip a label with probability `noise`."""
        if self.noise > 0 and self._labels.random() < self.noise:
            return clean ^ 1
        return clean

    def query(self, x: int, step: int) -> int:
        """The label oracle: what a labeler would answer for x right now."""
        return self.observe(self.clean_label(x, step))

    def advance(self, step: int) -> dict | None:
        """Close a finished gradual window. Returns an event when it closes."""
        g = self.gradual
        if g is not None and step > g.ends_at():
            self.gradual = None
            self.concept = g.new
            self.version += 1
            return {"type": "gradual_end", "step": step, "to": g.new.theta}
        return None

    def _check_theta(self, theta: int) -> None:
        if not 1 <= theta <= self.n + 1:
            raise ValueError(f"theta must be between 1 and {self.n + 1}")


class DriftInjector:
    """Changes the true rule. Every method returns the event to log."""

    def __init__(self, stream: Stream, min_jump: int | None = None):
        self.stream = stream
        # Random abrupt drifts move at least this far, so they are visible on
        # screen; tiny drifts are the stealth adversary's job.
        self.min_jump = min_jump if min_jump is not None else max(1, (stream.n + 1) // 8)

    def abrupt(self, step: int, theta: int | None = None) -> dict:
        new = self._pick_far(theta)
        return self._switch(step, new, "abrupt")

    def recurring(self, step: int, theta: int | None = None) -> dict:
        s = self.stream
        earlier = sorted(set(s.history) - {s.theta})
        if theta is None:
            if not earlier:
                raise ValueError("no earlier rule to return to yet")
            theta = s.rng.choice(earlier)
        elif theta not in earlier:
            raise ValueError(f"theta {theta} has not been used earlier in this run")
        return self._switch(step, theta, "recurring")

    def gradual(self, step: int, theta: int | None = None, width: int = 200) -> dict:
        if width < 2:
            raise ValueError("a gradual drift needs a window of at least 2 steps")
        s = self.stream
        self._settle()
        if s.theta is None:
            raise ValueError("gradual drift needs a threshold rule in force")
        new = self._pick_far(theta)
        old = s.theta
        s.gradual = GradualWindow(Threshold(old), Threshold(new), start=step, width=width)
        s.version += 1
        s.history.append(new)
        return {"type": "injected", "drift": "gradual", "step": step, "from": old, "to": new, "width": width}

    def set_threshold(self, step: int, theta: int, kind: str, record: bool = True) -> dict | None:
        """Used by the adversary and the lab scenarios. None if nothing changes."""
        s = self.stream
        s._check_theta(theta)
        if theta == s.theta and s.gradual is None:
            return None
        return self._switch(step, theta, kind, record=record)

    def arbitrary(self, step: int) -> dict:
        """Replace the rule with random labels: no threshold fits any more."""
        s = self.stream
        self._settle()
        old = s.theta
        s.concept = LookupTable(tuple(s.rng.randint(0, 1) for _ in range(s.n)))
        s.version += 1
        return {"type": "injected", "drift": "out_of_family", "step": step, "from": old, "to": None}

    def _switch(self, step: int, theta: int, kind: str, record: bool = True) -> dict:
        s = self.stream
        self._settle()
        old = s.theta
        s.concept = Threshold(theta)
        s.version += 1
        if record:
            s.history.append(theta)
        return {"type": "injected", "drift": kind, "step": step, "from": old, "to": theta}

    def _settle(self) -> None:
        """Finish a gradual window early when another drift arrives."""
        s = self.stream
        if s.gradual is not None:
            s.concept = s.gradual.new
            s.gradual = None

    def _pick_far(self, theta: int | None) -> int:
        s = self.stream
        if theta is not None:
            s._check_theta(theta)
            if theta == s.theta:
                raise ValueError("that threshold is already in force")
            return theta
        current = s.theta
        if current is None:
            return s.rng.randint(1, s.n + 1)
        far = [t for t in range(1, s.n + 2) if abs(t - current) >= self.min_jump]
        if not far:
            far = [t for t in range(1, s.n + 2) if t != current]
        return s.rng.choice(far)
