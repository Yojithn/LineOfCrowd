import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.pop("REDIS_URL", None)
os.environ.update(APP_ENV="development", ENABLE_CHAOS="1", MODE="local",
                  WORKER_API_KEY="test-worker-key", OPERATOR_API_KEY="test-operator-key",
                  PIPELINE_TOKEN="test-pipeline-key", MAX_PERSON_COUNT="10000", MAX_FRAME_BYTES="524288")
