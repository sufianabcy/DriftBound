"""Async database access. Writes arrive in batches; nothing here runs once per step.

The tables are defined once, in SQLAlchemy Core, and work on PostgreSQL (RDS)
and SQLite (local fallback). db/schema.sql is the same schema written out for
psql; tests/test_db.py checks that the two agree.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

JSONType = JSON().with_variant(JSONB(), "postgresql")
# SQLite only auto-increments an INTEGER PRIMARY KEY; Postgres gets BIGSERIAL.
SerialID = BigInteger().with_variant(Integer(), "sqlite")

metadata = MetaData()

runs = Table(
    "runs",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("name", Text, nullable=False),
    Column("mode", String(16), nullable=False),
    Column("config", JSONType, nullable=False),
    Column("status", String(16), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    CheckConstraint("mode IN ('exact', 'robust')", name="runs_mode_check"),
)

metric_points = Table(
    "metric_points",
    metadata,
    Column("run_id", String(32), ForeignKey("runs.id", ondelete="CASCADE"), primary_key=True),
    Column("step", Integer, primary_key=True),
    Column("mode", String(16), nullable=False),
    Column("error_rate", Float, nullable=False),
    Column("observed_error_rate", Float, nullable=False),
    Column("mistakes_total", Integer, nullable=False),
    Column("labels_total", Integer, nullable=False),
    Column("candidates_left", Integer),
    Column("false_alarms", Integer, nullable=False),
)

drift_events = Table(
    "drift_events",
    metadata,
    Column("id", SerialID, primary_key=True, autoincrement=True),
    Column("run_id", String(32), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False),
    Column("step", Integer, nullable=False),
    Column("source", String(16), nullable=False),  # injected | detected
    Column("drift_type", String(32), nullable=False),
    Column("labels_to_recover", Integer),
    Column("bound", Integer),
    Column("details", JSONType, nullable=False),
    CheckConstraint("source IN ('injected', 'detected')", name="drift_events_source_check"),
    Index("drift_events_run_step", "run_id", "step"),
)

concepts = Table(
    "concepts",
    metadata,
    Column("id", SerialID, primary_key=True, autoincrement=True),
    Column("run_id", String(32), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False),
    Column("key", String(64), nullable=False),
    Column("learned_at_step", Integer, nullable=False),
    Column("rule", JSONType, nullable=False),
    Column("reuse_count", Integer, nullable=False, server_default="0"),
    UniqueConstraint("run_id", "key", name="concepts_run_key"),
)

METRIC_COLUMNS = [c.name for c in metric_points.columns if c.name != "run_id"]
EVENT_COLUMNS = ["step", "source", "drift_type", "labels_to_recover", "bound", "details"]
CONCEPT_COLUMNS = ["key", "learned_at_step", "rule", "reuse_count"]


def _pick(row: dict, columns: list[str]) -> dict:
    return {c: row.get(c) for c in columns}


class Database:
    def __init__(self, url: str):
        self.url = url
        self.engine: AsyncEngine = create_async_engine(url, pool_pre_ping=True)
        self.dialect = self.engine.dialect.name  # "postgresql" or "sqlite"
        self.ok = False
        self.last_error: str | None = None

    async def init(self) -> None:
        """Create missing tables, then mark runs a dead process left 'running'."""
        async with self.engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
            # Live state lived in that process's memory, so those runs cannot resume.
            await conn.execute(update(runs).where(runs.c.status == "running").values(status="interrupted"))
        self.ok = True

    async def close(self) -> None:
        await self.engine.dispose()

    async def ping(self) -> bool:
        try:
            async with self.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            self.ok = True
        except Exception as exc:  # report, never raise, from a health check
            self.ok = False
            self.last_error = str(exc)
        return self.ok

    # ----------------------------------------------------------------- writes

    async def create_run(self, row: dict) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(runs.insert().values(**row))

    async def update_run(self, run_id: str, values: dict) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(update(runs).where(runs.c.id == run_id).values(**values))

    async def write_batch(
        self, run_id: str, metrics: list[dict], events: list[dict], rules: list[dict]
    ) -> None:
        """One transaction per flush: metric points, drift events, concept upserts."""
        if not (metrics or events or rules):
            return
        async with self.engine.begin() as conn:
            if metrics:
                await conn.execute(
                    metric_points.insert(), [{"run_id": run_id, **_pick(m, METRIC_COLUMNS)} for m in metrics]
                )
            if events:
                await conn.execute(
                    drift_events.insert(), [{"run_id": run_id, **_pick(e, EVENT_COLUMNS)} for e in events]
                )
            insert = pg_insert if self.dialect == "postgresql" else sqlite_insert
            for rule in rules:
                stmt = insert(concepts).values(run_id=run_id, **_pick(rule, CONCEPT_COLUMNS))
                stmt = stmt.on_conflict_do_update(
                    index_elements=["run_id", "key"],
                    set_={"rule": stmt.excluded.rule, "reuse_count": stmt.excluded.reuse_count},
                )
                await conn.execute(stmt)

    # ------------------------------------------------------------------ reads

    async def list_runs(self, limit: int = 50) -> list[dict]:
        def count(source: str):
            return (
                select(func.count())
                .select_from(drift_events)
                .where(drift_events.c.run_id == runs.c.id, drift_events.c.source == source)
                .scalar_subquery()
            )

        def latest(column):
            return select(func.max(column)).where(metric_points.c.run_id == runs.c.id).scalar_subquery()

        query = (
            select(
                runs,
                count("injected").label("injected"),
                count("detected").label("detected"),
                latest(metric_points.c.step).label("steps"),
                latest(metric_points.c.false_alarms).label("false_alarms"),
                latest(metric_points.c.labels_total).label("labels"),
            )
            .order_by(runs.c.created_at.desc(), runs.c.id)
            .limit(limit)
        )
        async with self.engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [_jsonable(dict(r)) for r in rows]

    async def get_run(self, run_id: str) -> dict | None:
        async with self.engine.connect() as conn:
            row = (await conn.execute(select(runs).where(runs.c.id == run_id))).mappings().first()
        return None if row is None else _jsonable(dict(row))

    async def get_events(self, run_id: str) -> list[dict]:
        query = (
            select(drift_events)
            .where(drift_events.c.run_id == run_id)
            .order_by(drift_events.c.step, drift_events.c.id)
        )
        async with self.engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [_jsonable(dict(r)) for r in rows]

    async def get_concepts(self, run_id: str) -> list[dict]:
        query = select(concepts).where(concepts.c.run_id == run_id).order_by(concepts.c.learned_at_step)
        async with self.engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [_jsonable(dict(r)) for r in rows]

    async def get_metrics(self, run_id: str, max_points: int = 2000, metric_every: int = 5) -> list[dict]:
        """Stored metric points, thinned on the server to at most about max_points."""
        where = metric_points.c.run_id == run_id
        async with self.engine.connect() as conn:
            total = (await conn.execute(select(func.count()).where(where))).scalar_one()
            query = select(metric_points).where(where).order_by(metric_points.c.step)
            stride = math.ceil(total / max_points) if total > max_points else 1
            if stride > 1:
                query = query.where(metric_points.c.step % (metric_every * stride) == 0)
            rows = (await conn.execute(query)).mappings().all()
        return [_jsonable(dict(r)) for r in rows]


def _jsonable(row: dict[str, Any]) -> dict[str, Any]:
    created = row.get("created_at")
    if isinstance(created, datetime):
        if created.tzinfo is None:  # SQLite drops the zone; everything is stored in UTC
            created = created.replace(tzinfo=UTC)
        row["created_at"] = created.isoformat()
    return row
