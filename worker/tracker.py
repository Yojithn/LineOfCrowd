"""Tiny centroid tracker: gives each person an ID and a velocity across frames."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import count


@dataclass
class Track:
    id: int
    x: float          # centre, 0..1 of frame width
    y: float          # centre, 0..1 of frame height
    box: tuple        # pixel box (x1, y1, x2, y2)
    vx: float = 0.0   # frame widths per second
    vy: float = 0.0
    age: int = 1
    missed: int = 0


@dataclass
class CentroidTracker:
    max_jump: float = 0.08    # largest move between frames, in frame widths
    max_missed: int = 2
    smoothing: float = 0.5
    tracks: dict = field(default_factory=dict)
    _ids: count = field(default_factory=lambda: count(1))

    def update(self, boxes: list[tuple], frame_w: int, frame_h: int, dt: float) -> list[Track]:
        """boxes: (x1, y1, x2, y2, ...) in pixels. Returns tracks seen this frame."""
        dets = [((b[0] + b[2]) / 2 / frame_w, (b[1] + b[3]) / 2 / frame_h, tuple(b[:4])) for b in boxes]
        dt = max(dt, 1e-3)
        pairs = []
        for tid, t in self.tracks.items():
            px, py = t.x + t.vx * dt, t.y + t.vy * dt   # predicted position
            for j, (x, y, _) in enumerate(dets):
                d = math.hypot(x - px, y - py)
                if d <= self.max_jump:
                    pairs.append((d, tid, j))
        pairs.sort()
        used_t, used_d, seen = set(), set(), []
        for _, tid, j in pairs:
            if tid in used_t or j in used_d:
                continue
            used_t.add(tid)
            used_d.add(j)
            t = self.tracks[tid]
            x, y, box = dets[j]
            a = self.smoothing
            t.vx = a * ((x - t.x) / dt) + (1 - a) * t.vx
            t.vy = a * ((y - t.y) / dt) + (1 - a) * t.vy
            t.x, t.y, t.box = x, y, box
            t.age += 1
            t.missed = 0
            seen.append(t)
        for j, (x, y, box) in enumerate(dets):
            if j not in used_d:
                t = Track(id=next(self._ids), x=x, y=y, box=box)
                self.tracks[t.id] = t
                seen.append(t)
        seen_ids = {t.id for t in seen}
        for tid in list(self.tracks):
            if tid not in seen_ids:
                self.tracks[tid].missed += 1
                if self.tracks[tid].missed > self.max_missed:
                    del self.tracks[tid]
        return seen


def flow_stats(tracks: list[Track], min_speed: float = 0.01) -> dict:
    """How orderly the crowd's movement is.

    coherence 1.0 means everyone walks the same way; near 0 means people move in
    opposing directions, which is an early sign of crowd turbulence.
    """
    moving = [t for t in tracks if t.age >= 2 and math.hypot(t.vx, t.vy) >= min_speed]
    if len(moving) < 4:
        return {"coherence": 1.0, "counterflow": 0.0, "speed": 0.0, "angle": 0.0, "moving": len(moving)}
    ux = uy = speed = 0.0
    for t in moving:
        s = math.hypot(t.vx, t.vy)
        ux += t.vx / s
        uy += t.vy / s
        speed += s
    n = len(moving)
    coherence = math.hypot(ux, uy) / n
    return {
        "coherence": round(coherence, 3),
        "counterflow": round(1 - coherence, 3),
        "speed": round(speed / n, 4),
        "angle": round(math.degrees(math.atan2(uy, ux)), 1),
        "moving": n,
    }
