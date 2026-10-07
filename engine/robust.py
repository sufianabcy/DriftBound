"""Robust mode: an online River model, with ADWIN watching its right/wrong stream.

This is the mode for what exact mode cannot handle: noisy labels and rules from
outside the family. Its guarantees are probabilistic (ADWIN's false alarm rate
is bounded by delta), not exact.
"""

from __future__ import annotations

import copy
from collections import deque
from dataclasses import dataclass

from river import drift, tree


def make_model():
    """A Hoeffding tree with an exhaustive splitter.

    The exhaustive splitter considers every observed value as a split point, so
    one split lands on the threshold itself; the default Gaussian splitter only
    tries about ten points. See design.md (D-19) for the comparison.
    """
    return tree.HoeffdingTreeClassifier(
        grace_period=20,
        delta=1e-5,
        splitter=tree.splitter.ExhaustiveSplitter(),
    )


@dataclass
class StoredModel:
    number: int
    model: object
    created_at_step: int
    boundary: int
    reuse_count: int = 0
    last_used_step: int = 0

    @property
    def key(self) -> str:
        return f"model:{self.number}"


class RobustEngine:
    name = "robust"

    def __init__(
        self,
        n: int,
        capacity: int = 8,
        delta: float = 0.002,
        grace: int = 30,
        window: int = 32,
        reuse_threshold: float = 0.75,
    ):
        self.n = n
        self.capacity = capacity
        self.delta = delta
        self.grace = grace  # labels after a model swap before alarms count
        self.reuse_threshold = reuse_threshold
        self.model = make_model()
        self.adwin = drift.ADWIN(delta=delta)
        self.store: list[StoredModel] = []
        self.origin: StoredModel | None = None  # stored entry the model came from
        self.recent: deque[tuple[int, int]] = deque(maxlen=window)
        self.since_swap = 0
        self._next_number = 1
        self._boundary: int | None = None

    @property
    def state(self) -> str:
        return "learning" if self.since_swap < self.grace else "monitoring"

    def _features(self, x: int) -> dict:
        return {"x": x / self.n}

    def _predict_with(self, model, x: int) -> int:
        y = model.predict_one(self._features(x))
        return 0 if y is None else int(y)

    def predict(self, x: int) -> int:
        return self._predict_with(self.model, x)

    def boundary(self) -> int:
        """Estimated threshold: where predictions switch from 0 to 1.

        Found by binary search, so it assumes predictions are monotone in x,
        which holds for a threshold-shaped tree. Display only.
        """
        if self._boundary is None:
            lo, hi = 1, self.n + 1
            while lo < hi:
                mid = (lo + hi) // 2
                if self.predict(mid) == 1:
                    hi = mid
                else:
                    lo = mid + 1
            self._boundary = lo
        return self._boundary

    def learn(self, x: int, y: int, y_pred: int, step: int) -> dict | None:
        """Learn one labeled point. Returns alarm details when ADWIN fires."""
        before = self.adwin.estimation
        self.adwin.update(int(y_pred != y))
        self.recent.append((x, y))
        self.model.learn_one(self._features(x), y)
        self.since_swap += 1
        self._boundary = None
        # ADWIN fires on any change of the error rate; only a rise is harmful.
        if self.adwin.drift_detected and self.adwin.estimation > before and self.since_swap > self.grace:
            return self._alarm(step)
        return None

    def _accuracy(self, model, sample: list[tuple[int, int]]) -> float:
        if not sample:
            return 0.0
        return sum(self._predict_with(model, x) == y for x, y in sample) / len(sample)

    def _alarm(self, step: int) -> dict:
        recent = list(self.recent)
        current_acc = self._accuracy(self.model, recent)
        retired = self._retire(step)
        best, best_acc = None, -1.0
        for entry in self.store:
            if entry is retired:
                continue
            acc = self._accuracy(entry.model, recent)
            if acc > best_acc:
                best, best_acc = entry, acc
        reused = best is not None and best_acc >= self.reuse_threshold and best_acc >= current_acc + 0.1
        if reused:
            self.model = copy.deepcopy(best.model)
            self.origin = best
            best.reuse_count += 1
            best.last_used_step = step
        else:
            # Fresh model, warmed up on the newest labels.
            self.model = make_model()
            for x, y in recent:
                self.model.learn_one(self._features(x), y)
            self.origin = None
        self.adwin = drift.ADWIN(delta=self.delta)
        self.since_swap = 0
        self._boundary = None
        return {
            "reused": reused,
            "reused_key": best.key if reused else None,
            "best_stored_accuracy": None if best is None else round(best_acc, 3),
            "failed_model_accuracy": round(current_acc, 3),
            "stored": retired,
        }

    def _retire(self, step: int) -> StoredModel:
        """Save the failing model: it describes the concept that just ended."""
        if self.origin is not None and self.origin in self.store:
            self.origin.model = self.model
            self.origin.boundary = self.boundary()
            self.origin.last_used_step = step
            return self.origin
        entry = StoredModel(
            number=self._next_number,
            model=self.model,
            created_at_step=step,
            boundary=self.boundary(),
            last_used_step=step,
        )
        self._next_number += 1
        if len(self.store) >= self.capacity:
            self.store.remove(min(self.store, key=lambda e: e.last_used_step))
        self.store.append(entry)
        return entry
