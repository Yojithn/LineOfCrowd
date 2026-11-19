"""Lightweight motion-predictive person tracker and crowd-flow classifier."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import count


@dataclass
class Track:
    id: int
    x: float
    y: float
    box: tuple
    vx: float = 0.0
    vy: float = 0.0
    age: int = 1
    missed: int = 0
    missed_s: float = 0.0


@dataclass
class CentroidTracker:
    """Greedy global distance assignment with motion prediction and bounded expiry.

    The normalized centre and velocity keep matching independent of image size.
    Existing CPU-only deployment needs no additional tracking dependency.
    """
    max_jump: float = 0.08
    max_missed: int = 3
    max_missed_s: float = 1.5
    smoothing: float = 0.5
    tracks: dict = field(default_factory=dict)
    _ids: count = field(default_factory=lambda: count(1))

    def update(self, boxes: list[tuple], frame_w: int, frame_h: int, dt: float) -> list[Track]:
        if frame_w <= 0 or frame_h <= 0:
            raise ValueError("frame dimensions must be positive")
        dt = max(float(dt), 1e-3)
        dets = [((b[0] + b[2]) / 2 / frame_w, (b[1] + b[3]) / 2 / frame_h, tuple(b[:4])) for b in boxes]
        pairs = []
        for tid, t in self.tracks.items():
            elapsed = dt + t.missed_s
            px, py = t.x + t.vx * elapsed, t.y + t.vy * elapsed
            gate = min(self.max_jump * (1 + 0.35 * t.missed), 0.2)
            for j, (x, y, box) in enumerate(dets):
                distance = math.hypot(x - px, y - py)
                if distance <= gate:
                    # Small size-change penalty helps when nearby people cross.
                    old_w, old_h = max(1, t.box[2] - t.box[0]), max(1, t.box[3] - t.box[1])
                    new_w, new_h = max(1, box[2] - box[0]), max(1, box[3] - box[1])
                    size_penalty = 0.01 * (abs(math.log(new_w / old_w)) + abs(math.log(new_h / old_h)))
                    pairs.append((distance + size_penalty, tid, j))
        pairs.sort()
        used_t, used_d, seen = set(), set(), []
        for _, tid, j in pairs:
            if tid in used_t or j in used_d:
                continue
            used_t.add(tid)
            used_d.add(j)
            t = self.tracks[tid]
            x, y, box = dets[j]
            elapsed = dt + t.missed_s
            a = self.smoothing
            t.vx = a * ((x - t.x) / elapsed) + (1 - a) * t.vx
            t.vy = a * ((y - t.y) / elapsed) + (1 - a) * t.vy
            t.x, t.y, t.box = x, y, box
            t.age += 1
            t.missed = 0
            t.missed_s = 0.0
            seen.append(t)
        for j, (x, y, box) in enumerate(dets):
            if j not in used_d:
                t = Track(id=next(self._ids), x=x, y=y, box=box)
                self.tracks[t.id] = t
                seen.append(t)
        seen_ids = {t.id for t in seen}
        for tid in list(self.tracks):
            if tid not in seen_ids:
                t = self.tracks[tid]
                t.missed += 1
                t.missed_s += dt
                if t.missed > self.max_missed or t.missed_s > self.max_missed_s:
                    del self.tracks[tid]
        return seen


def flow_stats(tracks: list[Track], min_speed: float = 0.01,
               min_moving: int = 4, min_stream_fraction: float = 0.25,
               cone_degrees: float = 35.0) -> dict:
    """Classify one-way, multidirectional, opposing streams, or insufficient data."""
    moving = [t for t in tracks if t.age >= 2 and math.hypot(t.vx, t.vy) >= min_speed]
    n = len(moving)
    if n < min_moving:
        return {"coherence": 0.0, "counterflow": 0.0, "speed": 0.0, "angle": 0.0,
                "moving": n, "state": "insufficient", "counterflow_confirmed": False,
                "forward_fraction": 0.0, "reverse_fraction": 0.0}
    vectors = [(t.vx / math.hypot(t.vx, t.vy), t.vy / math.hypot(t.vx, t.vy)) for t in moving]
    ux, uy = sum(v[0] for v in vectors), sum(v[1] for v in vectors)
    coherence = math.hypot(ux, uy) / n
    # Use observed headings as candidate stream axes. This is O(n²) for at most
    # 150 transmitted tracks, and avoids clustering libraries/per-frame models.
    cos_limit = math.cos(math.radians(cone_degrees))
    best = (0, 0, 0.0, 0.0)
    best_dominant = 0
    for ax, ay in vectors:
        forward = sum(1 for vx, vy in vectors if vx * ax + vy * ay >= cos_limit)
        reverse = sum(1 for vx, vy in vectors if vx * ax + vy * ay <= -cos_limit)
        best_dominant = max(best_dominant, forward, reverse)
        if (min(forward, reverse), forward + reverse) > (min(best[0], best[1]), best[0] + best[1]):
            best = (forward, reverse, ax, ay)
    forward, reverse, ax, ay = best
    forward_fraction, reverse_fraction = forward / n, reverse / n
    opposing = forward >= 2 and reverse >= 2 and min(forward_fraction, reverse_fraction) >= min_stream_fraction
    if opposing:
        state = "counterflow"
    elif best_dominant / n >= 0.7:
        state = "one_way"
    else:
        state = "multidirectional"
    speeds = [math.hypot(t.vx, t.vy) for t in moving]
    return {"coherence": round(coherence, 3),
            "counterflow": round(min(forward_fraction, reverse_fraction), 3) if opposing else 0.0,
            "speed": round(sum(speeds) / n, 4),
            "angle": round(math.degrees(math.atan2(uy, ux)), 1), "moving": n,
            "state": state, "counterflow_confirmed": False,
            "forward_fraction": round(forward_fraction, 3),
            "reverse_fraction": round(reverse_fraction, 3)}


@dataclass
class CounterflowPersistence:
    threshold_s: float = 3.0
    opposing_s: float = 0.0

    def update(self, stats: dict, dt: float) -> dict:
        if stats.get("state") == "counterflow":
            self.opposing_s += max(0.0, dt)
        else:
            self.opposing_s = 0.0
        result = dict(stats)
        result["counterflow_confirmed"] = self.opposing_s >= self.threshold_s
        result["opposing_s"] = round(self.opposing_s, 2)
        return result
