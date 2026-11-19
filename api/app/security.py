"""Credentials and browser sessions for the API's write routes."""
import base64
import hashlib
import hmac
import os
import time

from fastapi import HTTPException, Request, Response

APP_ENV = os.getenv("APP_ENV", "production")
DEVELOPMENT = APP_ENV == "development"
ENABLE_CHAOS = os.getenv("ENABLE_CHAOS") == "1"
WORKER_KEY = os.getenv("WORKER_API_KEY", "")
OPERATOR_KEY = os.getenv("OPERATOR_API_KEY", "")
PIPELINE_TOKEN = os.getenv("PIPELINE_TOKEN", "")
COOKIE = "cs_operator"
SESSION_SECONDS = 8 * 60 * 60


def check_configuration() -> None:
    keys = (WORKER_KEY, OPERATOR_KEY)
    if not DEVELOPMENT and not all(keys):
        raise RuntimeError("WORKER_API_KEY and OPERATOR_API_KEY are required.")
    configured = [key for key in (*keys, PIPELINE_TOKEN) if key]
    if any(any(not 33 <= ord(ch) <= 126 for ch in key) for key in configured):
        raise RuntimeError("API credentials must use printable ASCII without whitespace.")
    if len(set(configured)) != len(configured):
        raise RuntimeError("Worker, operator and pipeline credentials must be distinct.")


def matches(actual: str, expected: str) -> bool:
    return bool(expected) and hmac.compare_digest(actual.encode(), expected.encode())


def credentials(request: Request, scheme: str) -> str:
    actual, _, value = request.headers.get("authorization", "").partition(" ")
    return value if actual.lower() == scheme.lower() else ""


def require_worker(request: Request) -> None:
    if not matches(credentials(request, "Bearer"), WORKER_KEY):
        raise HTTPException(401, "Worker authentication required.", {"WWW-Authenticate": "Bearer"})


def _operator_challenge() -> HTTPException:
    return HTTPException(401, "Operator authentication required. Sign in at /api/operator.",
                         {"WWW-Authenticate": 'Basic realm="CrowdSentinel operator"', "Cache-Control": "no-store"})


def _session_signature(expires: str) -> str:
    return hmac.new(OPERATOR_KEY.encode(), f"operator-session:{expires}".encode(), hashlib.sha256).hexdigest()


def _valid_session(request: Request) -> bool:
    expires, _, signature = request.cookies.get(COOKIE, "").partition(".")
    return (bool(OPERATOR_KEY) and len(expires) == 10 and expires.isascii() and expires.isdigit()
            and int(expires) > time.time() and matches(signature, _session_signature(expires)))


def operator_sign_in(request: Request, response: Response) -> dict:
    try:
        raw = base64.b64decode(credentials(request, "Basic"), validate=True).decode("ascii")
    except ValueError:
        raise _operator_challenge() from None
    user, _, password = raw.partition(":")
    if user != "operator" or not matches(password, OPERATOR_KEY):
        raise _operator_challenge()
    expires = str(int(time.time()) + SESSION_SECONDS)
    response.set_cookie(COOKIE, f"{expires}.{_session_signature(expires)}", max_age=SESSION_SECONDS,
                        path="/api", httponly=True, secure=not DEVELOPMENT or request.url.scheme == "https",
                        samesite="strict")
    response.headers["Cache-Control"] = "no-store"
    return {"message": "Signed in. Return to the control room or phone page to use operator actions."}


def require_operator(request: Request) -> None:
    if request.headers.get("authorization", "").partition(" ")[0].lower() == "bearer":
        if matches(credentials(request, "Bearer"), OPERATOR_KEY):
            return
        raise HTTPException(401, "Operator authentication required. Sign in at /api/operator.",
                            {"WWW-Authenticate": "Bearer"})
    origin = request.headers.get("origin")
    expected_origin = f"{request.url.scheme}://{request.url.netloc}"
    if (request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}
            or origin is not None and origin != expected_origin):
        raise HTTPException(403, "Browser operator requests must come from this origin.")
    if not _valid_session(request):
        raise HTTPException(401, "Operator authentication required. Sign in at /api/operator.",
                            {"WWW-Authenticate": "Bearer"})


def require_chaos(request: Request) -> None:
    if not chaos_enabled():
        raise HTTPException(404, "Chaos testing is disabled.")
    require_operator(request)


def chaos_enabled() -> bool:
    return DEVELOPMENT and ENABLE_CHAOS
