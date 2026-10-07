"""Milestone 5: a run started over the API streams ticks, and rows land in the database."""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.config import Settings
from api.main import create_app


def make_client(tmp_path: Path, **overrides) -> TestClient:
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite+aiosqlite:///{tmp_path}/test.db",
        models_dir=str(tmp_path / "models"),
        web_dist=str(tmp_path / "no-dashboard"),
        **overrides,
    )
    return TestClient(create_app(settings))


@pytest.fixture
def client(tmp_path):
    with make_client(tmp_path) as c:
        yield c


def wait_for(fetch, timeout: float = 10.0):
    """Poll fetch() until it returns something truthy."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fetch()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("timed out waiting")


def create(client: TestClient, **body) -> str:
    response = client.post("/api/runs", json={"seed": 1, "speed": 500, **body})
    assert response.status_code == 201, response.text
    return response.json()["run"]["id"]


def summary(client: TestClient, run_id: str) -> dict:
    return client.get(f"/api/runs/{run_id}").json()["summary"]


def test_health_reports_the_database(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["database"]["dialect"] == "sqlite"
    assert body["database"]["reachable"]
    assert body["models"] == "local"


def test_a_run_streams_ticks_detects_drift_and_writes_history(client):
    run_id = create(client, start=True)
    events = []
    with client.websocket_connect(f"/api/runs/{run_id}/live") as ws:
        assert ws.receive_json()["type"] == "snapshot"
        wait_for(lambda: summary(client, run_id)["state"] == "monitoring")
        assert client.post(f"/api/runs/{run_id}/drift", json={"type": "abrupt"}).status_code == 200
        for _ in range(100):
            message = ws.receive_json()
            if message["type"] == "ticks":
                assert len(message["ticks"]) <= 60
                assert (
                    message["summary"]["step"] >= message["ticks"][-1]["step"] if message["ticks"] else True
                )
                events += [e for tick in message["ticks"] for e in tick["events"]]
            if any(e["type"] == "recovered" and not e["initial"] for e in events):
                break
    kinds = [e["type"] for e in events]
    assert "injected" in kinds and "detected" in kinds and "recovered" in kinds
    recovered = next(e for e in events if e["type"] == "recovered" and not e["initial"])
    assert recovered["labels"] == recovered["bound"] == 10

    stopped = client.post(f"/api/runs/{run_id}/stop").json()
    assert stopped["run"]["status"] == "stopped"
    final_step = stopped["summary"]["step"]
    # Every metric point up to the final step is written, a batch at a time.
    metrics = wait_for(
        lambda: (
            (m := client.get(f"/api/runs/{run_id}/metrics").json()["metrics"])
            and len(m) == final_step // 5
            and m
        )
    )
    assert [m["step"] for m in metrics] == list(range(5, final_step + 1, 5))
    stored = [
        e for e in client.get(f"/api/runs/{run_id}/events").json()["events"] if e["source"] == "detected"
    ]
    assert stored[0]["labels_to_recover"] == 10 and stored[0]["bound"] == 10
    listed = {r["id"]: r for r in client.get("/api/runs").json()["runs"]}
    assert listed[run_id]["status"] == "stopped"
    concepts = client.get(f"/api/runs/{run_id}/concepts").json()["concepts"]
    assert len(concepts) == 2 and all("theta" in c["rule"] for c in concepts)


def test_metrics_are_thinned_for_replay(client):
    run_id = create(client, start=True)
    wait_for(lambda: summary(client, run_id)["step"] > 1_500)
    client.post(f"/api/runs/{run_id}/stop")
    wait_for(lambda: len(client.get(f"/api/runs/{run_id}/metrics").json()["metrics"]) >= 300)
    thinned = client.get(f"/api/runs/{run_id}/metrics", params={"max_points": 100}).json()["metrics"]
    assert 50 <= len(thinned) <= 100


def test_robust_runs_save_model_snapshots(client, tmp_path):
    run_id = create(client, mode="robust", theta=300, start=True)
    wait_for(lambda: summary(client, run_id)["step"] > 1_500)
    client.post(f"/api/runs/{run_id}/drift", json={"type": "abrupt", "theta": 800})
    wait_for(lambda: summary(client, run_id)["counters"]["detections"] >= 1)
    client.post(f"/api/runs/{run_id}/stop")
    concepts = wait_for(lambda: client.get(f"/api/runs/{run_id}/concepts").json()["concepts"])
    uri = concepts[0]["rule"]["uri"]
    assert uri.startswith("local://")
    assert (tmp_path / "models" / uri.removeprefix("local://")).is_file()


def test_settings_scenarios_and_adversary(client):
    run_id = create(client)
    body = client.patch(f"/api/runs/{run_id}", json={"mode": "robust", "p": 0.5, "speed": 100}).json()
    assert body["summary"]["mode"] == "robust" and body["summary"]["p"] == 0.5 and body["run"]["speed"] == 100
    client.post(f"/api/runs/{run_id}/scenario", json={"name": "noisy_labels"})
    s = summary(client, run_id)
    assert s["mode"] == "exact" and s["noise"] == 0.1 and not s["conditions"]["labels_clean"]
    adv = client.post(f"/api/runs/{run_id}/adversary", json={"strategy": "rapid_fire", "k": 3}).json()
    assert adv["adversary"]["rapid_fire"] == 3
    assert not summary(client, run_id)["conditions"]["drift_timing"]


def test_bad_requests_are_rejected(client):
    run_id = create(client)
    assert client.post(f"/api/runs/{run_id}/drift", json={"type": "recurring"}).status_code == 400
    assert (
        client.post(f"/api/runs/{run_id}/drift", json={"type": "abrupt", "theta": 99_999}).status_code == 400
    )
    assert client.post(f"/api/runs/{run_id}/drift", json={"type": "sideways"}).status_code == 422
    assert client.patch(f"/api/runs/{run_id}", json={"p": 2}).status_code == 422
    assert client.post("/api/runs", json={"n": 10, "theta": 50}).status_code == 400
    assert client.post("/api/runs/nope/start").status_code == 404
    assert client.get("/api/runs/nope").status_code == 404


def test_websocket_for_an_unknown_run_says_so(client):
    with client.websocket_connect("/api/runs/nope/live") as ws:
        assert ws.receive_json()["type"] == "error"


def test_old_runs_are_evicted_but_stay_in_history(tmp_path):
    with make_client(tmp_path, max_live_runs=2) as client:
        first = create(client)
        create(client)
        create(client)
        runs = client.get("/api/runs").json()["runs"]
        assert sum(r["live"] for r in runs) == 2
        assert {r["id"]: r["live"] for r in runs}[first] is False
        stored = wait_for(lambda: client.get(f"/api/runs/{first}").json())
        assert stored["run"]["live"] is False and stored["stored"]["injected"] == 0


def test_runs_nobody_watches_stop_on_their_own(tmp_path):
    with make_client(tmp_path, idle_stop_seconds=0) as client:
        run_id = create(client, start=True)
        run = wait_for(
            lambda: (r := client.get(f"/api/runs/{run_id}").json()["run"])["status"] == "stopped" and r
        )
        assert run["stop_reason"] == "nobody was watching"


def test_steps_run_on_demand_with_a_chosen_input(client):
    run_id = create(client, kind="fraud", theta=600)
    stepped = client.post(f"/api/runs/{run_id}/step", json={"count": 10}).json()
    assert len(stepped["ticks"]) == 10
    assert stepped["summary"]["step"] == 10 and stepped["summary"]["state"] == "monitoring"
    assert stepped["run"]["kind"] == "fraud" and stepped["run"]["status"] == "created"
    chosen = client.post(f"/api/runs/{run_id}/step", json={"x": 650}).json()["ticks"]
    assert [t["x"] for t in chosen] == [650] and chosen[0]["y_pred"] == 1
    assert client.post(f"/api/runs/{run_id}/step", json={"x": 5_000}).status_code == 400
    assert client.post(f"/api/runs/{run_id}/step", json={"x": 5, "count": 2}).status_code == 400
    assert client.post(f"/api/runs/{run_id}/step", json={"count": 0}).status_code == 422
    listed = {r["id"]: r for r in client.get("/api/runs").json()["runs"]}
    assert listed[run_id]["kind"] == "fraud"


def test_watched_runs_are_evicted_last(tmp_path):
    with make_client(tmp_path, max_live_runs=2) as client:
        watched = create(client)
        with client.websocket_connect(f"/api/runs/{watched}/live") as ws:
            assert ws.receive_json()["type"] == "snapshot"
            unwatched = create(client)
            create(client)
            live = {r["id"] for r in client.get("/api/runs").json()["runs"] if r["live"]}
        assert watched in live and unwatched not in live


def test_root_explains_how_to_get_the_dashboard(client):
    page = client.get("/")
    assert page.status_code == 200 and "DriftBound API is running" in page.text
