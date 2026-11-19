"""CrowdSentinel camera worker: one process per camera.

Reads a video (or a simulated feed), counts people with YOLOv8n, tracks how they
move, and reports to the API about twice a second. It also touches a heartbeat file
that Kubernetes uses to decide whether this camera is healthy.
"""
from __future__ import annotations

import base64
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from tracker import CentroidTracker, CounterflowPersistence, flow_stats

ZONE = os.getenv("ZONE", "gate")
API_URL = os.getenv("API_URL", "http://localhost:8080").rstrip("/")
WORKER_KEY = os.getenv("WORKER_API_KEY", "")
VIDEO = os.getenv("VIDEO", f"videos/{ZONE}.mp4")
FPS = float(os.getenv("FPS", "2"))
CONF = float(os.getenv("CONF", "0.35"))
MODEL = os.getenv("MODEL_PATH", str(Path(__file__).with_name("models") / "yolov8n.onnx"))
VERSION = os.getenv("APP_VERSION", "v1")
BROKEN = os.getenv("BROKEN", "0").lower() in ("1", "true", "yes")
FORCE_SIM = os.getenv("SIM", "0").lower() in ("1", "true", "yes")
AUTOSURGE = float(os.getenv("SIM_AUTOSURGE", "0"))
FLOW_MIN_SPEED = float(os.getenv("FLOW_MIN_SPEED", "0.01"))
FLOW_MIN_MOVING = int(os.getenv("FLOW_MIN_MOVING", "4"))
FLOW_MIN_STREAM_FRACTION = float(os.getenv("FLOW_MIN_STREAM_FRACTION", "0.25"))
FLOW_CONE_DEGREES = float(os.getenv("FLOW_CONE_DEGREES", "35"))
POD = os.getenv("POD_NAME", socket.gethostname())
HEARTBEAT = Path(os.getenv("HEARTBEAT_FILE", "/tmp/heartbeat" if os.name != "nt" else "heartbeat.txt"))
SEND_W = int(os.getenv("FRAME_WIDTH", "480"))

COLORS = {"safe": (168, 214, 62), "warning": (28, 159, 255), "critical": (74, 56, 240), "offline": (190, 146, 140)}


def log(msg: str, *, severity: str = "INFO", event: str = "worker", **context) -> None:
    print(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), "severity": severity,
                      "event": event, "zone": ZONE, "pod": POD, "message": msg, **context}), flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_HTTP = urllib.request.build_opener(NoRedirect())


def http_json(method: str, path: str, body: dict | None = None, timeout: float = 2.0) -> dict:
    data = json.dumps(body, allow_nan=False).encode() if body is not None else None
    req = urllib.request.Request(API_URL + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    if path == "/api/report":
        req.add_unredirected_header("Authorization", f"Bearer {WORKER_KEY}")
    with _HTTP.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def zone_settings() -> tuple[float, float]:
    """Ask the API for this zone's camera area and the critical density."""
    for attempt in range(30):
        try:
            cfg = http_json("GET", "/api/config")
            z = next(z for z in cfg["zones"] if z["id"] == ZONE)
            return float(z["area_m2"]), float(cfg["thresholds"]["critical"])
        except StopIteration:
            log(f"Zone '{ZONE}' is not in the API's zones.json. Using defaults.")
            break
        except Exception as exc:
            if attempt % 5 == 0:
                log("Waiting for API configuration", severity="WARNING", event="config_request_failure",
                    error_type=type(exc).__name__)
            time.sleep(1)
    return 20.0, 4.0


def find_video() -> Path | None:
    p = Path(VIDEO)
    if p.is_file():
        return p
    folder = p.parent if p.suffix else p
    if folder.is_dir():
        for f in sorted(folder.iterdir()):
            if f.stem.lower().startswith(ZONE) and f.suffix.lower() in (".mp4", ".mov", ".avi", ".mkv", ".webm"):
                return f
    return None


class VideoCamera:
    """Plays a video file on a loop at real speed, sampling FPS frames per second."""

    def __init__(self, path: Path):
        self.path = path
        self.cap = cv2.VideoCapture(str(path))
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video {path}")
        native = self.cap.get(cv2.CAP_PROP_FPS) or 25.0
        self.step = max(1, int(round(native / FPS)))

    def read(self) -> np.ndarray:
        for _ in range(self.step - 1):
            if not self.cap.grab():
                break
        ok, frame = self.cap.read()
        if not ok:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self.cap.read()
            if not ok:
                raise RuntimeError("Video has no readable frames")
        h, w = frame.shape[:2]
        if w > 960:
            frame = cv2.resize(frame, (960, int(h * 960 / w)))
        return frame


def draw(frame: np.ndarray, tracks, status: str) -> np.ndarray:
    color = COLORS.get(status, COLORS["safe"])
    out = frame.copy()
    for t in tracks:
        x1, y1, x2, y2 = (int(v) for v in t.box)
        L = max(4, (x2 - x1) // 3)
        for (ax, ay, dx, dy) in ((x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)):
            cv2.line(out, (ax, ay), (ax + dx * L, ay), color, 2, cv2.LINE_AA)
            cv2.line(out, (ax, ay), (ax, ay + dy * L), color, 2, cv2.LINE_AA)
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        h, w = frame.shape[:2]
        tail = (int(cx - t.vx * w * 0.8), int(cy - t.vy * h * 0.8))
        cv2.line(out, tail, (cx, cy), color, 1, cv2.LINE_AA)
    scale = SEND_W / out.shape[1]
    return cv2.resize(out, (SEND_W, int(out.shape[0] * scale)), interpolation=cv2.INTER_AREA)


def beat() -> None:
    HEARTBEAT.write_text(str(time.time()))


def main() -> None:
    if not WORKER_KEY:
        log("WORKER_API_KEY is required", severity="ERROR", event="worker_configuration_failure")
        sys.exit(2)
    log(f"Starting camera worker {VERSION} on pod {POD}")
    if BROKEN:
        # Used to rehearse a bad release: the new version cannot load its model.
        log(f"Loading model artifact yolov8n-{VERSION}.onnx ...")
        time.sleep(1.5)
        log("ModelLoadError: checksum mismatch, the model file is corrupted. Exiting.")
        sys.exit(3)

    area, critical = zone_settings()
    video = None if FORCE_SIM else find_video()
    detector = None
    if video:
        from detector import PersonDetector
        cam = VideoCamera(video)
        detector = PersonDetector(MODEL, conf=CONF)
        log(f"Camera feed: {video.name}, model: {Path(MODEL).name}, area {area} m²")
    else:
        from sim import SimCamera
        cam = SimCamera(ZONE, area, critical, autosurge_every_s=AUTOSURGE)
        log(f"No video for '{ZONE}', using the simulated feed (area {area} m²)")

    tracker = CentroidTracker()
    counterflow = CounterflowPersistence(threshold_s=float(os.getenv("COUNTERFLOW_PERSISTENCE_S", "3")))
    status = "safe"
    interval = 1.0 / FPS
    last = time.time()
    failures = 0
    while True:
        started = time.time()
        dt = started - last
        last = started
        if detector:
            frame = cam.read()
            boxes = detector.detect(frame)
            infer_ms = detector.last_ms
        else:
            frame, boxes = cam.step(dt)
            infer_ms = 0.0
        h, w = frame.shape[:2]
        tracks = tracker.update(boxes, w, h, dt)
        flow = counterflow.update(flow_stats(tracks, min_speed=FLOW_MIN_SPEED, min_moving=FLOW_MIN_MOVING,
                                             min_stream_fraction=FLOW_MIN_STREAM_FRACTION,
                                             cone_degrees=FLOW_CONE_DEGREES), dt)
        jpg = cv2.imencode(".jpg", draw(frame, tracks, status), [cv2.IMWRITE_JPEG_QUALITY, 70])[1]
        payload = {
            "zone": ZONE, "count": len(tracks), "raw_detection_count": len(boxes),
            "pod": POD, "version": VERSION, "sim": detector is None,
            "fps": round(1 / max(dt, 1e-3), 2), "infer_ms": round(infer_ms, 1), "flow": flow,
            # Detections in letterbox padding can have a centre outside the image.
            "points": [[round(t.x, 3), round(t.y, 3), round(t.vx, 3), round(t.vy, 3)]
                       for t in tracks[:150] if 0 <= t.x <= 1 and 0 <= t.y <= 1],
            "frame": base64.b64encode(jpg.tobytes()).decode(),
        }
        try:
            resp = http_json("POST", "/api/report", payload)
            status = resp.get("status", status)
            if failures:
                log("API reporting restored", event="reporting_recovered", failures=failures)
            failures = 0
            if resp.get("kill"):
                log("Chaos test: received a kill signal. Crashing now so the platform can restart me.")
                os._exit(137)
            if resp.get("surge") and not detector:
                log("Surge drill started")
                cam.surge()
        except (OSError, ValueError) as exc:
            failures += 1
            if failures in (1, 10) or failures % 60 == 0:
                http_status = exc.code if isinstance(exc, urllib.error.HTTPError) else None
                log("Camera report failed. Processing continues with the next frame.",
                    severity="WARNING", event="reporting_failure",
                    error_type=type(exc).__name__, http_status=http_status, failures=failures)
        beat()
        time.sleep(max(0.0, interval - (time.time() - started)))


if __name__ == "__main__":
    main()
