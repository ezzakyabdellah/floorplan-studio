"""Compare preprocessing/post-processing variants for the OpenBIM ONNX model.

This is an experiment harness, not part of the app runtime. It answers whether
Python-side CV preprocessing (annotation removal, dark-CAD inversion, opening
probability boosting) improves the segmentation on raster plans.

Requirements:
    pip install --user onnxruntime opencv-python-headless numpy

Usage:
    python scripts/python-floorplan-eval.py \
        --model debug/models/openbim-floorplan.onnx \
        --size 512
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# RGB colors used by the app's overlay
PALETTE_RGB = {
    1: (128, 138, 239),  # wall
    2: (162, 221, 119),  # door (OpenBIM class 3)
    3: (231, 188, 123),  # window (OpenBIM class 2)
}
# OpenBIM class order: 0 background, 1 wall, 2 window, 3 door
ROLE_BY_CLASS = {1: "wall", 2: "window", 3: "door"}
ROLE_COLOR_RGB = {
    "wall": (128, 138, 239),
    "door": (162, 221, 119),
    "window": (231, 188, 123),
}


def remove_annotations(img_bgr: np.ndarray):
    img_hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    ranges = [
        ((50, 60, 60), (85, 255, 255)),
        ((155, 60, 60), (175, 255, 255)),
        ((130, 60, 60), (155, 255, 255)),
        ((10, 80, 80), (35, 255, 255)),
        ((0, 120, 100), (10, 255, 255)),
        ((170, 120, 100), (180, 255, 255)),
    ]
    combined = np.zeros(img_bgr.shape[:2], dtype=np.uint8)
    for lo, hi in ranges:
        combined = cv2.bitwise_or(
            combined,
            cv2.inRange(img_hsv, np.array(lo), np.array(hi)),
        )
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    combined = cv2.dilate(combined, kernel, iterations=1)
    result = img_bgr.copy()
    result[combined > 0] = 0
    return result, combined


def preprocess_dark_cad(img_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    inverted = 255 - gray
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(inverted)
    _, binary = cv2.threshold(enhanced, 200, 255, cv2.THRESH_BINARY)
    result = cv2.addWeighted(enhanced, 0.4, binary, 0.6, 0)
    return cv2.cvtColor(result, cv2.COLOR_GRAY2RGB)


def letterbox(img_bgr: np.ndarray, size: int, pad=(114, 114, 114)):
    h, w = img_bgr.shape[:2]
    scale = min(size / w, size / h)
    new_w, new_h = max(1, round(w * scale)), max(1, round(h * scale))
    resized = cv2.resize(img_bgr, (new_w, new_h))
    canvas = np.full((size, size, 3), pad, dtype=np.uint8)
    left = (size - new_w) // 2
    top = (size - new_h) // 2
    canvas[top : top + new_h, left : left + new_w] = resized
    return canvas, (scale, left, top)


def stretch(img_bgr: np.ndarray, size: int):
    return cv2.resize(img_bgr, (size, size))


def to_tensor(img_rgb: np.ndarray) -> np.ndarray:
    x = img_rgb.astype(np.float32) / 255.0
    x = (x - MEAN) / STD
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None])


def postprocess(pred: np.ndarray, probs: np.ndarray):
    result = pred.copy()
    h, w = result.shape
    margin = 0.12
    mh, mw = int(h * margin), int(w * margin)
    edge = np.zeros((h, w), dtype=bool)
    edge[:mh, :] = True
    edge[-mh:, :] = True
    edge[:, :mw] = True
    edge[:, -mw:] = True

    wall = (result == 1).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(wall)
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        comp = labels == i
        edge_ratio = comp[edge].sum() / max(comp.sum(), 1)
        bw, bh = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        aspect = max(bw, bh) / max(min(bw, bh), 1)
        compactness = area / max(bw * bh, 1)
        if (edge_ratio > 0.7 and area < h * w * 0.01) or (
            aspect > 15 and compactness < 0.1
        ):
            result[comp] = 0

    result[(probs[2] > 0.15) & (result == 0)] = 2
    result[(probs[3] > 0.12) & (result == 0)] = 3
    return result


def overlay(img_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    base = cv2.cvtColor((gray * 0.45).astype(np.uint8), cv2.COLOR_GRAY2RGB)
    for cls, role in ROLE_BY_CLASS.items():
        base[mask == cls] = ROLE_COLOR_RGB[role]
    return cv2.cvtColor(base, cv2.COLOR_RGB2BGR)


def run_variant(session, img_bgr, size, mode):
    annotation_mask = None
    if mode == "openbim-full":
        cleaned, annotation_mask = remove_annotations(img_bgr)
        model_input = preprocess_dark_cad(cleaned)
        resized = stretch(model_input, size)
    elif mode == "remove-annotations":
        cleaned, annotation_mask = remove_annotations(img_bgr)
        resized = stretch(cv2.cvtColor(cleaned, cv2.COLOR_BGR2RGB), size)
    elif mode == "letterbox":
        resized, _ = letterbox(img_bgr, size)
        resized = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    else:
        resized = stretch(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB), size)

    tensor = to_tensor(resized)
    logits = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
    exp = np.exp(logits - logits.max(axis=0, keepdims=True))
    probs = exp / exp.sum(axis=0, keepdims=True)
    pred = probs.argmax(axis=0).astype(np.uint8)

    if mode in ("openbim-full", "remove-annotations"):
        pred = postprocess(pred, probs)

    # Resize back to original for overlay/report.
    pred_full = cv2.resize(
        pred, (img_bgr.shape[1], img_bgr.shape[0]), interpolation=cv2.INTER_NEAREST
    )
    total = pred_full.size
    stats = {
        role: round(float((pred_full == cls).sum()) / total * 100, 2)
        for cls, role in ROLE_BY_CLASS.items()
    }
    return pred_full, stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--size", default=512, type=int)
    parser.add_argument("--out", default=Path("debug/python"))
    parser.add_argument(
        "--samples",
        default="src/samples/plan01.jpeg,src/samples/plan02.jpeg",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    modes = ["stretch", "letterbox", "remove-annotations", "openbim-full"]

    for sample in args.samples.split(","):
        sample = Path(sample.strip())
        img = cv2.imread(str(sample))
        if img is None:
            raise SystemExit(f"cannot read {sample}")
        print(f"\n=== {sample.name} ===")
        for mode in modes:
            pred, stats = run_variant(session, img, args.size, mode)
            out = args.out / f"{sample.stem}-{mode}.png"
            cv2.imwrite(str(out), overlay(img, pred))
            print(f"{mode:20s}", stats, "->", out)


if __name__ == "__main__":
    main()
