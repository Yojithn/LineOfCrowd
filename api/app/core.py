"""Pure crowd-safety logic. No I/O here, so it is easy to unit test."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence


@dataclass(frozen=True)
class Thresholds:
    warning: float = 2.0   # people per square metre
    critical: float = 4.0  # people per square metre


def density(count: int, area_m2: float) -> float:
    """People per square metre in the camera's view."""
    if area_m2 <= 0:
        raise ValueError("area_m2 must be positive")
    return round(max(count, 0) / area_m2, 2)


def status_for(d: float, t: Thresholds) -> str:
    if d >= t.critical:
        return "critical"
    if d >= t.warning:
        return "warning"
    return "safe"


def load_ratio(d: float, t: Thresholds) -> float:
    """How full a zone is, where 1.0 means it has reached the critical density."""
    return round(max(d, 0.0) / t.critical, 3)


def slope_per_s(points: Sequence[tuple[float, float]]) -> float:
    """Least-squares slope of (time, density) points, in density units per second."""
    n = len(points)
    if n < 3:
        return 0.0
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / sxx


def forecast(history: Iterable[tuple[float, float]], now: float, t: Thresholds,
             window_s: float = 45.0) -> dict:
    """Estimate seconds until a zone reaches critical density, from its recent trend.

    history: (unix_time, density) pairs, any order.
    Returns {"trend": "rising"|"falling"|"steady", "per_min": float, "eta_s": float|None}.
    eta_s is 0 when the zone is already critical and None when it is not heading there.
    """
    recent = sorted((ts, d) for ts, d in history if now - ts <= window_s)
    if not recent:
        return {"trend": "steady", "per_min": 0.0, "eta_s": None}
    current = recent[-1][1]
    s = slope_per_s(recent)
    per_min = round(s * 60, 2)
    if abs(per_min) < 0.15:
        trend = "steady"
    else:
        trend = "rising" if per_min > 0 else "falling"
    if current >= t.critical:
        eta: Optional[float] = 0.0
    elif trend == "rising" and s > 0:
        eta = (t.critical - current) / s
        eta = round(eta, 1) if eta <= 30 * 60 else None  # ignore anything beyond 30 min
    else:
        eta = None
    return {"trend": trend, "per_min": per_min, "eta_s": eta}


def redirect_plan(zones: Sequence[dict], t: Thresholds) -> list[dict]:
    """For every critical zone, pick the least loaded online zone to send people to.

    zones: dicts with id, name, density, status, offline.
    """
    plans = []
    candidates = [z for z in zones if not z.get("offline") and z.get("status") != "critical"]
    for z in zones:
        if z.get("status") != "critical" or z.get("offline"):
            continue
        options = [c for c in candidates if c["id"] != z["id"]]
        if not options:
            continue
        target = min(options, key=lambda c: c.get("density", 0.0))
        plans.append({
            "from": z["id"],
            "from_name": z["name"],
            "to": target["id"],
            "to_name": target["name"],
            "to_load_pct": int(round(load_ratio(target.get("density", 0.0), t) * 100)),
        })
    return plans


def overall_status(zones: Sequence[dict]) -> str:
    states = {z.get("status") for z in zones if not z.get("offline")}
    if "critical" in states:
        return "critical"
    if "warning" in states:
        return "warning"
    if any(z.get("offline") for z in zones):
        return "degraded"
    return "safe"
