"""Limits and models for reports emitted by camera workers."""
import base64
import json
import os
from typing import Annotated

from fastapi import HTTPException, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError

from .security import require_worker


def _positive_limit(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer.")
    return value


MAX_PERSON_COUNT = _positive_limit("MAX_PERSON_COUNT", 10000)
MAX_FRAME_BYTES = _positive_limit("MAX_FRAME_BYTES", 512 * 1024)
MAX_ENCODED_FRAME = 4 * ((MAX_FRAME_BYTES + 2) // 3)
MAX_REPORT_BYTES = MAX_ENCODED_FRAME + 32 * 1024  # metadata and up to 150 motion points

Fraction = Annotated[float, Field(ge=0, le=1)]
NonNegative = Annotated[float, Field(ge=0)]
# The tracker floors elapsed time at 1 ms. A normalized coordinate can move
# by at most one frame dimension per sample.
MAX_VELOCITY = 1000
Point = Annotated[list[float], Field(min_length=4, max_length=4)]


class Flow(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False, extra="forbid")

    coherence: Fraction = 1.0
    counterflow: Fraction = 0.0
    speed: float = Field(0.0, ge=0, le=1414.214)
    angle: float = Field(0.0, ge=-180, le=180)
    moving: int = Field(0, ge=0, le=MAX_PERSON_COUNT)
    state: str = Field("insufficient", pattern="^(one_way|multidirectional|counterflow|insufficient)$")
    counterflow_confirmed: bool = False
    forward_fraction: Fraction = 0.0
    reverse_fraction: Fraction = 0.0
    opposing_s: NonNegative = 0.0


class Report(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False, extra="forbid")

    zone: str = Field(min_length=1, max_length=63)
    count: int = Field(ge=0, le=MAX_PERSON_COUNT)
    raw_detection_count: int | None = Field(None, ge=0, le=MAX_PERSON_COUNT)
    pod: str = Field(max_length=253, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9.-]*$")
    version: str = Field(max_length=128, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._+-]*$")
    sim: bool = False
    fps: NonNegative = 0.0
    infer_ms: NonNegative = 0.0
    flow: Flow = Field(default_factory=Flow)
    points: list[Point] = Field(default_factory=list, max_length=150)
    frame: str | None = Field(None, min_length=4, max_length=MAX_ENCODED_FRAME)

    @field_validator("points")
    @classmethod
    def motion_range(cls, points: list[list[float]]) -> list[list[float]]:
        for x, y, vx, vy in points:
            if not 0 <= x <= 1 or not 0 <= y <= 1:
                raise PydanticCustomError("report_coordinate_range", "Coordinates must be between 0 and 1.")
            if not -MAX_VELOCITY <= vx <= MAX_VELOCITY or not -MAX_VELOCITY <= vy <= MAX_VELOCITY:
                raise PydanticCustomError("report_velocity_range", "Velocity exceeds the supported range.")
        return points

    def jpeg(self) -> bytes | None:
        if self.frame is None:
            return None
        # Reject by decoded size before allocating the decoded buffer.
        padded = len(self.frame) - len(self.frame.rstrip("="))
        if len(self.frame) % 4 or padded > 2:
            raise ValueError("Frame must be valid base64.")
        if len(self.frame) // 4 * 3 - padded > MAX_FRAME_BYTES:
            raise ValueError("Frame exceeds the configured size limit.")
        try:
            data = base64.b64decode(self.frame, validate=True)
        except ValueError:
            raise ValueError("Frame must be valid base64.") from None
        if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
            raise ValueError("Frame must contain a JPEG.")
        return data


def _reject_constant(_: str) -> None:
    raise HTTPException(422, [{"loc": ["body"], "msg": "Expected a finite number.", "type": "finite_number"}])


class _BoundedReportRequest(Request):
    _bounded_body: bytes | None = None

    async def body(self) -> bytes:
        if self._bounded_body is None:
            length = self.headers.get("content-length")
            if length is not None:
                if not length.isascii() or not length.isdigit():
                    raise HTTPException(400, "Invalid Content-Length.")
                if len(length) > 20 or int(length) > MAX_REPORT_BYTES:
                    raise HTTPException(413, "Camera report exceeds the size limit.")
            body = bytearray()
            async for chunk in self.stream():
                if len(body) + len(chunk) > MAX_REPORT_BYTES:
                    raise HTTPException(413, "Camera report exceeds the size limit.")
                body.extend(chunk)
            self._bounded_body = bytes(body)
        return self._bounded_body

    async def json(self):
        return json.loads((await self.body()).decode("utf-8"), parse_constant=_reject_constant)


class CameraReportRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            require_worker(request)
            content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                raise HTTPException(415, "Camera reports require application/json.")
            return await handler(_BoundedReportRequest(request.scope, request.receive))

        return handle
