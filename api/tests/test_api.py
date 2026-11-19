import base64
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app, R  # noqa: E402

client = TestClient(app, headers={"Authorization": "Bearer test-operator-key"})


def setup_function():
    R.flushall()


def report(zone="gate", count=10, **extra):
    body = {"zone": zone, "count": count, "pod": f"worker-{zone}-abc", "version": "v1"}
    body.update(extra)
    return client.post("/api/report", json=body, headers={"Authorization": "Bearer test-worker-key"})


def test_health_and_config():
    assert client.get("/healthz").json()["ok"] is True
    cfg = client.get("/api/config").json()
    assert {z["id"] for z in cfg["zones"]} == {"gate", "stage", "food", "exit"}


def test_report_sets_density_and_status():
    r = report(count=90)  # gate camera covers 18 m², so 5 people per m²
    assert r.status_code == 200
    assert r.json()["status"] == "critical"
    state = client.get("/api/state").json()
    gate = next(z for z in state["zones"] if z["id"] == "gate")
    assert gate["density"] == 5.0
    assert gate["offline"] is False
    assert state["overall"] == "critical"


def test_density_uses_tracked_count_and_keeps_raw_detections_separate():
    response = report(count=9, raw_detection_count=12)
    assert response.status_code == 200
    gate = next(z for z in client.get("/api/state").json()["zones"] if z["id"] == "gate")
    assert gate["count"] == 9
    assert gate["raw_detection_count"] == 12
    assert gate["density"] == 0.5
    assert gate["density_method"] == "tracked_people_per_configured_m2"
    assert gate["density_calibration"] == "uncalibrated_approximation"


def test_distinct_zone_areas_do_not_overwrite_each_other():
    report("gate", 18)
    report("stage", 30)
    zones = {z["id"]: z for z in client.get("/api/state").json()["zones"]}
    assert zones["gate"]["area_m2"] == 18 and zones["gate"]["density"] == 1.0
    assert zones["stage"]["area_m2"] == 30 and zones["stage"]["density"] == 1.0


def test_missing_camera_reading_is_offline_with_empty_measurement():
    zones = {z["id"]: z for z in client.get("/api/state").json()["zones"]}
    assert zones["exit"]["offline"] is True
    assert zones["exit"]["density"] == 0.0
    assert zones["exit"]["raw_detection_count"] is None


def test_unknown_zone_is_rejected():
    assert report(zone="moon").status_code == 404


def test_status_change_creates_event_and_redirect_plan():
    report("gate", 10)
    report("exit", 5)
    report("gate", 90)
    state = client.get("/api/state").json()
    assert any(e["kind"] == "critical" for e in state["events"])
    assert state["plans"][0]["from"] == "gate"
    assert state["plans"][0]["to"] == "exit"


def test_frame_round_trip():
    jpg = b"\xff\xd8fakejpeg\xff\xd9"
    report(frame=base64.b64encode(jpg).decode())
    r = client.get("/api/frame/gate.jpg")
    assert r.status_code == 200 and r.content == jpg


def test_chaos_kill_in_local_mode_signals_worker_once():
    report()
    r = client.post("/api/chaos/kill/gate?by=phone")
    assert r.status_code == 200
    assert report().json()["kill"] is True
    assert report().json()["kill"] is False
    # cooldown stops visitors spamming the button
    assert client.post("/api/chaos/kill/gate").status_code == 429


def test_pipeline_rollback_is_recorded():
    for stage, st in [("build", "ok"), ("deploy", "ok"), ("health", "fail"), ("rollback", "ok")]:
        client.post("/api/pipeline", json={"run": "r1", "version": "v3", "previous": "v2", "stage": stage, "state": st},
                    headers={"X-Pipeline-Token": "test-pipeline-key"})
    p = client.get("/api/state").json()["pipeline"]
    assert p["result"] == "rolled_back"
    assert p["stages"]["health"]["state"] == "fail"


def test_qr_code_is_svg():
    r = client.get("/api/qr.svg", params={"data": "http://192.168.1.5:8080/m"})
    assert r.status_code == 200 and b"<svg" in r.content


def test_incident_lifecycle():
    report("gate", 10)
    report("gate", 90)                       # crush risk opens an incident
    incs = client.get("/api/incidents").json()
    assert len(incs) == 1 and incs[0]["state"] == "open" and incs[0]["zone"] == "gate"
    iid = incs[0]["id"]
    report("gate", 95)                       # peak is tracked
    assert client.get("/api/incidents").json()[0]["peak_density"] == round(95 / 18, 2)
    assert client.post(f"/api/incidents/{iid}/ack").json()["state"] == "acknowledged"
    r = client.post(f"/api/incidents/{iid}/respond", json={"by": "a volunteer at Main gate"})
    assert r.json()["state"] == "responding"
    report("gate", 10)                       # zone eases, incident stays until resolved
    inc = client.get("/api/incidents").json()[0]
    assert inc["eased"] is True and inc["state"] == "responding"
    assert client.post(f"/api/incidents/{iid}/resolve").json()["state"] == "resolved"
    assert client.post(f"/api/incidents/{iid}/ack").status_code == 409
    report("gate", 90)                       # a new crush opens a new incident
    ids = [i["id"] for i in client.get("/api/incidents").json()]
    assert len(ids) == 2 and ids[0] != iid


def test_unknown_incident_action_is_rejected():
    assert client.post("/api/incidents/INC-999/ack").status_code == 404
    report("gate", 10); report("gate", 90)
    iid = client.get("/api/incidents").json()[0]["id"]
    assert client.post(f"/api/incidents/{iid}/explode").status_code == 422


def test_settings_change_status_live():
    assert report("gate", 45).json()["status"] == "warning"      # 2.5 per m²
    r = client.put("/api/settings", json={"warning": 1.0, "critical": 2.4})
    assert r.status_code == 200
    from app.main import _t_cache
    _t_cache["ts"] = 0
    assert report("gate", 45).json()["status"] == "critical"
    assert client.put("/api/settings", json={"warning": 3, "critical": 2}).status_code == 422
    client.delete("/api/settings")
    _t_cache["ts"] = 0
    assert report("gate", 45).json()["status"] == "warning"


def test_history_records_points_for_replay():
    report("gate", 30)
    h = client.get("/api/history").json()
    assert h["step_s"] == 2.0
    t, d, c, s = h["zones"]["gate"][-1]
    assert (d, c, s) == (round(30 / 18, 2), 30, "safe")


def test_pod_chaos_in_local_mode_only_hits_cameras():
    report("food", 5)
    assert client.post("/api/chaos/pod/worker-food-abc").json()["ok"] is True
    assert report("food", 5).json()["kill"] is True
    assert client.post("/api/chaos/pod/redis").status_code == 409


def test_state_has_everything_the_dashboard_needs():
    report("gate", 10)
    s = client.get("/api/state").json()
    for key in ("zones", "plans", "pods", "events", "incidents", "thresholds", "served_by", "totals"):
        assert key in s
