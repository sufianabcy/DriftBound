"""Settings, read from the environment (and a local .env file in development)."""

from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Used when DATABASE_URL is empty, so a laptop runs with no database server.
LOCAL_DATABASE_URL = "sqlite+aiosqlite:///./driftbound.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = LOCAL_DATABASE_URL
    models_bucket: str = ""  # empty: model snapshots go to models_dir instead of S3
    models_dir: str = "models"
    aws_region: str = "ap-south-1"
    web_dist: str = "web/dist"
    # Runs kept in memory; unwatched, older ones are evicted first. Every visitor to a test page
    # holds one, so this is roughly how many people can test at once (an exact run is about 1 MB).
    max_live_runs: int = 24
    idle_stop_seconds: int = 600  # stop a running run nobody has watched for this long
    flush_every: int = 50  # steps between database writes
    max_speed: float = 500.0  # steps per second
    default_speed: float = 20.0

    @field_validator("database_url", mode="before")
    @classmethod
    def _local_when_empty(cls, value: str | None) -> str:
        return value or LOCAL_DATABASE_URL


@lru_cache
def get_settings() -> Settings:
    return Settings()
