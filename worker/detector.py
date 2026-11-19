"""YOLOv8n person detector running on ONNX Runtime (CPU). No PyTorch needed."""
from __future__ import annotations

import os
import time

import cv2
import numpy as np
import onnxruntime as ort

PERSON = 0  # COCO class id for "person"


class PersonDetector:
    def __init__(self, model_path: str, conf: float = 0.35, iou: float = 0.45, size: int = 640):
        opts = ort.SessionOptions()
        threads = int(os.getenv("INFER_THREADS", "1"))
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.conf = conf
        self.iou = iou
        self.size = size
        self.last_ms = 0.0

    def _letterbox(self, frame: np.ndarray):
        h, w = frame.shape[:2]
        scale = min(self.size / h, self.size / w)
        nh, nw = int(round(h * scale)), int(round(w * scale))
        resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((self.size, self.size, 3), 114, dtype=np.uint8)
        top = (self.size - nh) // 2
        left = (self.size - nw) // 2
        canvas[top:top + nh, left:left + nw] = resized
        return canvas, scale, left, top

    def detect(self, frame: np.ndarray) -> list[tuple[float, float, float, float, float]]:
        """Return person boxes as (x1, y1, x2, y2, score) in pixel coordinates of `frame`."""
        t0 = time.perf_counter()
        img, scale, left, top = self._letterbox(frame)
        blob = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out = self.session.run(None, {self.input_name: blob})[0][0]  # (84, 8400)
        preds = out.T                                                # (8400, 84)
        scores = preds[:, 4 + PERSON]
        keep = scores > self.conf
        preds, scores = preds[keep], scores[keep]
        if len(preds) == 0:
            self.last_ms = (time.perf_counter() - t0) * 1000
            return []
        cx, cy, bw, bh = preds[:, 0], preds[:, 1], preds[:, 2], preds[:, 3]
        x1 = (cx - bw / 2 - left) / scale
        y1 = (cy - bh / 2 - top) / scale
        boxes_xywh = np.stack([x1, y1, bw / scale, bh / scale], axis=1)
        idx = cv2.dnn.NMSBoxes(boxes_xywh.tolist(), scores.tolist(), self.conf, self.iou)
        idx = np.array(idx).reshape(-1) if len(idx) else []
        h, w = frame.shape[:2]
        dets = []
        for i in idx:
            x, y, bw_, bh_ = boxes_xywh[i]
            dets.append((max(0.0, float(x)), max(0.0, float(y)),
                         min(float(w), float(x + bw_)), min(float(h), float(y + bh_)), float(scores[i])))
        self.last_ms = (time.perf_counter() - t0) * 1000
        return dets
