"""CrowdSentinel API.

Collects camera reports, turns them into risk, keeps incidents and a 15-minute replay
history, streams live state to the control room, and serves the dashboard.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import socket
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from pydantic_core import PydanticCustomError
from redis.backoff import NoBackoff
from redis.retry import Retry
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import core, k8s, security
from .observability import ApiErrors, http_error, invalid_request, log, service_error
from .report_schema import CameraReportRoute, Report

BASE = Path(__file__).resolve().parent
STATIC = BASE.parent / "static"
CONFIG = json.loads((BASE / "zones.json").read_text(encoding="utf-8"))
DEFAULT_T = core.Thresholds(**CONFIG["thresholds"])
ZONES = {z["id"]: z for z in CONFIG["zones"]}
OFFLINE_AFTER = float(CONFIG.get("offline_after_s", 4))
SERIES_STEP_S = 2.0            # replay resolution
SERIES_LEN = int(15 * 60 / SERIES_STEP_S)   # 15 minutes of replay

APP_VERSION = os.getenv("APP_VERSION", "v1")
POD_NAME = os.getenv("POD_NAME", socket.gethostname())
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")
MODE = os.getenv("MODE") or ("k8s" if k8s.in_cluster() else ("compose" if os.getenv("REDIS_URL") else "local"))
PLATFORM = {"k8s": "Kubernetes", "compose": "Docker"}.get(MODE, "the operator")


def _redis():
    url = os.getenv("REDIS_URL")
    if url:
        import redis
        return redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2,
                                    retry=Retry(NoBackoff(), 0))
    import fakeredis  # local mode: an in-process Redis, no server needed
    return fakeredis.FakeRedis()


R = _redis()


@asynccontextmanager
async def lifespan(app: FastAPI):
    security.check_configuration()
    stopped = threading.Event()
    watcher = threading.Thread(target=_watch, args=(stopped,), name="camera-watcher", daemon=True)
    watcher.start()
    try:
        yield
    finally:
        stopped.set()
        await run_in_threadpool(watcher.join, 3)


app = FastAPI(title="CrowdSentinel", version=APP_VERSION, lifespan=lifespan)
app.add_middleware(ApiErrors)
app.add_exception_handler(RequestValidationError, invalid_request)
app.add_exception_handler(StarletteHTTPException, http_error)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------- settings (thresholds can be tuned live from the dashboard) ----------

_t_cache = {"ts": 0.0, "t": DEFAULT_T}


def thresholds() -> core.Thresholds:
    now = time.time()
    if now - _t_cache["ts"] > 1.0:
        raw = R.get("settings")
        if raw:
            s = json.loads(raw)
            _t_cache["t"] = core.Thresholds(warning=s["warning"], critical=s["critical"])
        else:
            _t_cache["t"] = DEFAULT_T
        _t_cache["ts"] = now
    return _t_cache["t"]


# ---------- helpers ----------

def add_event(kind: str, text: str, zone: Optional[str] = None) -> None:
    pipe = R.pipeline()
    _queue_event(pipe, kind, text, zone)
    pipe.execute()


def _queue_event(pipe, kind: str, text: str, zone: Optional[str] = None) -> None:
    ev = {"ts": time.time(), "kind": kind, "text": text, "zone": zone}
    pipe.lpush("events", json.dumps(ev))
    pipe.ltrim("events", 0, 199)


def _zone_or_404(zone: str) -> dict:
    z = ZONES.get(zone)
    if not z:
        raise HTTPException(404, f"Unknown zone. Known zones: {', '.join(ZONES)}")
    return z


def _history(zone: str) -> list[tuple[float, float]]:
    out = []
    for raw in R.lrange(f"hist:{zone}", 0, 179):
        ts, d = raw.decode().split(":")
        out.append((float(ts), float(d)))
    return out


def _append_series(zone: str, now: float, d: Optional[float], count: int, status: str) -> None:
    """Keep one point every 2 s for 15 minutes, for the replay scrubber."""
    if not R.set(f"series_tick:{zone}", 1, nx=True, px=int(SERIES_STEP_S * 1000) - 50):
        return
    pipe = R.pipeline()
    pipe.lpush(f"series:{zone}", json.dumps([round(now, 1), d, count, status]))
    pipe.ltrim(f"series:{zone}", 0, SERIES_LEN - 1)
    pipe.execute()


def _zone_view(z: dict, now: float, t: core.Thresholds) -> dict:
    raw = R.get(f"zone:{z['id']}")
    rec = json.loads(raw) if raw else None
    offline = rec is None or now - rec["ts"] > OFFLINE_AFTER
    hist = _history(z["id"])
    return {
        "id": z["id"],
        "name": z["name"],
        "area_m2": z["area_m2"],
        "tip": z["tip"],
        "offline": offline,
        "last_seen": rec["ts"] if rec else None,
        "count": rec["count"] if rec else 0,
        "density": rec["density"] if rec else 0.0,
        "status": "offline" if offline else rec["status"],
        "version": rec.get("version") if rec else None,
        "pod": rec.get("pod") if rec else None,
        "sim": rec.get("sim", False) if rec else False,
        "fps": rec.get("fps", 0) if rec else 0,
        "infer_ms": rec.get("infer_ms", 0) if rec else 0,
        "flow": rec.get("flow", {}) if rec else {},
        "points": rec.get("points", []) if (rec and not offline) else [],
        "load_pct": int(round(core.load_ratio(rec["density"], t) * 100)) if rec else 0,
        "trend": [d for _, d in sorted(hist)[-60:]],
        "forecast": core.forecast(hist, now, t) if not offline else {"trend": "steady", "per_min": 0, "eta_s": None},
    }


def _pods() -> list[dict]:
    if MODE == "k8s":
        try:
            return k8s.list_pods()
        except Exception as exc:
            service_error(exc, "pod_inventory_failure")
            return [{"name": "Pod inventory unavailable", "role": "other", "state": "crashing"}]
    pods = []
    for key in R.scan_iter("hb:*"):
        raw = R.get(key)
        if raw:
            pods.append(json.loads(raw))
    R.ping()
    pods.append({"name": "redis", "role": "redis", "zone": None, "state": "ready"})
    pods.sort(key=lambda p: (p["role"], p.get("zone") or "", p["name"]))
    return pods


# ---------- incidents ----------

def _incident(iid: str) -> Optional[dict]:
    raw = R.hget("incidents", iid)
    return json.loads(raw) if raw else None


def _save_incident(inc: dict) -> None:
    R.hset("incidents", inc["id"], json.dumps(inc))


def _incidents(limit: int = 12) -> list[dict]:
    items = [json.loads(v) for v in R.hvals("incidents")]
    items.sort(key=lambda i: (i["state"] == "resolved", -i["opened_at"]))
    return items[:limit]


def _on_status_change(z: dict, prev: Optional[str], st: str, d: float, count: int) -> None:
    open_id = R.get(f"incident_open:{z['id']}")
    open_id = open_id.decode() if open_id else None
    now = time.time()
    if st == "critical":
        if open_id and (inc := _incident(open_id)):
            inc["eased"] = False
            inc["timeline"].append({"t": now, "text": f"Back at crush risk ({d} per m²)", "by": "system"})
            _save_incident(inc)
        else:
            seq = R.incr("incident_seq")
            inc = {"id": f"INC-{seq:03d}", "zone": z["id"], "zone_name": z["name"], "opened_at": now,
                   "peak_density": d, "peak_count": count, "state": "open", "eased": False,
                   "resolved_at": None,
                   "timeline": [{"t": now, "text": f"Crush risk detected: {d} people per m²", "by": "system"}]}
            _save_incident(inc)
            R.set(f"incident_open:{z['id']}", inc["id"])
            add_event("incident", f"{inc['id']} opened: crush risk at {z['name']}.", z["id"])
    elif prev == "critical" and open_id and (inc := _incident(open_id)):
        inc["eased"] = True
        inc["timeline"].append({"t": now, "text": f"Eased to {d} per m²", "by": "system"})
        _save_incident(inc)


def _track_peak(z: dict, d: float, count: int) -> None:
    open_id = R.get(f"incident_open:{z['id']}")
    if not open_id:
        return
    inc = _incident(open_id.decode())
    if inc and d > inc["peak_density"]:
        inc["peak_density"], inc["peak_count"] = d, count
        _save_incident(inc)


# ---------- background watcher: offline cameras and replay gaps ----------

def _watch_once() -> None:
    now = time.time()
    R.set(f"hb:{POD_NAME}", json.dumps({"name": POD_NAME, "role": "api", "zone": None,
                                       "state": "ready", "version": APP_VERSION}), ex=6)
    for z in CONFIG["zones"]:
        zone = z["id"]
        raw = R.get(f"zone:{zone}")
        if raw is None:
            continue
        try:
            rec = json.loads(raw)
            online = "1" if now - rec["ts"] <= OFFLINE_AFTER else "0"
        except (KeyError, TypeError, ValueError) as exc:
            service_error(exc, "watcher_invalid_state", zone=zone)
            continue
        if online == "0":
            _append_series(zone, now, None, 0, "offline")
        prev = R.set(f"online:{zone}", online, get=True)
        if prev == b"1" and online == "0":
            log("warning", "camera_offline", zone=zone)
            R.set(f"offline_since:{zone}", now)
            add_event("offline", f"{z['name']} camera stopped reporting. {PLATFORM} is restarting it.", zone)
        elif prev == b"0" and online == "1":
            log("info", "camera_online", zone=zone)
            since = R.get(f"offline_since:{zone}")
            took = f" after {now - float(since):.1f} s" if since else ""
            add_event("online", f"{z['name']} camera is back{took} on pod {rec.get('pod', '?')}.", zone)


def _watch(stopped: threading.Event) -> None:
    last_failure = float("-inf")
    while not stopped.is_set():
        try:
            _watch_once()
        except Exception as exc:
            now = time.monotonic()
            if now - last_failure >= 30:
                service_error(exc, "watcher_failure")
                last_failure = now
        else:
            if last_failure != float("-inf"):
                log("info", "watcher_recovered")
                last_failure = float("-inf")
        stopped.wait(1)


# ---------- other request models ----------

class PipelineUpdate(BaseModel):
    run: str
    version: str
    stage: str
    state: str          # running | ok | fail | skipped
    note: str = ""
    previous: Optional[str] = None


class Settings(BaseModel):
    warning: float = Field(ge=0.5, le=9)
    critical: float = Field(ge=1, le=10)

    @model_validator(mode="after")
    def ordered(self):
        if self.warning >= self.critical:
            raise PydanticCustomError("threshold_order", "The crowded level must be lower than the crush-risk level.")
        return self


class IncidentAction(BaseModel):
    by: str = Field("control room", max_length=40)


# ---------- pages and health ----------

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/m", include_in_schema=False)
def mobile():
    return FileResponse(STATIC / "m.html")


@app.get("/healthz")
def healthz():
    return {"ok": True, "pod": POD_NAME, "version": APP_VERSION}


@app.get("/readyz")
def readyz():
    R.ping()
    return {"ok": True}


app.add_api_route("/api/operator", security.operator_sign_in, methods=["GET"])


@app.get("/api/config")
def config(request: Request):
    t = thresholds()
    return {
        "venue": CONFIG["venue"],
        "thresholds": {"warning": t.warning, "critical": t.critical},
        "default_thresholds": CONFIG["thresholds"],
        "zones": CONFIG["zones"],
        "mode": MODE,
        "public_url": PUBLIC_URL or str(request.base_url).rstrip("/"),
        "api_version": APP_VERSION,
        "replay_minutes": SERIES_LEN * SERIES_STEP_S / 60,
    }


# ---------- camera reports ----------

def _validate_worker_identity(r: Report) -> None:
    if MODE == "compose" and r.pod != f"worker-{r.zone}":
        raise HTTPException(422, "Worker identity does not match the reported zone.")
    if MODE == "k8s":
        try:
            pods = k8s.list_pods()
        except Exception as exc:
            log("error", "pod_inventory_failure", zone=r.zone, status=503, error_type=type(exc).__name__)
            raise HTTPException(503, "Worker identity verification temporarily unavailable.") from None
        if not any(p["name"] == r.pod and p["role"] == "worker" and p["zone"] == r.zone for p in pods):
            raise HTTPException(422, "Worker identity does not match the reported zone.")


camera_routes = APIRouter(route_class=CameraReportRoute)


@camera_routes.post("/api/report")
def report(r: Report, request: Request):
    z = _zone_or_404(r.zone)
    request.state.zone = r.zone
    _validate_worker_identity(r)
    try:
        jpeg = r.jpeg()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    t = thresholds()
    now = time.time()
    d = core.density(r.count, z["area_m2"])
    st = core.status_for(d, t)
    rec = {
        "ts": now, "count": r.count, "density": d, "status": st, "pod": r.pod,
        "version": r.version, "sim": r.sim, "fps": r.fps, "infer_ms": r.infer_ms,
        "flow": r.flow.model_dump(), "points": r.points,
    }
    pipe = R.pipeline()
    pipe.set(f"status:{z['id']}", st, get=True)
    pipe.set(f"zone:{z['id']}", json.dumps(rec))
    pipe.lpush(f"hist:{z['id']}", f"{now:.2f}:{d}")
    pipe.ltrim(f"hist:{z['id']}", 0, 179)
    pipe.set(f"hb:worker:{r.pod}", json.dumps({"name": r.pod, "role": "worker", "zone": z["id"],
                                              "state": "ready", "version": r.version}), ex=6)
    if jpeg is not None:
        pipe.set(f"frame:{z['id']}", jpeg, ex=10)
    chaos_enabled = security.chaos_enabled()
    if chaos_enabled:
        pipe.getdel(f"kill:{z['id']}")
        pipe.getdel(f"surge:{z['id']}")
    results = pipe.execute()
    prev = results[0].decode() if results[0] else None
    kill, surge = map(bool, results[-2:]) if chaos_enabled else (False, False)
    _append_series(z["id"], now, d, r.count, st)

    if prev and prev != st:
        if st == "critical":
            add_event("critical", f"{z['name']} reached {d} people per m². Crush risk.", z["id"])
        elif st == "warning" and prev == "safe":
            add_event("warning", f"{z['name']} is getting crowded ({d} people per m²).", z["id"])
        elif st == "safe" or (st == "warning" and prev == "critical"):
            add_event("recovered", f"{z['name']} eased to {d} people per m².", z["id"])
        _on_status_change(z, prev, st, d, r.count)
    if st == "critical":
        _track_peak(z, d, r.count)
    if r.flow.counterflow >= 0.65 and r.flow.moving >= 6 and d >= t.warning:
        if R.set(f"cf:{z['id']}", 1, nx=True, ex=30):
            add_event("warning", f"Counter-flow at {z['name']}: groups are pushing in opposite directions.", z["id"])

    return {"ok": True, "density": d, "status": st, "kill": kill, "surge": surge}


app.include_router(camera_routes)


# ---------- live state ----------

def build_state() -> dict:
    now = time.time()
    t = thresholds()
    zones = [_zone_view(z, now, t) for z in CONFIG["zones"]]
    pipeline_raw = R.get("pipeline")
    return {
        "now": now,
        "mode": MODE,
        "served_by": POD_NAME,
        "overall": core.overall_status(zones),
        "thresholds": {"warning": t.warning, "critical": t.critical},
        "zones": zones,
        "plans": core.redirect_plan(zones, t),
        "totals": {
            "people": sum(z["count"] for z in zones if not z["offline"]),
            "cameras_online": sum(1 for z in zones if not z["offline"]),
            "cameras": len(zones),
        },
        "pods": _pods(),
        "pipeline": json.loads(pipeline_raw) if pipeline_raw else None,
        "events": [json.loads(e) for e in R.lrange("events", 0, 29)],
        "incidents": _incidents(),
    }


@app.get("/api/state")
def state():
    return build_state()


@app.get("/api/stream")
async def stream(request: Request):
    """Server-sent events: the dashboard gets a fresh state every 0.7 s over one connection.
    If this API pod dies, the browser reconnects to the other one automatically."""
    async def gen():
        yield "retry: 1000\n\n"
        last_failure = float("-inf")
        while True:
            if await request.is_disconnected():
                break
            try:
                payload = await run_in_threadpool(build_state)
                yield f"event: state\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"
                last_failure = float("-inf")
            except Exception as exc:
                now = time.monotonic()
                if now - last_failure >= 30:
                    service_error(exc, "stream_failure")
                    last_failure = now
                yield 'event: problem\ndata: {"message":"Live state temporarily unavailable."}\n\n'
            await asyncio.sleep(0.7)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/history")
def history():
    """Last 15 minutes, one point every 2 s per zone, plus events: feeds the replay scrubber."""
    zones = {}
    for z in CONFIG["zones"]:
        pts = [json.loads(p) for p in R.lrange(f"series:{z['id']}", 0, SERIES_LEN - 1)]
        pts.reverse()
        zones[z["id"]] = pts
    return {"now": time.time(), "step_s": SERIES_STEP_S, "zones": zones,
            "events": [json.loads(e) for e in R.lrange("events", 0, 199)]}


@app.get("/api/frame/{zone}.jpg")
def frame(zone: str):
    _zone_or_404(zone)
    data = R.get(f"frame:{zone}")
    if not data:
        raise HTTPException(404, "No recent frame for this camera.")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ---------- settings ----------

@app.get("/api/settings")
def get_settings():
    t = thresholds()
    return {"warning": t.warning, "critical": t.critical}


@app.put("/api/settings", dependencies=[Depends(security.require_operator)])
def put_settings(s: Settings):
    pipe = R.pipeline()
    pipe.set("settings", json.dumps(s.model_dump()))
    _queue_event(pipe, "info", f"Danger levels changed: crowded from {s.warning}, crush risk from {s.critical} per m².")
    pipe.execute()
    _t_cache["ts"] = 0
    return s.model_dump()


@app.delete("/api/settings", dependencies=[Depends(security.require_operator)])
def reset_settings():
    pipe = R.pipeline()
    pipe.delete("settings")
    _queue_event(pipe, "info", "Danger levels reset to the defaults.")
    pipe.execute()
    _t_cache["ts"] = 0
    return CONFIG["thresholds"]


# ---------- incidents ----------

@app.get("/api/incidents")
def incidents():
    return _incidents(50)


@app.post("/api/incidents/{iid}/{action}", dependencies=[Depends(security.require_operator)])
def incident_action(iid: str, action: Literal["ack", "respond", "resolve"], body: IncidentAction = IncidentAction()):
    inc = _incident(iid)
    if not inc:
        raise HTTPException(404, "Incident not found.")
    if inc["state"] == "resolved":
        raise HTTPException(409, f"{iid} is already resolved.")
    now = time.time()
    pipe = R.pipeline()
    if action == "ack":
        inc["state"] = "acknowledged"
        text = f"Acknowledged by {body.by}"
    elif action == "respond":
        inc["state"] = "responding"
        text = f"{body.by[:1].upper() + body.by[1:]} is responding on the ground"
    else:
        inc["state"] = "resolved"
        inc["resolved_at"] = now
        pipe.delete(f"incident_open:{inc['zone']}")
        text = f"Resolved by {body.by}"
    inc["timeline"].append({"t": now, "text": text, "by": body.by})
    pipe.hset("incidents", iid, json.dumps(inc))
    _queue_event(pipe, "incident", f"{iid}: {text[:1].lower() + text[1:]}.", inc["zone"])
    pipe.execute()
    return inc


# ---------- chaos ----------

def _cooldown(key: str, seconds: int = 8) -> Optional[JSONResponse]:
    if R.set(f"chaos_cooldown:{key}", 1, nx=True, ex=seconds):
        return None
    ttl = max(int(R.ttl(f"chaos_cooldown:{key}")), 1)
    return JSONResponse({"ok": False, "message": f"Still recovering. Try again in {ttl} s.", "retry_after": ttl},
                        status_code=429)


@app.post("/api/chaos/kill/{zone}", dependencies=[Depends(security.require_chaos)])
def chaos_kill(zone: str, by: str = Query("dashboard", max_length=20)):
    z = _zone_or_404(zone)
    if busy := _cooldown(zone):
        return busy
    if MODE == "k8s":
        try:
            pod = k8s.delete_worker_pod(zone)
        except Exception as exc:
            log("error", "pod_delete_failure", zone=zone, status=503, error_type=type(exc).__name__)
            raise HTTPException(503, "Camera restart could not be confirmed.") from None
        if not pod:
            R.delete(f"chaos_cooldown:{zone}")
            raise HTTPException(409, "No running camera pod for this zone right now.")
        how = f"deleted pod {pod}"
    else:
        R.set(f"kill:{zone}", 1, ex=10)
        pod = None
        how = "killed the camera process"
    source = "a visitor's phone" if by == "phone" else "the control room"
    add_event("chaos", f"Chaos test from {source}: {how} for {z['name']}.", zone)
    return {"ok": True, "zone": zone, "pod": pod, "message": f"Crashed the {z['name']} camera."}


@app.post("/api/chaos/pod/{name}", dependencies=[Depends(security.require_chaos)])
def chaos_pod(name: str):
    """Delete one specific pod, chosen in the cluster inspector."""
    if busy := _cooldown(name, 6):
        return busy
    if MODE == "k8s":
        try:
            role = k8s.delete_pod(name)
        except PermissionError:
            R.delete(f"chaos_cooldown:{name}")
            raise HTTPException(403, "Only camera and API pods can be deleted from the dashboard.") from None
        except Exception as exc:
            log("error", "pod_delete_failure", status=503, error_type=type(exc).__name__)
            raise HTTPException(503, "Pod restart could not be confirmed.") from None
        what = "an API pod (the other one keeps serving)" if role == "api" else f"camera pod {name}"
        add_event("chaos", f"Chaos test from the control room: deleted {what}.")
        return {"ok": True, "pod": name, "role": role}
    raw = R.get(f"hb:worker:{name}") or R.get(f"hb:{name}")
    info = json.loads(raw) if raw else None
    if not info or info.get("role") != "worker":
        R.delete(f"chaos_cooldown:{name}")
        raise HTTPException(409, f"In {MODE} mode only camera pods can be crashed from here.")
    R.set(f"kill:{info['zone']}", 1, ex=10)
    add_event("chaos", f"Chaos test from the control room: killed {name}.", info["zone"])
    return {"ok": True, "pod": name, "role": "worker"}


@app.post("/api/chaos/surge/{zone}", dependencies=[Depends(security.require_chaos)])
def chaos_surge(zone: str):
    z = _zone_or_404(zone)
    R.set(f"surge:{zone}", 1, ex=10)
    add_event("info", f"Surge drill started at {z['name']} (simulated cameras only).", zone)
    return {"ok": True}


# ---------- pipeline ----------

@app.post("/api/pipeline")
def pipeline(u: PipelineUpdate, x_pipeline_token: str = Header("")):
    if not security.matches(x_pipeline_token, security.PIPELINE_TOKEN):
        raise HTTPException(401, "Pipeline authentication required.")
    raw = R.get("pipeline")
    cur = json.loads(raw) if raw else None
    if not cur or cur.get("run") != u.run:
        cur = {"run": u.run, "version": u.version, "previous": u.previous, "started": time.time(),
               "stages": {}, "result": None}
        add_event("deploy", f"Release {u.version} started.")
    cur["stages"][u.stage] = {"state": u.state, "note": u.note, "ts": time.time()}
    cur["updated"] = time.time()
    if u.stage == "live" and u.state == "ok":
        cur["result"] = "live"
        add_event("deploy", f"{u.version} is live on every camera with zero downtime.")
    if u.stage == "rollback" and u.state == "ok":
        cur["result"] = "rolled_back"
        add_event("rollback", f"{u.version} failed health checks. Rolled back to {u.previous or 'the last good version'}.")
    R.set("pipeline", json.dumps(cur))
    return {"ok": True}


@app.get("/api/qr.svg")
def qr(data: str = Query(..., max_length=300), dark: str = Query("#f3eadb", pattern=r"^#[0-9a-fA-F]{6}$")):
    import segno
    buf = io.BytesIO()
    segno.make(data, error="m").save(buf, kind="svg", scale=5, border=1, dark=dark, light=None)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")
