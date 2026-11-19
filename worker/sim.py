"""Simulated night-time CCTV feed, used when no video file is available.

It draws people walking on a lit ground plane and returns their boxes, so the rest
of the system (tracking, density, alerts, dashboard) behaves exactly as with a real
camera. A surge can be triggered to rehearse the red-alert moment.
"""
from __future__ import annotations

import math
import random
import time

import cv2
import numpy as np

W, H = 640, 360
HORIZON = 0.18  # top of the walkable ground, as a fraction of frame height


class SimCamera:
    def __init__(self, zone: str, area_m2: float, critical: float = 4.0,
                 autosurge_every_s: float = 0.0, seed: int | None = None):
        self.zone = zone
        self.area = area_m2
        self.critical = critical
        self.autosurge_every = autosurge_every_s
        self.rng = random.Random(seed if seed is not None else hash(zone) & 0xFFFF)
        self.t0 = time.time()
        self.surge_start: float | None = None
        self.last_auto = self.t0
        self.people: list[list[float]] = []   # [x, y, vx, vy, hue]
        # each zone has a main walking direction, like a real crowd stream
        self.heading = {"gate": 0.0, "stage": math.pi / 2, "food": math.pi, "exit": -math.pi / 2}.get(zone, 0.3)
        self.phase = self.rng.random() * math.tau
        self._bg = self._background()

    # ---------- crowd size over time ----------
    def surge(self) -> None:
        self.surge_start = time.time()

    def _surge_level(self, now: float) -> float:
        if self.autosurge_every and now - self.last_auto >= self.autosurge_every:
            self.last_auto = now
            self.surge_start = now
        if self.surge_start is None:
            return 0.0
        t = now - self.surge_start
        rise, hold, fall = 35.0, 25.0, 30.0
        if t < rise:
            return t / rise
        if t < rise + hold:
            return 1.0
        if t < rise + hold + fall:
            return 1.0 - (t - rise - hold) / fall
        self.surge_start = None
        return 0.0

    def target_count(self, now: float) -> int:
        calm = 1.2 + 0.7 * math.sin((now - self.t0) / 40.0 + self.phase)    # 0.5 .. 1.9 people/m²
        peak = self.critical * 1.18
        d = calm + (peak - calm) * self._surge_level(now)
        return max(1, int(round(d * self.area)))

    # ---------- drawing ----------
    def _background(self) -> np.ndarray:
        img = np.zeros((H, W, 3), np.uint8)
        for y in range(H):
            k = y / H
            img[y, :] = (int(12 + 10 * k), int(18 + 20 * k), int(28 + 30 * k))   # warm sodium-lamp night (BGR)
        top = int(H * HORIZON)
        for i in range(-8, 9):  # perspective lines of the paved ground
            x_far = W / 2 + i * 26
            x_near = W / 2 + i * 120
            cv2.line(img, (int(x_far), top), (int(x_near), H), (40, 52, 74), 1, cv2.LINE_AA)
        for j in range(1, 9):
            y = int(top + (H - top) * (j / 9) ** 1.6)
            cv2.line(img, (0, y), (W, y), (34, 44, 64), 1, cv2.LINE_AA)
        glow = np.zeros_like(img, dtype=np.float32)
        for lx in (0.15, 0.5, 0.85):   # street lamps
            cv2.circle(glow, (int(W * lx), top + 10), 70, (70, 150, 220), -1)
        glow = cv2.GaussianBlur(glow, (0, 0), 45)
        img = np.clip(img.astype(np.float32) + glow * 0.22, 0, 255)
        yy, xx = np.mgrid[0:H, 0:W]
        vignette = 1 - 0.45 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2
        img = np.clip(img * vignette[..., None], 0, 255).astype(np.uint8)
        return img

    @staticmethod
    def _scale(y: float) -> float:
        return 0.35 + 0.65 * (y - HORIZON) / (1 - HORIZON)

    def step(self, dt: float) -> tuple[np.ndarray, list[tuple]]:
        now = time.time()
        target = self.target_count(now)
        surge = self._surge_level(now)
        while len(self.people) < target:
            self.people.append(self._spawn())
        if len(self.people) > target:
            self.people = self.people[: max(target, len(self.people) - 3)]
        chaos = 0.25 + 1.1 * surge  # crowds get turbulent when packed
        for p in self.people:
            jitter = self.rng.gauss(0, 0.6) * chaos
            ang = math.atan2(p[3], p[2]) + jitter * dt
            spd = max(0.012, math.hypot(p[2], p[3]) * (1 - 0.5 * surge * dt))
            p[2], p[3] = spd * math.cos(ang), spd * math.sin(ang)
            p[0] += p[2] * dt
            p[1] += p[3] * dt
            if not (-0.05 <= p[0] <= 1.05 and HORIZON - 0.02 <= p[1] <= 1.05):
                p[:] = self._spawn()
        frame = self._bg.copy()
        boxes = []
        for p in sorted(self.people, key=lambda q: q[1]):
            s = self._scale(p[1])
            h = 46 * s
            w = 17 * s
            cx, cy = p[0] * W, p[1] * H
            x1, y1, x2, y2 = cx - w / 2, cy - h, cx + w / 2, cy
            color = tuple(int(c) for c in cv2.cvtColor(np.uint8([[[p[4], 35, 165]]]), cv2.COLOR_HSV2BGR)[0, 0])
            cv2.ellipse(frame, (int(cx), int(cy - h * 0.42)), (max(2, int(w / 2)), max(3, int(h * 0.36))), 0, 0, 360, color, -1, cv2.LINE_AA)
            cv2.circle(frame, (int(cx), int(cy - h * 0.86)), max(2, int(w * 0.33)), (120, 135, 160), -1, cv2.LINE_AA)
            if 0 <= cx < W and 0 <= y1 and y2 <= H:
                boxes.append((max(0, x1), max(0, y1), min(W, x2), min(H, y2), 0.9))
        noise = np.random.default_rng().integers(0, 14, frame.shape, dtype=np.uint8)
        frame = cv2.add(frame, noise)
        return frame, boxes

    def _spawn(self) -> list[float]:
        r = self.rng
        heading = self.heading + r.gauss(0, 0.5)
        if r.random() < 0.18:  # some people walk against the stream
            heading += math.pi
        spd = r.uniform(0.02, 0.06)
        return [r.uniform(0.02, 0.98), r.uniform(HORIZON + 0.03, 0.98),
                spd * math.cos(heading), spd * math.sin(heading) * 0.6, r.randint(0, 179)]
