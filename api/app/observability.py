"""Safe error responses and structured application events."""
import json
import logging
from datetime import datetime, timezone

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from redis import exceptions as redis
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger("lineofcrowd.api")
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    logger.addHandler(logging.StreamHandler())


def log(level: str, event: str, **context) -> None:
    entry = {"timestamp": datetime.now(timezone.utc).isoformat(), "severity": level.upper(), "event": event,
             **context}
    logger.log(getattr(logging, level.upper()), json.dumps(entry, separators=(",", ":")))


def _request_context(scope: Scope) -> dict:
    context = {"method": scope["method"], "route": getattr(scope.get("route"), "path", None)}
    zone = scope.get("state", {}).get("zone")
    if zone is not None:
        context["zone"] = zone
    return context


def service_error(exc: Exception, event: str, **context) -> tuple[int, str]:
    unavailable = isinstance(exc, (redis.ConnectionError, redis.TimeoutError, redis.BusyLoadingError))
    status = 503 if unavailable else 500
    log("error", event, error_type=type(exc).__name__, status=status, **context)
    return status, "Service temporarily unavailable." if unavailable else "Internal server error."


def _error(status: int, detail, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status, headers=headers)


async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
    if 400 <= exc.status_code < 500:
        log("warning", "request_rejected", status=exc.status_code, **_request_context(request.scope))
    return _error(exc.status_code, exc.detail, exc.headers)


_VALIDATION_MESSAGES = {
    "missing": "Field is required.",
    "extra_forbidden": "Unexpected field.",
    "int_type": "Expected an integer.",
    "float_type": "Expected a number.",
    "finite_number": "Expected a finite number.",
    "greater_than_equal": "Value is below the allowed minimum.",
    "less_than_equal": "Value exceeds the allowed maximum.",
    "string_pattern_mismatch": "Invalid field format.",
    "string_too_short": "Text is shorter than the allowed length.",
    "string_too_long": "Text exceeds the allowed length.",
    "too_short": "Too few entries.",
    "too_long": "Too many entries.",
    "report_coordinate_range": "Coordinates must be between 0 and 1.",
    "report_velocity_range": "Velocity exceeds the supported range.",
    "threshold_order": "The crowded level must be lower than the crush-risk level.",
    "json_invalid": "Malformed JSON.",
}


async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    malformed = any(error["type"] == "json_invalid" for error in exc.errors())
    status = 400 if malformed else 422
    issues = []
    for error in exc.errors():
        kind = error["type"]
        # Extra fields may themselves contain sensitive input. Never echo their names or values.
        location = error["loc"][:-1] if kind == "extra_forbidden" else error["loc"]
        issues.append({"loc": location, "msg": _VALIDATION_MESSAGES.get(kind, "Invalid value."),
                       "type": kind})
    log("warning", "invalid_request", status=status, issues=len(issues), **_request_context(request.scope))
    return _error(status, issues[:20])


class ApiErrors:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def track_response(message):
            nonlocal started
            started |= message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, receive, track_response)
        except ClientDisconnect:
            return
        except Exception as exc:
            event = "redis_failure" if isinstance(exc, redis.RedisError) else "request_failure"
            status, detail = service_error(exc, event, **_request_context(scope))
            if not started:
                await _error(status, detail)(scope, receive, send)
            else:
                raise

