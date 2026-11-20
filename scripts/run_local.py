"""Run the authenticated dashboard and four camera workers on this machine."""

import argparse
import os
import secrets
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8080"
ZONES = ("gate", "stage", "food", "exit")


def start(stack: ExitStack, command: list[str], directory: Path, env: dict[str, str]):
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = subprocess.Popen(
        [sys.executable, *command], cwd=directory, env=env, creationflags=creationflags
    )

    def stop() -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    stack.callback(stop)
    return process


def credential(env: dict[str, str], name: str) -> str:
    value = env.get(name) or secrets.token_urlsafe(32)
    env[name] = value
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--simulate-gate",
        action="store_true",
        help="Use the simulated Main gate feed so the surge drill works with gate.mp4 present.",
    )
    args = parser.parse_args()

    env = dict(os.environ)
    env.update(MODE="local", REDIS_URL="", APP_ENV="development", ENABLE_CHAOS="1")
    worker_key = credential(env, "WORKER_API_KEY")
    operator_key = credential(env, "OPERATOR_API_KEY")
    credential(env, "PIPELINE_TOKEN")

    with tempfile.TemporaryDirectory(prefix="crowdsentinel-") as state, ExitStack() as stack:
        api = start(
            stack,
            ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8080", "--no-access-log"],
            ROOT / "api",
            env,
        )
        for _ in range(60):
            if api.poll() is not None:
                raise SystemExit("The API stopped during startup. Check its output above.")
            try:
                with urlopen(f"{URL}/readyz", timeout=0.5):
                    break
            except (URLError, TimeoutError):
                time.sleep(0.5)
        else:
            raise SystemExit("The API did not become ready.")

        workers = {}
        for zone in ZONES:
            worker_env = dict(
                env,
                ZONE=zone,
                POD_NAME=f"worker-{zone}",
                API_URL=URL,
                VIDEO=f"videos/{zone}.mp4",
                HEARTBEAT_FILE=str(Path(state) / zone),
                WORKER_API_KEY=worker_key,
            )
            if args.simulate_gate and zone == "gate":
                worker_env["SIM"] = "1"
            workers[zone] = (start(stack, ["worker.py"], ROOT / "worker", worker_env), worker_env)

        print(f"Open {URL} in your browser. Press Ctrl+C to stop.", flush=True)
        print(f"Operator sign-in: username operator, password {operator_key}", flush=True)

        while api.poll() is None:
            for zone, (worker, worker_env) in workers.items():
                if worker.poll() == 137:
                    print(f"Restarting the {zone} camera after the crash drill.", flush=True)
                    workers[zone] = (start(stack, ["worker.py"], ROOT / "worker", worker_env), worker_env)
                elif worker.returncode is not None:
                    raise SystemExit(f"The {zone} worker stopped. Check its output above.")
            time.sleep(0.5)
        raise SystemExit("The API stopped. Check its output above.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
