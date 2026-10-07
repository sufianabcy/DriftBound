"""REST endpoints and the live WebSocket. Every path here sits under /api."""

from __future__ import annotations

import contextlib
import time

import anyio
import anyio.abc
from fastapi import APIRouter, HTTPException, Query, WebSocket

from engine import bounds

from .manager import LiveRun, RunManager
from .schemas import AdversaryRequest, CreateRun, DriftRequest, ScenarioRequest, SettingsPatch, StepRequest

HEARTBEAT_SECONDS = 15  # keeps idle sockets open through CloudFront


@contextlib.contextmanager
def bad_request():
    """Turn the engine's ValueErrors into 400 responses."""
    try:
        yield
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def stored_summary(events: list[dict], run: dict) -> dict:
    """What GET /runs/{id} reports for a run that is no longer live."""
    detected = [e for e in events if e["source"] == "detected"]
    finished = [e for e in detected if e["labels_to_recover"] is not None]
    n = (run.get("config") or {}).get("n", 1023)
    return {
        "injected": sum(1 for e in events if e["source"] == "injected"),
        "detected": len(detected),
        "false_alarms": sum(1 for e in detected if (e.get("details") or {}).get("false_alarm")),
        "recoveries": len(finished),
        "max_labels": max((e["labels_to_recover"] for e in finished), default=None),
        "within_bound": all(e["labels_to_recover"] <= e["bound"] for e in finished),
        "recovery_labels_bound": bounds.recovery_labels(n),
    }


def build_router(manager: RunManager, version: str) -> APIRouter:
    router = APIRouter()

    def live_run(run_id: str) -> LiveRun:
        try:
            return manager.get(run_id)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"run {run_id} is not live") from None

    @router.get("/health")
    async def health():
        db = manager.db
        reachable = await db.ping()
        return {
            "status": "ok",
            "version": version,
            "database": {
                "dialect": db.dialect,
                "reachable": reachable,
                "write_errors": manager.write_errors,
                "last_error": None if reachable else db.last_error,
            },
            "models": manager.store.kind,
            "live_runs": len(manager.runs),
        }

    @router.get("/runs")
    async def list_runs(limit: int = Query(30, ge=1, le=200)):
        try:
            stored = await manager.db.list_runs(limit)
        except Exception as exc:
            stored = []
            manager.db.last_error = str(exc)
        by_id = {r["id"]: r for r in stored}
        for live in manager.runs.values():
            row = by_id.setdefault(live.id, {"id": live.id, "name": live.name, "created_at": live.created_at})
            summary = live.runner.summary()
            row.update(
                live=True,
                kind=live.kind,
                status=live.status,
                mode=summary["mode"],
                steps=summary["step"],
                labels=summary["counters"]["labels"],
                false_alarms=summary["counters"]["false_alarms"],
                injected=summary["counters"]["injected"],
                detected=summary["counters"]["detections"],
            )
        for row in by_id.values():
            row.setdefault("live", False)
            row.setdefault("kind", (row.get("config") or {}).get("kind", "dashboard"))
        runs = sorted(by_id.values(), key=lambda r: r["created_at"], reverse=True)
        return {"runs": runs[:limit]}

    @router.post("/runs", status_code=201)
    async def create_run(req: CreateRun):
        with bad_request():
            live = await manager.create(req)
        return manager.state(live)

    @router.get("/runs/{run_id}")
    async def get_run(run_id: str):
        if run_id in manager.runs:
            return manager.state(manager.get(run_id))
        run = await manager.db.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"run {run_id} not found")
        events = await manager.db.get_events(run_id)
        return {"run": {**run, "live": False}, "summary": None, "stored": stored_summary(events, run)}

    @router.patch("/runs/{run_id}")
    async def update_run(run_id: str, patch: SettingsPatch):
        live_run(run_id)
        with bad_request():
            live = await manager.update(run_id, patch)
        return manager.state(live)

    @router.post("/runs/{run_id}/start")
    async def start_run(run_id: str):
        live_run(run_id)
        return manager.state(await manager.start_run(run_id))

    @router.post("/runs/{run_id}/stop")
    async def stop_run(run_id: str):
        live_run(run_id)
        return manager.state(await manager.stop_run(run_id))

    @router.post("/runs/{run_id}/step")
    async def step_run(run_id: str, req: StepRequest):
        live_run(run_id)
        with bad_request():
            live, ticks = await manager.step_run(run_id, req.count, req.x)
        return {"ticks": ticks, **manager.state(live)}

    @router.post("/runs/{run_id}/drift")
    async def inject_drift(run_id: str, req: DriftRequest):
        live_run(run_id)
        with bad_request():
            event = await manager.inject(run_id, req.type, req.theta, req.width)
        return {"event": event}

    @router.post("/runs/{run_id}/adversary")
    async def set_adversary(run_id: str, req: AdversaryRequest):
        live_run(run_id)
        with bad_request():
            described = await manager.adversary(run_id, **req.model_dump())
        return {"adversary": described}

    @router.post("/runs/{run_id}/scenario")
    async def apply_scenario(run_id: str, req: ScenarioRequest):
        live_run(run_id)
        with bad_request():
            event = await manager.scenario(run_id, req.name)
        return {"event": event}

    @router.get("/runs/{run_id}/events")
    async def run_events(run_id: str):
        return {"events": await manager.db.get_events(run_id)}

    @router.get("/runs/{run_id}/metrics")
    async def run_metrics(run_id: str, max_points: int = Query(2000, ge=10, le=20_000)):
        every = 5
        if run_id in manager.runs:
            every = manager.get(run_id).runner.config.metric_every
        else:
            run = await manager.db.get_run(run_id)
            if run is not None:
                every = (run.get("config") or {}).get("metric_every", every)
        return {"metrics": await manager.db.get_metrics(run_id, max_points, every)}

    @router.get("/runs/{run_id}/concepts")
    async def run_concepts(run_id: str):
        return {"concepts": await manager.db.get_concepts(run_id)}

    @router.websocket("/runs/{run_id}/live")
    async def live_ticks(ws: WebSocket, run_id: str):
        await ws.accept()
        live = manager.runs.get(run_id)
        if live is None:
            await ws.send_json({"type": "error", "detail": f"run {run_id} is not live"})
            await ws.close(code=4404)
            return
        queue = manager.hub.subscribe(run_id)
        live.last_watched = time.monotonic()

        async def send(group: anyio.abc.TaskGroup) -> None:
            try:
                await ws.send_json({"type": "snapshot", "run": manager.info(live), **live.runner.snapshot()})
                while True:
                    with anyio.move_on_after(HEARTBEAT_SECONDS) as wait:
                        message = await queue.get()
                    if wait.cancelled_caught:
                        message = {"type": "ping"}
                    await ws.send_json(message)
                    if message["type"] == "closed":
                        break
            except Exception:
                pass  # the viewer went away mid-send
            group.cancel_scope.cancel()

        async def receive(group: anyio.abc.TaskGroup) -> None:
            # The dashboard sends nothing; reading is how a disconnect is noticed.
            with contextlib.suppress(Exception):
                while (await ws.receive())["type"] != "websocket.disconnect":
                    pass
            group.cancel_scope.cancel()

        try:
            async with anyio.create_task_group() as group:
                group.start_soon(send, group)
                group.start_soon(receive, group)
        finally:
            manager.hub.unsubscribe(run_id, queue)
            with contextlib.suppress(Exception):
                await ws.close()

    return router
