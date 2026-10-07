"""The database layer on SQLite, and db/schema.sql against a real PostgreSQL.

The PostgreSQL test runs when TEST_DATABASE_URL points at an empty database,
for example postgresql+asyncpg://postgres@localhost:5432/driftbound_test.
CI starts one; locally it is skipped unless you set the variable.
"""

import asyncio
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import inspect, text

from api.db import Database, metadata

SCHEMA = Path(__file__).resolve().parent.parent / "db" / "schema.sql"


async def exercise(db: Database) -> None:
    """Write and read one run through every method the API uses."""
    await db.create_run(
        {
            "id": "r1",
            "name": "test",
            "mode": "exact",
            "config": {"n": 1023, "metric_every": 5},
            "status": "created",
            "created_at": datetime.now(UTC),
        }
    )
    metrics = [
        {
            "step": s,
            "mode": "exact",
            "error_rate": 0.0,
            "observed_error_rate": 0.0,
            "mistakes_total": 1,
            "labels_total": s,
            "candidates_left": 1,
            "false_alarms": 0,
        }
        for s in range(5, 1001, 5)
    ]
    events = [
        {"step": 10, "source": "injected", "drift_type": "abrupt", "details": {"from": 1, "to": 900}},
        {
            "step": 12,
            "source": "detected",
            "drift_type": "abrupt",
            "labels_to_recover": 10,
            "bound": 10,
            "details": {"false_alarm": False},
        },
    ]
    rule = {"key": "theta:900", "learned_at_step": 22, "rule": {"theta": 900}, "reuse_count": 0}
    await db.write_batch("r1", metrics, events, [rule])
    await db.write_batch("r1", [], [], [{**rule, "reuse_count": 3}])  # upsert, not a second row
    await db.update_run("r1", {"status": "stopped"})

    runs = await db.list_runs()
    assert runs[0]["id"] == "r1" and runs[0]["status"] == "stopped"
    assert runs[0]["injected"] == 1 and runs[0]["detected"] == 1 and runs[0]["steps"] == 1000
    assert runs[0]["created_at"].endswith("+00:00")
    stored_events = await db.get_events("r1")
    assert [e["source"] for e in stored_events] == ["injected", "detected"]
    assert stored_events[1]["details"] == {"false_alarm": False}
    concepts = await db.get_concepts("r1")
    assert len(concepts) == 1 and concepts[0]["reuse_count"] == 3 and concepts[0]["rule"] == {"theta": 900}
    assert len(await db.get_metrics("r1")) == 200
    thinned = await db.get_metrics("r1", max_points=50, metric_every=5)
    assert 40 <= len(thinned) <= 50


def test_sqlite_round_trip(tmp_path):
    async def main():
        db = Database(f"sqlite+aiosqlite:///{tmp_path}/t.db")
        await db.init()
        await exercise(db)
        await db.close()

    asyncio.run(main())


def test_startup_marks_orphaned_runs_interrupted(tmp_path):
    async def main():
        url = f"sqlite+aiosqlite:///{tmp_path}/t.db"
        db = Database(url)
        await db.init()
        await db.create_run(
            {
                "id": "r9",
                "name": "x",
                "mode": "exact",
                "config": {},
                "status": "running",
                "created_at": datetime.now(UTC),
            }
        )
        await db.close()
        db = Database(url)  # a new process starting up
        await db.init()
        assert (await db.get_run("r9"))["status"] == "interrupted"
        await db.close()

    asyncio.run(main())


@pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"), reason="set TEST_DATABASE_URL to a PostgreSQL database"
)
def test_schema_sql_matches_the_app_tables_on_postgres():
    async def main():
        db = Database(os.environ["TEST_DATABASE_URL"])
        async with db.engine.begin() as conn:
            await conn.execute(
                text("DROP TABLE IF EXISTS concepts, drift_events, metric_points, runs CASCADE")
            )
            raw = await conn.get_raw_connection()
            await raw.driver_connection.execute(SCHEMA.read_text())  # exactly what psql -f would run

            def describe(sync_conn):
                insp = inspect(sync_conn)
                return {
                    table: {
                        "columns": {c["name"]: c["nullable"] for c in insp.get_columns(table)},
                        "pk": insp.get_pk_constraint(table)["constrained_columns"],
                    }
                    for table in insp.get_table_names()
                }

            found = await conn.run_sync(describe)
        expected = {
            t.name: {
                "columns": {c.name: c.nullable for c in t.columns},
                "pk": [c.name for c in t.primary_key],
            }
            for t in metadata.sorted_tables
        }
        assert found == expected
        await db.init()  # create_all must accept the tables schema.sql made
        await exercise(db)
        await db.close()

    asyncio.run(main())
