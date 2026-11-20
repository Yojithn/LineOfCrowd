import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


def test_worker_continues_after_camera_and_network_failures(monkeypatch, tmp_path):
    import sim
    import numpy as np

    class Camera:
        def __init__(self, *args, **kwargs):
            self.first = True

        def step(self, dt):
            if self.first:
                self.first = False
                raise OSError("read failed")
            return np.zeros((32, 32, 3), dtype=np.uint8), []

    attempts = []
    delays = []

    def send(method, path, body):
        attempts.append(body)
        if len(attempts) == 1:
            raise ConnectionResetError()
        return {"status": "safe"}

    def wait(delay):
        delays.append(delay)
        if len(delays) == 2:
            raise SystemExit()

    monkeypatch.setattr(worker, "WORKER_KEY", "test")
    monkeypatch.setattr(worker, "FORCE_SIM", True)
    monkeypatch.setattr(worker, "zone_settings", lambda: (20, 4))
    monkeypatch.setattr(worker, "http_json", send)
    monkeypatch.setattr(worker, "HEARTBEAT", tmp_path / "heartbeat")
    monkeypatch.setattr(sim, "SimCamera", Camera)
    monkeypatch.setattr(worker.time, "sleep", wait)
    with pytest.raises(SystemExit):
        worker.main()
    assert attempts[0]["fault"] == "no_frames"
    assert "count" not in attempts[0]
    assert attempts[1]["count"] == 0 and attempts[1]["frame"]
    assert attempts[0]["started_at"] == attempts[1]["started_at"]
    assert delays[0] >= 0.5 and worker.HEARTBEAT.exists()


@pytest.mark.parametrize("calm_phase", [0.0, 1.6, 3.1, 4.7])
def test_surge_drill_reaches_crush_risk_within_about_ten_seconds(calm_phase):
    import sim

    area, critical = 18.0, 4.0
    cam = sim.SimCamera("gate", area, critical, seed=1)
    cam.phase = calm_phase          # calm level wanders between 0.5 and 1.9 people/m²
    start = cam.t0
    cam.surge_start = start
    assert cam.target_count(start) / area < 2.0                    # still calm when triggered
    assert cam.target_count(start + 10.5) / area >= critical       # red within ~10 s
    assert cam.target_count(start + sim.SURGE_RISE_S + 20) / area >= critical   # holds long enough to demo
