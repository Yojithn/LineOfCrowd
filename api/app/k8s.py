"""Small wrapper around the Kubernetes API, used only when running inside the cluster."""
from __future__ import annotations

import os
import time
from typing import Optional

_client = None
_namespace = os.getenv("NAMESPACE", "lineofcrowd")
_cache: dict = {"ts": 0.0, "pods": []}
_timeout = (2, 2)


def in_cluster() -> bool:
    return bool(os.getenv("KUBERNETES_SERVICE_HOST"))


def _api():
    global _client
    if _client is None:
        from kubernetes import client, config  # imported lazily so local mode needs nothing
        configuration = client.Configuration(retries=0)
        config.load_incluster_config(client_configuration=configuration)
        _client = client.CoreV1Api(client.ApiClient(configuration))
    return _client


def _pod_state(p) -> str:
    """Collapse Kubernetes pod details into one word the dashboard can colour."""
    if p.metadata.deletion_timestamp is not None:
        return "terminating"
    statuses = p.status.container_statuses or []
    for cs in statuses:
        waiting = cs.state.waiting if cs.state else None
        if waiting and waiting.reason in ("CrashLoopBackOff", "Error", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError"):
            return "crashing"
        terminated = cs.state.terminated if cs.state else None
        if terminated and terminated.exit_code != 0:
            return "crashing"
    if p.status.phase == "Running" and statuses and all(cs.ready for cs in statuses):
        return "ready"
    if p.status.phase in ("Failed",):
        return "crashing"
    return "starting"


def list_pods(max_age_s: float = 1.0) -> list[dict]:
    now = time.time()
    if now - _cache["ts"] < max_age_s:
        return _cache["pods"]
    pods = []
    resp = _api().list_namespaced_pod(_namespace, label_selector="app.kubernetes.io/part-of=lineofcrowd",
                                     _request_timeout=_timeout)
    for p in resp.items:
        labels = p.metadata.labels or {}
        env_version = None
        for c in p.spec.containers:
            for e in c.env or []:
                if e.name == "APP_VERSION":
                    env_version = e.value
        restarts = sum(cs.restart_count for cs in (p.status.container_statuses or []))
        pods.append({
            "name": p.metadata.name,
            "role": labels.get("role", "other"),
            "zone": labels.get("zone"),
            "state": _pod_state(p),
            "restarts": restarts,
            "version": env_version,
            "created": p.metadata.creation_timestamp.timestamp() if p.metadata.creation_timestamp else None,
        })
    pods.sort(key=lambda x: (x["role"], x.get("zone") or "", x["created"] or 0))
    _cache.update(ts=now, pods=pods)
    return pods


def delete_worker_pod(zone: str) -> Optional[str]:
    """Delete the running camera pod for a zone, instantly. Returns the pod name."""
    resp = _api().list_namespaced_pod(_namespace, label_selector=f"role=worker,zone={zone}",
                                     _request_timeout=_timeout)
    live = [p for p in resp.items if p.metadata.deletion_timestamp is None]
    if not live:
        return None
    # Prefer the pod that is actually serving (ready) so the effect is visible.
    live.sort(key=lambda p: _pod_state(p) != "ready")
    target = live[0].metadata.name
    _api().delete_namespaced_pod(target, _namespace, grace_period_seconds=0, _request_timeout=_timeout)
    _cache["ts"] = 0.0
    return target


def delete_pod(name: str) -> str:
    """Delete one pod chosen in the cluster inspector. Only camera and API pods are allowed:
    Redis has a single copy, so deleting it would wipe the live state."""
    pod = _api().read_namespaced_pod(name, _namespace, _request_timeout=_timeout)
    labels = pod.metadata.labels or {}
    role = labels.get("role")
    if labels.get("app.kubernetes.io/part-of") != "lineofcrowd" or role not in ("worker", "api"):
        raise PermissionError("Only camera and API pods can be deleted from the dashboard.")
    _api().delete_namespaced_pod(name, _namespace, grace_period_seconds=0 if role == "worker" else 2,
                                _request_timeout=_timeout)
    _cache["ts"] = 0.0
    return role
