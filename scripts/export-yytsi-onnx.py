"""Export the Yytsi floorplan-to-3d ResNet34-UNet to ONNX.

Requirements:
    pip install --user torch torchvision --index-url https://download.pytorch.org/whl/cpu
    pip install --user segmentation-models-pytorch safetensors onnx

Usage:
    python scripts/export-yytsi-onnx.py --weights debug/models/yytsi-best.safetensors --out debug/models/yytsi-floorplan.onnx
"""

from __future__ import annotations

import argparse
from pathlib import Path

import onnx
import segmentation_models_pytorch as smp
import torch
from safetensors.torch import load_file


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--size", default=512, type=int)
    args = parser.parse_args()

    model = smp.Unet(
        encoder_name="resnet34",
        encoder_weights=None,
        in_channels=3,
        classes=4,
    )
    state = load_file(str(args.weights))
    model.load_state_dict(state)
    model.eval()

    dummy = torch.randn(1, 3, args.size, args.size)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        dummy,
        str(args.out),
        input_names=["images"],
        output_names=["logits"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    onnx.checker.check_model(onnx.load(str(args.out)))
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
