-- DriftBound schema for PostgreSQL (Amazon RDS).
--
-- Recreate the tables with:
--   psql "host=RDS-ENDPOINT dbname=driftbound user=USER sslmode=require" -f db/schema.sql
--
-- This is the same schema as the SQLAlchemy tables in api/db.py, which the API
-- also creates on startup if they are missing. tests/test_db.py checks that the
-- two agree. Every statement is idempotent, so running the file twice is safe.

CREATE TABLE IF NOT EXISTS runs (
    id          VARCHAR(32) PRIMARY KEY,
    name        TEXT        NOT NULL,
    mode        VARCHAR(16) NOT NULL,
    config      JSONB       NOT NULL,
    status      VARCHAR(16) NOT NULL,  -- created | running | stopped | interrupted | error
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT runs_mode_check CHECK (mode IN ('exact', 'robust'))
);

-- One row every few steps (metric_every), inserted in batches every 50 steps.
CREATE TABLE IF NOT EXISTS metric_points (
    run_id              VARCHAR(32)      NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    step                INTEGER          NOT NULL,
    mode                VARCHAR(16)      NOT NULL,
    error_rate          DOUBLE PRECISION NOT NULL,  -- rolling, against the true rule
    observed_error_rate DOUBLE PRECISION NOT NULL,  -- rolling, against the (noisy) labels
    mistakes_total      INTEGER          NOT NULL,
    labels_total        INTEGER          NOT NULL,
    candidates_left     INTEGER,                    -- NULL in robust mode
    false_alarms        INTEGER          NOT NULL,
    PRIMARY KEY (run_id, step)
);

-- A detected row is written when its recovery ends, so labels_to_recover and
-- bound are filled in; details.outcome says how it ended.
CREATE TABLE IF NOT EXISTS drift_events (
    id                BIGSERIAL   PRIMARY KEY,
    run_id            VARCHAR(32) NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    step              INTEGER     NOT NULL,
    source            VARCHAR(16) NOT NULL,
    drift_type        VARCHAR(32) NOT NULL,
    labels_to_recover INTEGER,
    bound             INTEGER,
    details           JSONB       NOT NULL,
    CONSTRAINT drift_events_source_check CHECK (source IN ('injected', 'detected'))
);
CREATE INDEX IF NOT EXISTS drift_events_run_step ON drift_events (run_id, step);

-- Exact mode stores {"theta": 412}; robust mode stores the S3 URI of a model snapshot.
CREATE TABLE IF NOT EXISTS concepts (
    id              BIGSERIAL   PRIMARY KEY,
    run_id          VARCHAR(32) NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    key             VARCHAR(64) NOT NULL,
    learned_at_step INTEGER     NOT NULL,
    rule            JSONB       NOT NULL,
    reuse_count     INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT concepts_run_key UNIQUE (run_id, key)
);
