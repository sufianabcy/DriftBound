"""Candidate elimination over thresholds: the engine behind the zero-error proofs.

The engine keeps every threshold that agrees with all labels since the last
reset. For thresholds that set is an interval [lo, hi] (the version space), so
an update is two comparisons. The range is empty exactly when no rule in the
family explains the labels, which is the only time drift is declared.
"""

from __future__ import annotations

from . import bounds
from .memory import ConceptMemory


class ExactEngine:
    name = "exact"

    def __init__(self, n: int, memory: ConceptMemory | None = None):
        self.n = n
        self.memory = memory
        self.reset()

    def reset(self, exclude: int | None = None) -> None:
        """Forget all labels: every threshold 1..n+1 is possible again.

        `exclude` is a stored rule that recall must skip (see reset_after_drift).
        """
        self.lo, self.hi = 1, self.n + 1
        self.rule: int | None = None  # the rule converged on since this reset
        self.exclude = exclude
        k = len(self._stored())
        # Recall is tried only when its worst case beats the plain search.
        self.recall_k = k if bounds.recall_is_worthwhile(k, self.n) else 0
        self.recalling = self.recall_k > 0
        self.path = "memory" if self.recalling else "full"

    def reset_after_drift(self) -> None:
        """Start over after a detection.

        The rule the engine was monitoring with has just been contradicted by a
        clean label, so it cannot be the new rule: recall skips it. Without
        this, the first drift of every run would waste labels re-testing it.
        """
        self.reset(exclude=self.rule)

    def _stored(self) -> list[int]:
        """Stored rules still inside the version space, minus the excluded one."""
        if not self.memory:
            return []
        return [t for t in self.memory.candidates(self.lo, self.hi) if t != self.exclude]

    @property
    def converged(self) -> bool:
        return self.lo == self.hi

    @property
    def candidates_left(self) -> int:
        return max(0, self.hi - self.lo + 1)

    @property
    def theta_hat(self) -> int:
        """The threshold the engine predicts with right now."""
        return (self.lo + self.hi) // 2

    @property
    def state(self) -> str:
        if self.converged:
            return "monitoring"
        return "recalling" if self.recalling else "learning"

    def bound(self) -> int:
        """The proven label limit for the recovery in progress."""
        if self.path == "memory":
            return bounds.recall_labels(self.recall_k)
        if self.path == "memory_fallback":
            return bounds.recall_fallback_labels(self.recall_k, self.n)
        return bounds.recovery_labels(self.n)

    def predict(self, x: int) -> int:
        # Majority vote of the version space (the Halving rule), ties to 1.
        return int(x >= (self.lo + self.hi) // 2)

    def next_query(self) -> int | None:
        """The point to ask the label oracle about; None once one rule is left."""
        if self.lo >= self.hi:
            return None
        if self.recalling:
            stored = self._stored()
            if len(stored) >= 2:
                # Label 1 keeps the first half of the stored rules, label 0 the rest.
                return stored[(len(stored) + 1) // 2 - 1]
            if len(stored) == 1:
                # Confirm the survivor t: expect label 0 at t - 1 and 1 at t.
                t = stored[0]
                return t - 1 if self.lo < t else t
            # No stored rule survived: binary search what is left, keeping
            # the labels already bought.
            self.recalling = False
            self.path = "memory_fallback"
        return (self.lo + self.hi - 1) // 2

    def update(self, x: int, y: int) -> bool:
        """Apply one label. Returns True when no threshold fits: drift is certain."""
        if y == 1:
            self.hi = min(self.hi, x)  # threshold is at or below x
        else:
            self.lo = max(self.lo, x + 1)  # threshold is above x
        if self.lo == self.hi:
            self.rule = self.lo
        return self.lo > self.hi
