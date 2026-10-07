"""Live runs: one asyncio task per running run, and one writer for all storage.

The live demo must never wait on the database. Commands and the stream loop
touch only memory; persistence goes through a queue that a single writer task
drains in order. If the database is down, the demo keeps running and the
writes are logged as failed.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import pickle
import secrets
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

from engine.runner import RunConfig, Runner

from .config import Settings
from .db import Database
from .live import Hub
from .schemas import CreateRun, SettingsPatch
from .storage import ModelStore

log = logging.getLogger("driftbound")

LOOP_INTERVAL = 0.05  # seconds between bursts of engine steps
PUBLISH_INTERVAL = 0.1  # seconds between WebSocket messages: about 10 per second
MAX_BURST = 250  # a stalled loop drops time instead of racing to catch up


@dataclass
class LiveRun:
    id: str
    name: str
    runner: Runner
    speed: float
    created_at: str
    status: str = "created"  # created | running | stopped | error
    stop_reason: str | None = None
    task: asyncio.Task | None = None
    last_watched: float = field(default_factory=time.monotonic)
    kind: str = "dashboard"  # or "fraud" / "spam", for the two test pages


class RunManager:
    def __init__(self, settings: Settings, db: Database, store: ModelStore, hub: Hub):
        self.settings = settings
        self.db = db
        self.store = store
        self.hub = hub
        self.runs: dict[str, LiveRun] = {}
        self.write_errors = 0
        self._writes: asyncio.Queue | None = None
        self._writer: asyncio.Task | None = None
        self._unsaved_rows: dict[str, dict] = {}  # runs whose insert failed, retried later

    # ------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        self._writes = asyncio.Queue()
        self._writer = asyncio.create_task(self._write_loop(), name="db-writer")

    async def shutdown(self) -> None:
        for live in list(self.runs.values()):
            status = "interrupted" if live.status == "running" else live.status
            await self._halt(live, status, "server shut down")
            live.runner.close()
            self._flush(live)
        if self._writes is not None and self._writer is not None:
            await self._writes.put(None)
            try:
                await asyncio.wait_for(self._writer, timeout=10)
            except TimeoutError:
                self._writer.cancel()

    def get(self, run_id: str) -> LiveRun:
        return self.runs[run_id]  # KeyError means "not live"

    def info(self, live: LiveRun) -> dict:
        return {
            "id": live.id,
            "name": live.name,
            "status": live.status,
            "stop_reason": live.stop_reason,
            "speed": live.speed,
            "created_at": live.created_at,
            "viewers": self.hub.viewers(live.id),
            "live": True,
            "kind": live.kind,
        }

    def state(self, live: LiveRun) -> dict:
        return {"run": self.info(live), "summary": live.runner.summary()}

    # ------------------------------------------------------------- commands

    async def create(self, req: CreateRun) -> LiveRun:
        config = RunConfig(
            n=req.n,
            mode=req.mode,
            p=req.p,
            noise=req.noise,
            seed=req.seed if req.seed is not None else secrets.randbits(31),
            theta=req.theta,
            memory=req.memory,
        )
        runner = Runner(config)  # raises ValueError on a bad config
        await self._make_room()
        now = datetime.now(UTC)
        run_id = secrets.token_hex(6)
        live = LiveRun(
            id=run_id,
            name=req.name or f"{req.mode} run, {now:%d %b %H:%M:%S}",
            runner=runner,
            speed=min(req.speed or self.settings.default_speed, self.settings.max_speed),
            created_at=now.isoformat(),
            kind=req.kind,
        )
        self.runs[run_id] = live
        row = {
            "id": run_id,
            "name": live.name,
            "mode": config.mode,
            "config": self._config(live),
            "status": "created",
            "created_at": now,
        }
        self._enqueue("create", run_id, row)
        if req.start:
            await self.start_run(run_id)
        return live

    async def start_run(self, run_id: str) -> LiveRun:
        live = self.get(run_id)
        if live.status != "running":
            live.status = "running"
            live.stop_reason = None
            live.last_watched = time.monotonic()
            live.task = asyncio.create_task(self._loop(live), name=f"run-{run_id}")
            self._enqueue("update", run_id, {"status": "running"})
            self._announce(live)
        return live

    async def stop_run(self, run_id: str, reason: str = "stopped from the dashboard") -> LiveRun:
        live = self.get(run_id)
        if live.status == "running":
            await self._halt(live, "stopped", reason)
        return live

    async def inject(self, run_id: str, kind: str, theta: int | None, width: int | None) -> dict:
        live = self.get(run_id)
        event = live.runner.inject(kind, theta, width)
        self._announce(live)
        return event

    async def step_run(self, run_id: str, count: int = 1, x: int | None = None) -> tuple[LiveRun, list[dict]]:
        """Run steps right now, playing or paused: the test page's "next transaction"."""
        live = self.get(run_id)
        if x is not None and count != 1:
            raise ValueError("a chosen input is processed on its own: use count 1")
        ticks = []
        for i in range(count):
            tick = live.runner.step(x if i == 0 else None)
            ticks.append(tick)
            self.hub.push(live.id, tick)
        live.last_watched = time.monotonic()
        self._flush(live)
        self.hub.flush(live.id, self.state(live))
        return live, ticks

    async def adversary(self, run_id: str, **params) -> dict:
        live = self.get(run_id)
        described = live.runner.set_adversary(**params)
        self._save_config(live)
        self._announce(live)
        return described

    async def update(self, run_id: str, patch: SettingsPatch) -> LiveRun:
        live = self.get(run_id)
        runner = live.runner
        if patch.mode is not None:
            runner.set_mode(patch.mode)
        if patch.p is not None:
            runner.set_p(patch.p)
        if patch.noise is not None:
            runner.set_noise(patch.noise)
        if patch.memory is not None:
            runner.set_memory(patch.memory)
        if patch.speed is not None:
            live.speed = min(patch.speed, self.settings.max_speed)
        self._save_config(live)
        self._announce(live)
        return live

    async def scenario(self, run_id: str, name: str) -> dict:
        live = self.get(run_id)
        event = live.runner.apply_scenario(name)
        self._save_config(live)
        self._announce(live)
        return event

    async def evict(self, run_id: str) -> None:
        live = self.runs.pop(run_id)
        await self._halt(live, "stopped" if live.status == "running" else live.status, "evicted to make room")
        live.runner.close()
        self._flush(live)
        self.hub.close_run(run_id, {"type": "closed", "reason": "evicted to make room for a new run"})

    # --------------------------------------------------------------- the loop

    async def _loop(self, live: LiveRun) -> None:
        loop = asyncio.get_running_loop()
        runner = live.runner
        last = last_publish = loop.time()
        carry = 0.0
        flushed_at = runner.t
        try:
            while True:
                await asyncio.sleep(LOOP_INTERVAL)
                now = loop.time()
                carry += live.speed * (now - last)
                last = now
                steps = int(carry)
                carry -= steps
                if steps > MAX_BURST:
                    steps, carry = MAX_BURST, 0.0
                for _ in range(steps):
                    self.hub.push(live.id, runner.step())
                if runner.t - flushed_at >= self.settings.flush_every:
                    self._flush(live)
                    flushed_at = runner.t
                if now - last_publish >= PUBLISH_INTERVAL:
                    self.hub.flush(live.id, self.state(live))
                    last_publish = now
                if self.hub.viewers(live.id):
                    live.last_watched = time.monotonic()
                elif time.monotonic() - live.last_watched > self.settings.idle_stop_seconds:
                    # Nobody is watching: stop, so a forgotten tab cannot burn credits.
                    live.task = None
                    self._stopped(live, "stopped", "nobody was watching")
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("run %s crashed", live.id)
            live.task = None
            self._stopped(live, "error", f"engine error: {exc}")

    async def _halt(self, live: LiveRun, status: str, reason: str) -> None:
        task, live.task = live.task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._stopped(live, status, reason)

    def _stopped(self, live: LiveRun, status: str, reason: str) -> None:
        live.status = status
        live.stop_reason = reason
        self._flush(live)
        self._enqueue("update", live.id, {"status": status})
        self._announce(live)

    async def _make_room(self) -> None:
        while len(self.runs) >= self.settings.max_live_runs:
            # Runs nobody is watching go first, then paused ones, oldest first.
            victim = min(
                self.runs.values(),
                key=lambda r: (self.hub.viewers(r.id) > 0, r.status == "running", r.created_at),
            )
            await self.evict(victim.id)

    def _announce(self, live: LiveRun) -> None:
        """Push fresh state to viewers right away, even while the run is stopped."""
        self.hub.publish(live.id, {"type": "state", **self.state(live)})

    # ------------------------------------------------------------ persistence

    def _config(self, live: LiveRun) -> dict:
        runner = live.runner
        return {
            **asdict(runner.config),
            "mode": runner.mode,
            "p": runner.p,
            "noise": runner.stream.noise,
            "speed": live.speed,
            "adversary": runner.adversary.describe(),
            "kind": live.kind,
        }

    def _save_config(self, live: LiveRun) -> None:
        self._enqueue("update", live.id, {"mode": live.runner.mode, "config": self._config(live)})

    def _flush(self, live: LiveRun) -> None:
        metrics, events, rules = live.runner.drain()
        if metrics or events or rules:
            self._enqueue("batch", live.id, (metrics, events, rules))

    def _enqueue(self, kind: str, run_id: str, payload) -> None:
        if self._writes is not None:
            self._writes.put_nowait((kind, run_id, payload))

    async def _write_loop(self) -> None:
        while True:
            job = await self._writes.get()
            if job is None:
                return
            kind, run_id, payload = job
            try:
                await self._write(kind, run_id, payload)
                self.db.ok = True
            except Exception as exc:
                self.write_errors += 1
                self.db.ok = False
                self.db.last_error = str(exc)
                log.warning("database write failed (%s, run %s): %s", kind, run_id, exc)

    async def _write(self, kind: str, run_id: str, payload) -> None:
        if kind == "create":
            self._unsaved_rows[run_id] = payload
        if run_id in self._unsaved_rows:
            # The run row must exist before anything that references it.
            await self.db.create_run(self._unsaved_rows[run_id])
            del self._unsaved_rows[run_id]
        if kind == "update":
            await self.db.update_run(run_id, payload)
        elif kind == "batch":
            metrics, events, rules = payload
            await self._snapshot_models(run_id, rules)
            await self.db.write_batch(run_id, metrics, events, rules)

    async def _snapshot_models(self, run_id: str, rules: list[dict]) -> None:
        """Upload robust-mode models; the database row keeps only the URI."""
        for rule in rules:
            model = rule.pop("model", None)
            if model is None:
                continue
            blob = pickle.dumps(model)
            step = rule.get("saved_at_step", rule["learned_at_step"])
            try:
                uri = await asyncio.to_thread(self.store.save, run_id, rule["key"], step, blob)
            except Exception as exc:
                log.warning("model snapshot upload failed for run %s: %s", run_id, exc)
                uri = None
            rule["rule"] = {**rule["rule"], "uri": uri}
