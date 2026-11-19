"""CrowdSentinel helper. Works the same on Windows, macOS and Linux. Needs only Python.

  python scripts/cs.py doctor                 check that Docker, kind and kubectl are ready
  python scripts/cs.py up                     create the cluster, build, load and start everything
  python scripts/cs.py deploy --version v2    release a new version with a rolling update
  python scripts/cs.py deploy --version v3 --broken   release a broken model to show auto-rollback
  python scripts/cs.py status                 list pods
  python scripts/cs.py logs gate              show one camera's logs
  python scripts/cs.py down                   delete the cluster
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLUSTER = "crowdsentinel"
NS = "crowdsentinel"
WORKERS = ["worker-gate", "worker-stage", "worker-food", "worker-exit"]
API_URL = "http://localhost:8080"


# ---------- small helpers ----------

def say(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def run(cmd: list[str], check: bool = True, capture: bool = False, timeout: int | None = None) -> subprocess.CompletedProcess:
    print("   $ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=ROOT, check=check, text=True, timeout=timeout,
                          capture_output=capture)


def kubectl(*args: str, check: bool = True, capture: bool = False, timeout: int | None = None):
    return run(["kubectl", "--context", f"kind-{CLUSTER}", "-n", NS, *args], check=check, capture=capture, timeout=timeout)


def lan_ip() -> str:
    """The laptop's Wi-Fi address, so phones on the same network can open the dashboard."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))   # no packet is sent; this only picks the outgoing network card
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def stage(run_id: str, version: str, name: str, state: str, note: str = "", previous: str | None = None) -> None:
    """Tell the dashboard's pipeline panel what is happening. Never fails the deploy."""
    body = json.dumps({"run": run_id, "version": version, "stage": name, "state": state,
                       "note": note, "previous": previous}).encode()
    req = urllib.request.Request(f"{API_URL}/api/pipeline", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    req.add_unredirected_header("X-Pipeline-Token", os.getenv("PIPELINE_TOKEN", ""))
    try:
        urllib.request.urlopen(req, timeout=3).read()
    except urllib.error.HTTPError as exc:
        print(f"   [pipeline] API rejected the status update (HTTP {exc.code}).", flush=True)
    except OSError as exc:
        print(f"   [pipeline] Could not send the status update ({type(exc).__name__}).", flush=True)
    print(f"   [pipeline] {name}: {state} {note}".rstrip(), flush=True)


def current_version() -> str | None:
    out = kubectl("get", "deploy", WORKERS[0], "-o",
                  "jsonpath={.spec.template.spec.containers[0].env[?(@.name=='APP_VERSION')].value}",
                  check=False, capture=True)
    return out.stdout.strip() or None


def short_version(v: str) -> str:
    m = re.fullmatch(r"(git-)?([0-9a-f]{12,40})", v)
    return f"git-{m.group(2)[:7]}" if m else v


def build_and_load(tag: str) -> None:
    for name in ("api", "worker"):
        image = f"crowdsentinel-{name}:{tag}"
        run(["docker", "build", "-t", image, str(ROOT / name)])
        run(["kind", "load", "docker-image", image, "--name", CLUSTER])


# ---------- commands ----------

def cmd_doctor(_args) -> int:
    ok = True
    for tool in ("docker", "kind", "kubectl"):
        path = shutil.which(tool)
        print(f"  {tool:8} {'found at ' + path if path else 'NOT FOUND, install it (see README)'}")
        ok &= bool(path)
    if shutil.which("docker"):
        r = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True)
        if r.returncode != 0:
            print("  Docker is installed but not running. Start Docker Desktop and wait for 'Engine running'.")
            ok = False
        else:
            print(f"  Docker engine {r.stdout.strip()} is running")
    print(f"  Wi-Fi address for phones: http://{lan_ip()}:8080")
    print("  All good." if ok else "  Fix the items above, then run this again.")
    return 0 if ok else 1


def cmd_up(args) -> int:
    if cmd_doctor(args) != 0:
        return 1
    auth = {name: os.getenv(name, "") for name in ("WORKER_API_KEY", "OPERATOR_API_KEY", "PIPELINE_TOKEN")}
    if not auth["WORKER_API_KEY"] or not auth["OPERATOR_API_KEY"]:
        say("Set WORKER_API_KEY and OPERATOR_API_KEY before running up. See README.")
        return 1
    clusters = subprocess.run(["kind", "get", "clusters"], capture_output=True, text=True).stdout.split()
    if CLUSTER in clusters:
        say("Cluster already exists, reusing it")
    else:
        say("Creating the Kubernetes cluster (about 1 minute)")
        run(["kind", "create", "cluster", "--config", str(ROOT / "kind-cluster.yaml")])

    say("Building images and loading them into the cluster (first time: a few minutes)")
    build_and_load("v1")

    context = ["kubectl", "--context", f"kind-{CLUSTER}"]
    run([*context, "apply", "-f", str(ROOT / "k8s" / "00-namespace.yaml")])
    secret = {
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": {"name": "api-auth", "namespace": NS},
        "data": {name: base64.b64encode(value.encode()).decode() for name, value in auth.items()},
    }
    config = {
        "apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "api-config", "namespace": NS},
        "data": {"APP_ENV": os.getenv("APP_ENV", "production"), "ENABLE_CHAOS": os.getenv("ENABLE_CHAOS", "0")},
    }
    resources = json.dumps({"apiVersion": "v1", "kind": "List", "items": [secret, config]})
    subprocess.run([*context, "apply", "--server-side", "-f", "-"], text=True, input=resources, check=True)

    say("Applying Kubernetes manifests")
    run(["kubectl", "--context", f"kind-{CLUSTER}", "apply", "-f", str(ROOT / "k8s")])
    public = args.public_url or f"http://{lan_ip()}:8080"
    kubectl("set", "env", "deploy/api", f"PUBLIC_URL={public}")
    if CLUSTER in clusters:
        # same image tag, new contents: restart so the pods pick up the fresh build
        kubectl("rollout", "restart", "deploy/api", *[f"deploy/{w}" for w in WORKERS])

    say("Waiting for every pod to become healthy")
    for d in ["redis", "api", *WORKERS]:
        kubectl("rollout", "status", f"deploy/{d}", "--timeout=180s")
    kubectl("get", "pods", "-o", "wide")
    say("CrowdSentinel is running")
    print(f"  Dashboard on this laptop:  {API_URL}")
    print(f"  Phones on the same Wi-Fi:  {public}/m")
    return 0


def cmd_deploy(args) -> int:
    version = short_version(args.version)
    run_id = args.run_id or f"local-{int(time.time())}"
    previous = current_version()
    say(f"Releasing {version} (currently {previous or 'unknown'})" + (" with a BROKEN model on purpose" if args.broken else ""))

    stage(run_id, version, "commit", "ok", previous=previous)
    stage(run_id, version, "test", "ok" if args.tests_passed else "skipped", previous=previous)

    changed = list(WORKERS)
    if args.build:
        stage(run_id, version, "build", "running", previous=previous)
        try:
            build_and_load(version)
        except subprocess.CalledProcessError as exc:
            stage(run_id, version, "build", "fail", f"Image build exited with code {exc.returncode}.",
                  previous=previous)
            return 1
        stage(run_id, version, "build", "ok", previous=previous)
    else:
        stage(run_id, version, "build", "skipped", "config-only release", previous=previous)

    stage(run_id, version, "deploy", "running", previous=previous)
    env = [f"APP_VERSION={version}", f"BROKEN={'1' if args.broken else '0'}"]
    if args.build:
        kubectl("set", "image", *[f"deploy/{w}" for w in WORKERS], f"camera=crowdsentinel-worker:{version}")
        kubectl("set", "image", "deploy/api", f"api=crowdsentinel-api:{version}")
        kubectl("set", "env", "deploy/api", f"APP_VERSION={version}")
        changed.append("api")
    kubectl("set", "env", *[f"deploy/{w}" for w in WORKERS], *env)
    stage(run_id, version, "deploy", "ok", "rolling update started", previous=previous)

    stage(run_id, version, "health", "running", "waiting for the new pods to pass their health checks", previous=previous)
    failed = None
    for d in changed:
        r = kubectl("rollout", "status", f"deploy/{d}", f"--timeout={args.timeout}s", check=False, timeout=args.timeout + 15)
        if r.returncode != 0:
            failed = d
            break
    if not failed:
        stage(run_id, version, "health", "ok", previous=previous)
        stage(run_id, version, "live", "ok", previous=previous)
        say(f"{version} is live")
        return 0

    stage(run_id, version, "health", "fail", f"{failed} never became healthy", previous=previous)
    say(f"{failed} failed its health checks. Rolling back every component to {previous}")
    stage(run_id, version, "rollback", "running", previous=previous)
    for d in changed:
        kubectl("rollout", "undo", f"deploy/{d}", check=False)
    for d in changed:
        kubectl("rollout", "status", f"deploy/{d}", "--timeout=120s", check=False)
    stage(run_id, version, "rollback", "ok", f"back on {previous}", previous=previous)
    say(f"Rolled back to {previous}. The release is marked as failed.")
    return 1


def cmd_status(_args) -> int:
    kubectl("get", "deploy,pods", "-o", "wide")
    return 0


def cmd_logs(args) -> int:
    kubectl("logs", "-l", f"zone={args.zone}", "--tail", "40", "--prefix")
    return 0


def cmd_down(_args) -> int:
    run(["kind", "delete", "cluster", "--name", CLUSTER])
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="CrowdSentinel helper")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("doctor")
    up = sub.add_parser("up")
    up.add_argument("--public-url", help="Address phones should use, e.g. http://192.168.43.20:8080")
    d = sub.add_parser("deploy")
    d.add_argument("--version", required=True)
    d.add_argument("--broken", action="store_true", help="ship a model that fails to load (tests auto-rollback)")
    d.add_argument("--build", action="store_true", help="rebuild the images from the code first")
    d.add_argument("--run-id", help="id shown on the dashboard, e.g. the GitHub run id")
    d.add_argument("--tests-passed", action="store_true", help="mark the test stage as passed (set by CI)")
    d.add_argument("--timeout", type=int, default=60)
    sub.add_parser("status")
    lg = sub.add_parser("logs")
    lg.add_argument("zone", choices=["gate", "stage", "food", "exit"])
    sub.add_parser("down")
    args = p.parse_args()
    return {"doctor": cmd_doctor, "up": cmd_up, "deploy": cmd_deploy, "status": cmd_status,
            "logs": cmd_logs, "down": cmd_down}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
