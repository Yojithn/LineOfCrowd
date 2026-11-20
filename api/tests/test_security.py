import asyncio
import base64
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient
from redis import exceptions as redis

from app import main, security
from app.observability import logger
from app.report_schema import MAX_FRAME_BYTES, MAX_PERSON_COUNT, MAX_REPORT_BYTES

WORKER = {"Authorization": "Bearer test-worker-key"}
OPERATOR = {"Authorization": "Bearer test-operator-key"}
BODY = {"zone": "gate", "count": 10, "pod": "worker-gate", "version": "v1"}
SETTINGS = {"warning": 1.5, "critical": 3.5}


@pytest.fixture
def client():
    main.R.flushall()
    main._t_cache.update(ts=0, t=main.DEFAULT_T)
    return TestClient(main.app)


@pytest.fixture
def captured_logs(caplog, monkeypatch):
    monkeypatch.setattr(logger, "handlers", [caplog.handler])
    return caplog


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong-worker-key"}, OPERATOR])
def test_report_requires_worker_credentials(client, headers):
    response = client.post("/api/report", json=BODY, headers=headers)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert main.R.dbsize() == 0


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong-operator-key"}, WORKER])
@pytest.mark.parametrize(("method", "path", "body"), [
    ("PUT", "/api/settings", SETTINGS),
    ("DELETE", "/api/settings", None),
    ("POST", "/api/incidents/INC-001/ack", None),
    ("POST", "/api/incidents/INC-001/respond", None),
    ("POST", "/api/incidents/INC-001/resolve", None),
    ("POST", "/api/chaos/surge/gate", None),
])
def test_operator_routes_reject_missing_or_incorrect_role(client, method, path, body, headers):
    assert client.request(method, path, json=body, headers=headers).status_code == 401
    assert main.R.dbsize() == 0


def test_operator_bearer_and_browser_session(client):
    assert client.put("/api/settings", json=SETTINGS, headers=OPERATOR).status_code == 200
    assert client.get("/api/operator").status_code == 401
    assert client.get("/api/operator", auth=("operator", "test-worker-key")).status_code == 401
    sign_in = client.get("/api/operator", auth=("operator", "test-operator-key"))
    assert sign_in.status_code == 200
    assert "HttpOnly" in sign_in.headers["set-cookie"]
    assert "SameSite=strict" in sign_in.headers["set-cookie"]
    assert "test-operator-key" not in sign_in.headers["set-cookie"]
    assert client.delete("/api/settings", headers={"Origin": "https://other.example"}).status_code == 403
    assert client.delete("/api/settings", headers={"Sec-Fetch-Site": "same-site"}).status_code == 403
    assert client.delete("/api/settings", headers=WORKER).status_code == 401
    assert client.delete("/api/settings", headers={"Origin": "http://testserver"}).status_code == 200
    session = client.cookies[security.COOKIE]
    client.cookies.clear()
    client.cookies.set(security.COOKIE, session + "tampered")
    assert client.delete("/api/settings").status_code == 401


@pytest.mark.parametrize("page", ["/", "/m"])
def test_browser_sign_in_returns_to_the_page_it_came_from(client, page):
    r = client.get(f"/api/operator?next={page}", auth=("operator", "test-operator-key"), follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == page
    assert security.COOKIE in r.headers["set-cookie"]
    assert client.delete("/api/settings", headers={"Origin": "http://testserver"}).status_code == 200


@pytest.mark.parametrize("target", ["https://evil.example", "//evil.example", "/api/settings"])
def test_sign_in_never_redirects_off_the_dashboard(client, target):
    r = client.get("/api/operator", params={"next": target}, auth=("operator", "test-operator-key"),
                   follow_redirects=False)
    assert r.status_code == 200
    assert "location" not in r.headers
    assert client.get(f"/api/operator?next={target}", follow_redirects=False).status_code == 401


def test_production_session_is_secure_and_configuration_fails_closed(monkeypatch):
    monkeypatch.setattr(security, "DEVELOPMENT", False)
    with TestClient(main.app, base_url="https://testserver") as client:
        r = client.get("/api/operator", auth=("operator", "test-operator-key"))
        assert "Secure" in r.headers["set-cookie"]
    monkeypatch.setattr(security, "WORKER_KEY", "")
    with pytest.raises(RuntimeError, match="are required"):
        with TestClient(main.app):
            pytest.fail("Production API started without a worker key")
    monkeypatch.setattr(security, "WORKER_KEY", security.OPERATOR_KEY)
    with pytest.raises(RuntimeError, match="must be distinct"):
        security.check_configuration()


@pytest.mark.parametrize("path", ["/api/chaos/kill/gate", "/api/chaos/surge/gate", "/api/chaos/pod/worker-gate"])
@pytest.mark.parametrize(("development", "enabled"), [(False, True), (True, False)])
def test_chaos_is_disabled_outside_explicit_development(client, monkeypatch, path, development, enabled):
    monkeypatch.setattr(security, "DEVELOPMENT", development)
    monkeypatch.setattr(security, "ENABLE_CHAOS", enabled)
    assert client.post(path, headers=OPERATOR).status_code == 404
    main.R.set("kill:gate", 1)
    assert client.post("/api/report", json=BODY, headers=WORKER).json()["kill"] is False


def test_pipeline_uses_its_own_token(client):
    update = {"run": "test", "version": "v2", "stage": "build", "state": "ok"}
    assert client.post("/api/pipeline", json=update).status_code == 401
    assert client.post("/api/pipeline", json=update, headers={"X-Pipeline-Token": "test-worker-key"}).status_code == 401
    assert client.post("/api/pipeline", json=update, headers={"X-Pipeline-Token": "test-pipeline-key"}).status_code == 200


@pytest.mark.parametrize(("extra", "status"), [
    ({"count": -1}, 422),
    ({"count": MAX_PERSON_COUNT + 1}, 422),
    ({"count": 1.0}, 422),
    ({"count": True}, 422),
    ({"count": "10"}, 422),
    ({"zone": "unconfigured"}, 404),
    ({"points": [[1.001, 0, 0, 0]]}, 422),
    ({"points": [[0, -0.001, 0, 0]]}, 422),
    ({"points": [[0, 1, -1001, 0]]}, 422),
    ({"points": [[0, 1, 0]]}, 422),
    ({"points": [[0, 1, 0, 0]] * 151}, 422),
    ({"flow": {"coherence": 1.1}}, 422),
    ({"flow": {"counterflow": -0.01}}, 422),
    ({"flow": {"angle": 181}}, 422),
    ({"flow": {"speed": -1}}, 422),
    ({"fps": -1}, 422),
    ({"infer_ms": -1}, 422),
    ({"version": ""}, 422),
    ({"pod": "../redis"}, 422),
    ({"frame": "!!!!"}, 422),
    ({"frame": "QUJDRA=="}, 422),
    ({"frame": ""}, 422),
])
def test_invalid_reports_have_no_side_effects(client, extra, status):
    response = client.post("/api/report", json=BODY | extra, headers=WORKER)
    assert response.status_code == status
    assert main.R.dbsize() == 0


@pytest.mark.parametrize("field", ["zone", "count", "version", "pod"])
def test_required_fields(client, field):
    assert client.post("/api/report", json={k: v for k, v in BODY.items() if k != field},
                       headers=WORKER).status_code == 422


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_metrics_are_rejected_without_echo(client, value):
    body = json.dumps(BODY | {"fps": value, "infer_ms": value, "points": [[0, 0, value, 0]]})
    r = client.post("/api/report", content=body, headers=WORKER | {"Content-Type": "application/json"})
    assert r.status_code == 422
    assert all(issue["type"] == "finite_number" for issue in r.json()["detail"])
    assert "input" not in r.text


def test_malformed_json_does_not_echo_body_or_headers(client, captured_logs):
    content = '{"secret-looking-body":"value"'
    r = client.post("/api/report", content=content, headers=WORKER | {"Content-Type": "application/json"})
    assert r.status_code == 400
    assert r.json()["detail"][0]["msg"] == "Malformed JSON."
    assert "secret-looking-body" not in r.text + captured_logs.text
    assert "test-worker-key" not in r.text + captured_logs.text
    bad = client.post("/api/report", json=BODY | {"secret-field": "secret-value"}, headers=WORKER)
    assert "secret-field" not in bad.text + captured_logs.text
    assert "secret-value" not in bad.text + captured_logs.text
    assert "invalid_request" in captured_logs.text


def test_frame_bounds_and_chunked_body(client):
    # This has the same encoded length as a maximum-size frame.
    oversized = base64.b64encode(b"\xff\xd8" + b"x" * (MAX_FRAME_BYTES - 3) + b"\xff\xd9").decode()
    r = client.post("/api/report", json=BODY | {"frame": oversized}, headers=WORKER)
    assert r.status_code == 422
    assert "configured size limit" in r.text
    too_large = b" " * (MAX_REPORT_BYTES + 1)
    headers = WORKER | {"Content-Type": "application/json"}
    assert client.post("/api/report", content=too_large, headers=headers).status_code == 413
    assert client.post("/api/report", content=iter([too_large]), headers=headers).status_code == 413
    assert main.R.dbsize() == 0


def test_compose_and_kubernetes_validate_reported_worker_identity(client, monkeypatch):
    monkeypatch.setattr(main, "MODE", "compose")
    valid = BODY | {"sim": True, "fps": 1000.0, "infer_ms": 0,
                    "flow": {"coherence": 0.7, "counterflow": 0.3, "speed": 0.1654, "angle": -179.8, "moving": 8},
                    "points": [[0.356, 0.679, -0.02, 0.03], [1.0, 0.0, 0.0, -0.11]]}
    assert client.post("/api/report", json=valid, headers=WORKER).status_code == 200
    assert client.post("/api/report", json=valid | {"pod": "worker-stage"}, headers=WORKER).status_code == 422
    monkeypatch.setattr(main, "MODE", "k8s")
    monkeypatch.setattr(main.k8s, "list_pods", lambda: [{"name": "worker-gate-rollout-a", "role": "worker", "zone": "gate"}])
    assert client.post("/api/report", json=valid, headers=WORKER).status_code == 422
    assert client.post("/api/report", json=valid | {"pod": "worker-gate-rollout-a"}, headers=WORKER).status_code == 200


@pytest.mark.parametrize(("error", "status"), [(redis.ConnectionError, 503), (redis.TimeoutError, 503),
                                              (redis.ResponseError, 500)])
def test_redis_failures_are_logged_and_sanitized(client, monkeypatch, captured_logs, error, status):
    def failing(*args, **kwargs):
        raise error("private-node.example:1234 credentials")

    monkeypatch.setattr(main.R, "get", failing)
    r = client.post("/api/report", json=BODY, headers=WORKER)
    assert r.status_code == status
    assert "private-node" not in r.text + captured_logs.text
    assert "credentials" not in r.text + captured_logs.text
    [event] = [json.loads(record.message) for record in captured_logs.records]
    assert event["error_type"] == error.__name__
    assert event["event"] == "redis_failure" and event["zone"] == "gate"


def test_readiness_covers_redis_outage(client, monkeypatch):
    def unavailable():
        raise redis.ConnectionError("private Redis")

    monkeypatch.setattr(main.R, "ping", unavailable)
    assert client.get("/healthz").status_code == 200
    assert client.get("/readyz").json() == {"detail": "Service temporarily unavailable."}
    assert client.get("/readyz").status_code == 503


def test_live_stream_sanitizes_failures_and_resumes(monkeypatch, captured_logs):
    class Connected:
        async def is_disconnected(self):
            return False

    calls = iter([redis.TimeoutError("private Redis"), {"overall": "safe"}])

    def build_state():
        result = next(calls)
        if isinstance(result, Exception):
            raise result
        return result

    async def read_stream():
        response = await main.stream(Connected())
        stream = response.body_iterator
        try:
            assert await anext(stream) == "retry: 1000\n\n"
            assert await anext(stream) == 'event: problem\ndata: {"message":"Live state temporarily unavailable."}\n\n'
            assert await anext(stream) == 'event: state\ndata: {"overall":"safe"}\n\n'
        finally:
            await stream.aclose()

    monkeypatch.setattr(main, "build_state", build_state)
    asyncio.run(read_stream())
    assert "stream_failure" in captured_logs.text
    assert "private Redis" not in captured_logs.text


def test_watcher_logs_failures_and_continues(monkeypatch, captured_logs):
    stopped = threading.Event()
    calls = []

    def iteration():
        calls.append(None)
        if len(calls) == 1:
            raise redis.ConnectionError("private Redis")
        stopped.set()

    monkeypatch.setattr(main, "_watch_once", iteration)
    monkeypatch.setattr(stopped, "wait", lambda seconds: None)
    main._watch(stopped)
    assert len(calls) == 2
    assert [json.loads(record.message)["event"] for record in captured_logs.records] == [
        "watcher_failure", "watcher_recovered"]
    assert "private Redis" not in captured_logs.text


def test_camera_heartbeat_transitions_are_logged(client, captured_logs):
    assert client.post("/api/report", json=BODY, headers=WORKER).status_code == 200
    main._watch_once()
    record = json.loads(main.R.get("zone:gate"))
    main.R.set("zone:gate", json.dumps(record | {"ts": time.time() - 60}))
    main._watch_once()
    main._watch_once()
    assert client.post("/api/report", json=BODY, headers=WORKER).status_code == 200
    main._watch_once()
    assert [json.loads(record.message)["event"] for record in captured_logs.records] == [
        "camera_offline", "camera_online"]


@pytest.mark.parametrize("path", ["/", "/m", "/api/config", "/api/state", "/api/history", "/api/settings", "/api/incidents"])
def test_dashboard_reads_without_credentials(client, path):
    assert client.get(path).status_code == 200
