# Floor Plan Model Benchmark

The pipeline now supports multiple ONNX segmentation models through a model config (input size, normalization, padding, class roles).

## Candidates

| Model | Architecture | Input | Classes | License | Status |
| --- | --- | --- | --- | --- | --- |
| Current `floorplan-layout.onnx` | 4-class segmentation, 640×640 | 640 | bg / wall / door / window | unknown | **kept as default** |
| [Yytsi/floorplan-to-3d-walls](https://huggingface.co/Yytsi/floorplan-to-3d-walls) | ResNet-34 U-Net | 512 | floor / wall / door / window | MIT | benchmarked |
| [OpenBIM-FloorPlan-AI](https://github.com/Chunling1/OpenBIM-FloorPlan-AI) | ResNet-34 U-Net, domain-adapted | 512 | bg / wall / window / door | MIT | benchmarked |

## Export Yytsi to ONNX

```bash
pip install --user torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install --user segmentation-models-pytorch safetensors onnx

curl -L -o debug/models/yytsi-best.safetensors \
  https://huggingface.co/Yytsi/floorplan-to-3d-walls/resolve/main/best.safetensors

python scripts/export-yytsi-onnx.py \
  --weights debug/models/yytsi-best.safetensors \
  --out debug/models/yytsi-floorplan.onnx
```

## Export OpenBIM M2-DA to ONNX

```bash
curl -L -o debug/models/openbim-best.pt \
  https://github.com/Chunling1/OpenBIM-FloorPlan-AI/releases/download/v1.0.0/M2_DA_FT_v2_best.pt

python scripts/export-openbim-onnx.py \
  --weights debug/models/openbim-best.pt \
  --out debug/models/openbim-floorplan.onnx
```

## Run the benchmark

```bash
npm run test:benchmark
```

Outputs are written to `debug/benchmark/`:

- `<model>-<plan>-overlay.png` — model class map
- `<model>-<plan>-walls.png` — vectorized walls
- `<model>-<plan>-validation.png` — plan vs overlay

## Results (real samples)

| Model | Plan | Inference | Wall % | Door % | Window % | Walls | Openings | Coverage | Precision | Missing openings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| current | plan01 | 800 ms | 10.2 | 0.9 | 1.6 | 9 | 9 | 100% | 100% | 0 |
| Yytsi | plan01 | 532 ms | 2.6 | 0.5 | 0.0 | 44 | 9 | 98.9% | 100% | 6 |
| **OpenBIM (stretch)** | plan01 | **510 ms** | 10.5 | 0.9 | 1.7 | 9 | 9 | **100%** | 100% | **0** |
| current | plan02 | 924 ms | 6.3 | 0.4 | 0.8 | 22 | 13 | 99.9% | 99.2% | 0 |
| Yytsi | plan02 | 547 ms | 0.3 | 3.8 | 1.0 | 3 | 7 | 54.2% | 100% | 36 |
| **OpenBIM (stretch)** | plan02 | **516 ms** | 10.5 | 0.7 | 1.4 | 22 | 12 | 98.9% | **100%** | 1 |

## Conclusion

- **Yytsi is faster but not better for these raster/scanned inputs.** It detects walls well on the clean plan (`plan01`) but misses all windows there, and collapses on the scanned `plan02` (walls classified as doors). It matches the model card limitation: trained on clean CubiCasa5K SVG renderings, not scans/photos.
- **OpenBIM M2-DA is a strong alternative** with its native **stretch** preprocessing: it has 100% wall precision on both samples and runs roughly 35–40% faster in the recorded measurements, though one opening is unmatched on `plan02`.
- After retaining small opening components and bridging wall stubs to their openings, the current model has **0 missing openings** on both samples. On scanned `plan02`, it has slightly higher wall coverage than OpenBIM (99.9% vs 98.9%); OpenBIM has higher precision (100% vs 99.2%).
- The speed/quality difference comes from both the model and preprocessing: OpenBIM expects a stretched 512×512 input, while the current model uses letterboxed 640×640. The adapter supports both per model.
- **Current remains the default** because it retains all sample openings and has higher wall coverage on the scan; OpenBIM remains a faster option with higher precision.
- The config adapter is in place, so switching models requires only an env var and the ONNX file; no code changes.

## Python vs TypeScript

Python does not make the same ONNX model more accurate — inference is identical. What Python is better for:

- **Experimentation:** quickly compare preprocessing/postprocessing variants with OpenCV/NumPy.
- **Training/fine-tuning:** PyTorch, segmentation-models-pytorch, custom datasets.
- **Heavy models:** Mask2Former, MitUNet, transformer backbones that are awkward in WASM.
- **Offline vectorization:** morphology, skeletonization, contour simplification.

`scripts/python-floorplan-eval.py` was used to compare preprocessing variants. The winner (OpenBIM's native stretch resize) was ported into the TypeScript adapter, so the app does **not** need a Python runtime. Use a Python sidecar only if you start training/fine-tuning or need heavy offline processing.

## Switching models

Set the preset via env:

```bash
VITE_FLOORPLAN_MODEL=yytsi
```

Presets live in `VISION_MODEL_PRESETS` in `src/services/visionModelService.ts`:

- `current` — 640, unit normalization, gray padding
- `yytsi` — 512, ImageNet normalization, padding `(124,116,104)`
- `openbim` — 512, ImageNet normalization, class order `1=wall, 2=window, 3=door`

Place the ONNX file at the preset URL (under `public/models/`) or override with `VITE_FLOORPLAN_ONNX_MODEL`.
