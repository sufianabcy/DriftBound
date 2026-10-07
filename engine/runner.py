"""One step of a run: predict, attack, label, update, account.

The runner owns the stream, both engines, the concept memory and the adversary,
and keeps every counter the dashboard and the database need. It is synchronous
and does no I/O: the API calls step() in a loop and drains records to storage.
"""

from __future__ import annotations

import random
from collections import deque
from dataclasses import asdict, dataclass

from . import bounds
from .adversary import Adversary
from .exact import ExactEngine
from .memory import ConceptMemory
from .robust import RobustEngine
from .streams import DriftInjector, Stream

MODES = ("exact", "robust")
DRIFTS = ("abrupt", "gradual", "recurring", "out_of_family")
STRATEGIES = ("worst_case", "rapid_fire", "stealth", "noise")
SCENARIOS = ("monitoring_off", "noisy_labels", "out_of_family", "rapid_fire", "all_clear")


@dataclass
class RunConfig:
    n: int = 1023
    mode: str = "exact"
    p: float = 1.0  # fraction of points labeled while monitoring
    noise: float = 0.0  # probability that a label is flipped
    seed: int = 0
    theta: int | None = None  # starting rule; random when None
    memory: bool = True
    memory_capacity: int = 8
    error_window: int = 100  # steps in the rolling error rate
    metric_every: int = 5  # steps between stored metric points
    gradual_width: int = 200

    def validate(self) -> None:
        if not 1 <= self.n <= 1_000_000:
            raise ValueError("n must be between 1 and 1,000,000")
        if self.mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        _check_rate("p", self.p)
        _check_noise(self.noise)
        if self.theta is not None and not 1 <= self.theta <= self.n + 1:
            raise ValueError(f"theta must be between 1 and {self.n + 1}")
        if self.memory_capacity < 1 or self.error_window < 1 or self.metric_every < 1:
            raise ValueError("memory_capacity, error_window and metric_every must be positive")


def _check_rate(name: str, value: float) -> None:
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1")


def _check_noise(value: float) -> None:
    if not 0.0 <= value < 0.5:
        raise ValueError("noise must be at least 0 and below 0.5")


class Runner:
    def __init__(self, config: RunConfig | None = None):
        self.config = config or RunConfig()
        c = self.config
        c.validate()
        root = random.Random(c.seed)
        self.stream = Stream(c.n, c.theta, c.noise, seed=root.getrandbits(32))
        self.injector = DriftInjector(self.stream)
        self.memory = ConceptMemory(c.memory_capacity) if c.memory else None
        self.exact = ExactEngine(c.n, self.memory)
        self.robust: RobustEngine | None = None
        self.adversary = Adversary(seed=root.getrandbits(32))
        self._policy = random.Random(root.getrandbits(32))  # monitoring coin flips
        self.mode = c.mode
        self.p = c.p
        self.t = 0

        self.mistakes = 0
        self.observed_mistakes = 0
        self.labels = 0
        self.detections = 0
        self.false_alarms = 0
        self.injected = 0
        self._err = deque(maxlen=c.error_window)
        self._obs_err = deque(maxlen=c.error_window)
        # Predictions against the true rule: positives are label 1 (in the fraud story, fraud).
        self.confusion = {"tp": 0, "fp": 0, "tn": 0, "fn": 0}

        # Concept changes the engine has not detected yet, for delay and cause.
        self._version_at_reset = self.stream.version
        self._undetected: list[tuple[int, str]] = []
        self._mistakes_at_change = 0
        self._overlap = False  # a change landed while a recovery was running
        self.last_delay: int | None = None

        self._recovery: dict | None = None
        self.recoveries: deque[dict] = deque(maxlen=200)
        self._scheduled_drift: str | None = None

        # Outputs, drained by the API.
        self._queued: list[dict] = []
        self._metrics: list[dict] = []
        self._db_events: list[dict] = []
        self._concepts: dict[str, dict] = {}
        self.concept_registry: dict[str, dict] = {}
        self.history: deque[dict] = deque(maxlen=1500)
        self.events: deque[dict] = deque(maxlen=300)
        self.recent: deque[dict] = deque(maxlen=50)  # full ticks, for a viewer who joins late

        if self.mode == "exact":
            self._open_recovery(initial=True)
        else:
            self._ensure_robust()

    # ------------------------------------------------------------------ state

    @property
    def engine(self) -> ExactEngine | RobustEngine:
        return self.exact if self.mode == "exact" else self._ensure_robust()

    @property
    def state(self) -> str:
        return self.engine.state

    def _ensure_robust(self) -> RobustEngine:
        if self.robust is None:
            self.robust = RobustEngine(self.config.n, capacity=self.config.memory_capacity)
        return self.robust

    def _settled(self) -> bool:
        return self.engine.state == "monitoring"

    # ------------------------------------------------------------------- step

    def step(self, x: int | None = None) -> dict:
        """Process one input: a random one, or `x` when the caller chooses it."""
        s = self.stream
        if x is not None and not 1 <= x <= s.n:
            raise ValueError(f"x must be between 1 and {s.n}")
        self.t += 1
        t = self.t
        events, self._queued = self._queued, []

        closed = s.advance(t)
        if closed is not None:
            events.append(self._log(closed))
        if self._scheduled_drift is not None and self._settled():
            events.append(self._inject(self._scheduled_drift, step=t))
            self._scheduled_drift = None

        if x is None:
            x = s.next_x()
        y_pred = self.engine.predict(x)
        for event in self.adversary.act(self, t, x, y_pred):
            self._record_injected(event)
            events.append(event)

        y_clean = s.clean_label(x, t)
        y_obs = s.observe(y_clean)
        mistake = int(y_pred != y_clean)
        obs_mistake = int(y_pred != y_obs)
        self.mistakes += mistake
        self.observed_mistakes += obs_mistake
        outcome = ("tp" if y_clean else "fp") if y_pred else ("fn" if y_clean else "tn")
        self.confusion[outcome] += 1
        self._err.append(mistake)
        self._obs_err.append(obs_mistake)

        query = answer = None
        labeled = False
        if self.mode == "exact":
            query, answer, labeled = self._exact_step(t, x, y_obs, events)
        else:
            labeled = self._robust_step(t, x, y_obs, y_pred, events)

        error_rate = sum(self._err) / len(self._err)
        observed_rate = sum(self._obs_err) / len(self._obs_err)
        exact_mode = self.mode == "exact"
        e = self.exact
        tick = {
            "step": t,
            "x": x,
            "y_true": y_clean,
            "y_obs": y_obs,
            "y_pred": y_pred,
            "labeled": labeled,
            "query": query,
            "query_label": answer,
            "state": self.state,
            "mode": self.mode,
            "lo": e.lo if exact_mode else None,
            "hi": e.hi if exact_mode else None,
            "theta": s.theta,
            "theta_hat": e.theta_hat if exact_mode else self.robust.boundary(),
            "error_rate": round(error_rate, 4),
            "observed_error_rate": round(observed_rate, 4),
            "mistakes_total": self.mistakes,
            "labels_total": self.labels,
            "candidates_left": e.candidates_left if exact_mode else None,
            "false_alarms": self.false_alarms,
            "events": events,
        }
        self.recent.append(tick)
        self.history.append(
            {
                "step": t,
                "error_rate": tick["error_rate"],
                "observed_error_rate": tick["observed_error_rate"],
                "labels_total": self.labels,
            }
        )
        if t % self.config.metric_every == 0:
            self._metrics.append(
                {
                    "step": t,
                    "mode": self.mode,
                    "error_rate": tick["error_rate"],
                    "observed_error_rate": tick["observed_error_rate"],
                    "mistakes_total": self.mistakes,
                    "labels_total": self.labels,
                    "candidates_left": tick["candidates_left"],
                    "false_alarms": self.false_alarms,
                }
            )
        return tick

    def _exact_step(
        self, t: int, x: int, y_obs: int, events: list[dict]
    ) -> tuple[int | None, int | None, bool]:
        e = self.exact
        query = e.next_query()
        answer = None
        labeled = False
        if query is not None:
            # Learning: ask the oracle about the point that halves the range.
            answer = self.stream.query(query, t)
            self.labels += 1
            if self._recovery is not None:
                self._recovery["labels"] += 1
            empty = e.update(query, answer)
        elif self.p > 0 and self._policy.random() < self.p:
            # Monitoring: pay for the label of the arriving point.
            labeled = True
            self.labels += 1
            empty = e.update(x, y_obs)
        else:
            empty = False

        if empty:
            events.append(self._detected(t))
        elif query is not None and e.converged:
            events.append(self._recovered(t))
        return query, answer, labeled

    def _robust_step(self, t: int, x: int, y_obs: int, y_pred: int, events: list[dict]) -> bool:
        if not (self.p > 0 and self._policy.random() < self.p):
            return False
        self.labels += 1
        alarm = self.robust.learn(x, y_obs, y_pred, t)
        if alarm is not None:
            stored = alarm.pop("stored")
            self._register_concept(
                stored.key,
                {"kind": "hoeffding_tree", "boundary": stored.boundary},
                t,
                model=stored.model,
            )
            if alarm["reused"]:
                entry = next(m for m in self.robust.store if m.key == alarm["reused_key"])
                self._register_concept(
                    entry.key, {"kind": "hoeffding_tree", "boundary": entry.boundary}, t, reused=True
                )
            events.append(self._detected(t, extra=alarm))
        return True

    # ------------------------------------------------------- drift accounting

    def note_change(self, step: int, kind: str) -> None:
        """Record that the true rule changed (called for every concept change)."""
        if not self._undetected:
            self._mistakes_at_change = self.mistakes
        self._undetected.append((step, kind))
        if self.mode == "exact" and not self.exact.converged:
            self._overlap = True

    def _cause(self) -> str:
        s = self.stream
        if not s.in_family:
            return "out_of_family"
        if s.gradual is not None:
            return "gradual"
        if s.version != self._version_at_reset:
            return "drift"
        return "noise"  # nothing changed since the last reset: a false alarm

    def _detected(self, t: int, extra: dict | None = None) -> dict:
        cause = self._cause()
        false_alarm = cause == "noise"
        self.detections += 1
        if false_alarm:
            self.false_alarms += 1
        delay = mistakes_before = drift_kind = None
        if not false_alarm and self._undetected:
            delay = t - self._undetected[0][0]
            drift_kind = self._undetected[-1][1]
            mistakes_before = self.mistakes - self._mistakes_at_change
            self.last_delay = delay
        details = {
            "cause": cause,
            "false_alarm": false_alarm,
            "delay": delay,
            "mistakes_before_detection": mistakes_before,
            "mode": self.mode,
        }
        if extra:
            details.update(extra)
        record = {
            "step": t,
            "source": "detected",
            "drift_type": drift_kind or cause,
            "labels_to_recover": None,
            "bound": None,
            "details": details,
        }
        if self._recovery is not None:
            self._close_recovery(t, "interrupted")
        if self.mode == "exact":
            self.exact.reset_after_drift()
            self._open_recovery(record=record, start=t)
        else:
            self._db_events.append(record)
        self._version_at_reset = self.stream.version
        self._undetected.clear()
        self._overlap = False
        return self._log({"type": "detected", "step": t, "drift": drift_kind, **details})

    def _open_recovery(
        self, record: dict | None = None, start: int | None = None, initial: bool = False
    ) -> None:
        self._recovery = {
            "started_at": self.t if start is None else start,
            "labels": 0,
            "initial": initial,
            "record": record,
        }

    def _close_recovery(self, t: int, outcome: str) -> None:
        """End a recovery that never finished (another detection, or a mode switch)."""
        rec = self._recovery
        self._recovery = None
        if rec is None:
            return
        entry = {
            "step": t,
            "labels": rec["labels"],
            "bound": None,
            "path": outcome,
            "initial": rec["initial"],
            "correct": None,
            "recall_k": self.exact.recall_k,
            "theta_hat": None,
            "overlap": self._overlap,
        }
        self.recoveries.append(entry)
        # Live viewers see it on the next tick, like any other command-time event.
        self._queued.append(self._log({"type": "recovery_ended", **entry}))
        if rec["record"] is not None:
            rec["record"]["details"].update({"outcome": outcome, "labels_spent": rec["labels"]})
            self._db_events.append(rec["record"])

    def _recovered(self, t: int) -> dict:
        e = self.exact
        rec = self._recovery or {"started_at": t, "labels": 0, "initial": False, "record": None}
        self._recovery = None
        theta = e.lo
        if self.memory is not None:
            self.memory.remember(theta, t)
        key = f"theta:{theta}"
        self._register_concept(key, {"theta": theta}, t, reused=key in self.concept_registry)
        truth = self.stream.theta
        entry = {
            "step": t,
            "labels": rec["labels"],
            "bound": e.bound(),
            "path": e.path,
            "initial": rec["initial"],
            "correct": None if truth is None else theta == truth,
            "recall_k": e.recall_k,
            "theta_hat": theta,
            "overlap": self._overlap,
        }
        self.recoveries.append(entry)
        if self._overlap and entry["correct"]:
            # The overlapping change did no harm: the rule found is the true one.
            self._overlap = False
        if rec["record"] is not None:
            rec["record"]["labels_to_recover"] = entry["labels"]
            rec["record"]["bound"] = entry["bound"]
            rec["record"]["details"].update(
                {
                    "outcome": "recovered",
                    "recovered_at": t,
                    "path": e.path,
                    "theta_hat": theta,
                    "correct": entry["correct"],
                }
            )
            self._db_events.append(rec["record"])
        return self._log({"type": "recovered", **entry})

    def _register_concept(
        self, key: str, rule: dict, t: int, model: object | None = None, reused: bool = False
    ) -> None:
        """Queue an upsert for the concepts table (the all-time list, unlike memory)."""
        rec = self.concept_registry.get(key)
        if rec is None:
            rec = {"key": key, "learned_at_step": t, "rule": rule, "reuse_count": 0}
            self.concept_registry[key] = rec
        else:
            rec["rule"] = rule
            if reused:
                rec["reuse_count"] += 1
        pending = dict(rec, saved_at_step=t)
        if model is not None:
            pending["model"] = model
        self._concepts[key] = pending

    def _record_injected(self, event: dict) -> None:
        self.injected += 1
        self.note_change(event["step"], event["drift"])
        details = {k: event[k] for k in ("from", "to", "width") if k in event}
        self._db_events.append(
            {
                "step": event["step"],
                "source": "injected",
                "drift_type": event["drift"],
                "labels_to_recover": None,
                "bound": None,
                "details": details,
            }
        )
        self._log(event)

    def _log(self, event: dict) -> dict:
        self.events.append(event)
        return event

    # --------------------------------------------------------------- commands

    def _inject(
        self, kind: str, theta: int | None = None, width: int | None = None, step: int | None = None
    ) -> dict:
        step = self.t + 1 if step is None else step
        inj = self.injector
        if kind == "abrupt":
            event = inj.abrupt(step, theta)
        elif kind == "gradual":
            event = inj.gradual(step, theta, width or self.config.gradual_width)
        elif kind == "recurring":
            event = inj.recurring(step, theta)
        elif kind == "out_of_family":
            event = inj.arbitrary(step)
        else:
            raise ValueError(f"drift must be one of {DRIFTS}")
        self._record_injected(event)
        return event

    def inject(self, kind: str, theta: int | None = None, width: int | None = None) -> dict:
        """Change the true rule before the next step."""
        event = self._inject(kind, theta, width)
        self._queued.append(event)
        return event

    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if mode == self.mode:
            return
        self.mode = mode
        if mode == "exact":
            self._restart_exact()
        else:
            if self._recovery is not None:
                self._close_recovery(self.t, "abandoned")
            self._ensure_robust()
            self._fresh_baseline()
        self._queued.append(self._log({"type": "mode", "step": self.t + 1, "mode": mode}))

    def _restart_exact(self) -> None:
        """Relearn from scratch, with no label from before this point."""
        if self._recovery is not None:
            self._close_recovery(self.t, "abandoned")
        self.exact.reset()
        self._open_recovery(initial=True)
        self._fresh_baseline()

    def _fresh_baseline(self) -> None:
        """Changes before this point are absorbed by the relearning that follows."""
        self._version_at_reset = self.stream.version
        self._undetected.clear()
        self._overlap = False

    def set_p(self, p: float) -> None:
        _check_rate("p", p)
        self.p = p

    def set_noise(self, noise: float) -> None:
        _check_noise(noise)
        self.stream.noise = noise

    def set_memory(self, enabled: bool) -> None:
        """Turn recall on or off. Stored rules are kept either way."""
        if self.memory is None:
            self.memory = ConceptMemory(self.config.memory_capacity)
        self.exact.memory = self.memory if enabled else None
        self.config.memory = enabled

    def set_adversary(
        self,
        strategy: str,
        enabled: bool,
        k: int | None = None,
        period: int | None = None,
        gap: int | None = None,
        rate: float | None = None,
    ) -> dict:
        adv = self.adversary
        if strategy == "worst_case":
            adv.worst_case = enabled
            if gap is not None:
                if gap < 1:
                    raise ValueError("gap must be at least 1")
                adv.worst_case_gap = gap
        elif strategy == "rapid_fire":
            if k is not None and k < 1:
                raise ValueError("k must be at least 1")
            adv.rapid_fire = (k or 1) if enabled else None
        elif strategy == "stealth":
            if period is not None:
                if period < 1:
                    raise ValueError("period must be at least 1")
                adv.stealth_period = period
            adv.stealth = enabled
        elif strategy == "noise":
            self.set_noise((0.1 if rate is None else rate) if enabled else 0.0)
        else:
            raise ValueError(f"strategy must be one of {STRATEGIES}")
        event = {"type": "adversary", "step": self.t + 1, "strategy": strategy, "enabled": enabled}
        self._queued.append(self._log(event))
        return adv.describe()

    def apply_scenario(self, name: str) -> dict:
        """One-click setups for the impossibility lab (all run in exact mode)."""
        if name not in SCENARIOS:
            raise ValueError(f"scenario must be one of {SCENARIOS}")
        adv = self.adversary
        adv.worst_case = adv.stealth = False
        adv.rapid_fire = None
        self._scheduled_drift = None
        self.set_noise(0.0)
        self.set_p(1.0)
        if name != "all_clear":
            self.set_mode("exact")
        if name == "monitoring_off":
            self.set_p(0.0)
            self._scheduled_drift = "abrupt"  # fires once the engine is monitoring
        elif name == "noisy_labels":
            self.set_noise(0.1)
        elif name == "out_of_family":
            self.inject("out_of_family")
        elif name == "rapid_fire":
            adv.rapid_fire = 1
        elif name == "all_clear":
            if not self.stream.in_family:
                self.inject("abrupt")
            if self.mode == "exact":
                self._restart_exact()
        event = {"type": "scenario", "step": self.t + 1, "name": name}
        self._queued.append(self._log(event))
        return event

    # ---------------------------------------------------------------- outputs

    def conditions(self) -> dict:
        adv = self.adversary
        return {
            "rule_family": self.stream.in_family,
            "labels_clean": self.stream.noise == 0,
            "label_access": self.p > 0,
            "drift_timing": adv.rapid_fire is None
            and not adv.stealth
            and self.stream.gradual is None
            and not self._overlap,
        }

    def summary(self) -> dict:
        s = self.stream
        c = self.config
        exact_mode = self.mode == "exact"
        conditions = self.conditions()
        recall_on = self.exact.memory is not None
        # Rules recall would consider after the next drift (the current one is skipped).
        k = 0
        if recall_on:
            k = len(self.memory) - (1 if self.exact.rule in self.memory else 0)
        finished = [r for r in self.recoveries if r["bound"] is not None]
        if exact_mode:
            memory = self.memory.thetas() if self.memory is not None else []
        else:
            memory = sorted(m.boundary for m in self.robust.store)
        g = s.gradual
        return {
            "step": self.t,
            "mode": self.mode,
            "state": self.state,
            "n": c.n,
            "p": self.p,
            "noise": s.noise,
            "theta": s.theta,
            "in_family": s.in_family,
            "gradual": None
            if g is None
            else {"from": g.old.theta, "to": g.new.theta, "weight_new": round(g.weight_new(self.t), 3)},
            "lo": self.exact.lo if exact_mode else None,
            "hi": self.exact.hi if exact_mode else None,
            "theta_hat": self.exact.theta_hat if exact_mode else self.robust.boundary(),
            "candidates_left": self.exact.candidates_left if exact_mode else None,
            "memory": memory,
            "recall": recall_on,
            "error_rate": round(sum(self._err) / len(self._err), 4) if self._err else 0.0,
            "observed_error_rate": round(sum(self._obs_err) / len(self._obs_err), 4)
            if self._obs_err
            else 0.0,
            "counters": {
                "mistakes": self.mistakes,
                "labels": self.labels,
                "false_alarms": self.false_alarms,
                "detections": self.detections,
                "injected": self.injected,
                "recoveries": len(finished),
                "memory_size": len(memory),
                "confusion": dict(self.confusion),
            },
            "adversary": self.adversary.describe(),
            "scheduled_drift": self._scheduled_drift,
            "last_delay": self.last_delay,
            "bounds": {
                "recovery_labels": bounds.recovery_labels(c.n),
                "recall_labels": bounds.recall_labels(k) if bounds.recall_is_worthwhile(k, c.n) else None,
                "recall_fallback_labels": bounds.recall_fallback_labels(k, c.n)
                if bounds.recall_is_worthwhile(k, c.n)
                else None,
                "mistakes_per_drift_p1": bounds.mistakes_per_drift(c.n),
                "expected_mistakes_before_detection": bounds.expected_mistakes_before_detection(self.p),
                "noise_floor": bounds.noise_floor(s.noise),
            },
            "recovery_stats": {
                "count": len(finished),
                "max_labels": max((r["labels"] for r in finished), default=None),
                "within_bound": all(r["labels"] <= r["bound"] for r in finished),
            },
            "conditions": conditions,
            "guarantee": exact_mode and all(conditions.values()),
            "config": asdict(c),
        }

    def snapshot(self) -> dict:
        """Everything a dashboard needs to draw a run it has just joined."""
        return {
            "summary": self.summary(),
            "history": list(self.history),
            "events": list(self.events),
            "recoveries": list(self.recoveries),
            "ticks": list(self.recent),
        }

    def drain(self) -> tuple[list[dict], list[dict], list[dict]]:
        """Hand over pending metric points, drift events and concept upserts."""
        metrics, self._metrics = self._metrics, []
        events, self._db_events = self._db_events, []
        concepts = list(self._concepts.values())
        self._concepts = {}
        return metrics, events, concepts

    def close(self) -> None:
        """Flush a recovery that will never finish, so its detection is not lost."""
        if self._recovery is not None and self._recovery["record"] is not None:
            self._close_recovery(self.t, "open_at_close")
