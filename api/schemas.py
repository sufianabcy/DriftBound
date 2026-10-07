"""Request bodies. FastAPI validates them and shows them on the /docs page."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Mode = Literal["exact", "robust"]
# "fraud" and "spam" runs belong to the two test pages; the dashboard never auto-joins them.
Kind = Literal["dashboard", "fraud", "spam"]


class CreateRun(BaseModel):
    name: str | None = Field(None, max_length=80)
    mode: Mode = "exact"
    n: int = Field(1023, ge=1, le=100_000, description="inputs are 1..n; there are n + 1 threshold rules")
    p: float = Field(1.0, ge=0, le=1, description="fraction of points labeled while monitoring")
    noise: float = Field(0.0, ge=0, lt=0.5, description="probability that a label is flipped")
    seed: int | None = Field(None, description="random when omitted")
    theta: int | None = Field(None, ge=1, description="starting rule; random when omitted")
    memory: bool = True
    speed: float | None = Field(None, gt=0, le=500, description="steps per second")
    start: bool = Field(False, description="start the stream right away")
    kind: Kind = Field("dashboard", description="which page the run belongs to")


class SettingsPatch(BaseModel):
    mode: Mode | None = None
    p: float | None = Field(None, ge=0, le=1)
    noise: float | None = Field(None, ge=0, lt=0.5)
    speed: float | None = Field(None, gt=0, le=500)
    memory: bool | None = None


class DriftRequest(BaseModel):
    type: Literal["abrupt", "gradual", "recurring", "out_of_family"] = "abrupt"
    theta: int | None = Field(None, ge=1, description="new rule; chosen at random when omitted")
    width: int | None = Field(None, ge=2, le=100_000, description="gradual window, in steps")


class AdversaryRequest(BaseModel):
    strategy: Literal["worst_case", "rapid_fire", "stealth", "noise"]
    enabled: bool = True
    k: int | None = Field(None, ge=1, le=10_000, description="rapid fire: change the rule every k steps")
    period: int | None = Field(None, ge=1, le=100_000, description="stealth: steps between one-step moves")
    gap: int | None = Field(
        None, ge=1, le=100_000, description="worst case: monitoring steps between attacks"
    )
    rate: float | None = Field(None, ge=0, lt=0.5, description="noise: flip probability")


class ScenarioRequest(BaseModel):
    name: Literal["monitoring_off", "noisy_labels", "out_of_family", "rapid_fire", "all_clear"]


class StepRequest(BaseModel):
    count: int = Field(1, ge=1, le=500, description="steps to run now, whether or not the stream is playing")
    x: int | None = Field(
        None, ge=1, description="process this input instead of a random one (count must be 1)"
    )
