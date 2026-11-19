"""Kubernetes probe: healthy only if the worker processed a frame in the last few seconds."""
import os
import sys
import time
from pathlib import Path

path = Path(os.getenv("HEARTBEAT_FILE", "/tmp/heartbeat"))
max_age = float(sys.argv[1]) if len(sys.argv) > 1 else 6.0
try:
    age = time.time() - float(path.read_text())
except Exception:
    print("no heartbeat yet")
    sys.exit(1)
if age > max_age:
    print(f"heartbeat is {age:.1f}s old")
    sys.exit(1)
print(f"ok, heartbeat {age:.1f}s old")
