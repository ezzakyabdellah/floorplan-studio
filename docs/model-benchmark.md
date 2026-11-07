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
| current | plan01 | 800 ms | 10.2 | 0.9 | 1.6 | 11 | 9 | 99.9% | 100% | 0 |
| Yytsi | plan01 | 532 ms | 2.6 | 0.5 | 0.0 | 46 | 5 | 98.9% | 100% | 5 |
| **OpenBIM (stretch)** | plan01 | **510 ms** | 10.5 | 0.9 | 1.7 | 11 | 9 | **100%** | 100% | **0** |
| current | plan02 | 924 ms | 6.3 | 0.4 | 0.8 | 24 | 11 | 99.0% | 99% | 2 |
| Yytsi | plan02 | 547 ms | 0.3 | 3.8 | 1.0 | 3 | 3 | 47.8% | 100% | 37 |
| **OpenBIM (stretch)** | plan02 | **516 ms** | 10.5 | 0.7 | 1.4 | 22 | 12 | 98.4% | **100%** | **0** |

## Conclusion

- **Yytsi is faster but not better for these raster/scanned inputs.** It detects walls well on the clean plan (`plan01`) but misses all windows there, and collapses on the scanned `plan02` (walls classified as doors). It matches the model card limitation: trained on clean CubiCasa5K SVG renderings, not scans/photos.
- **OpenBIM M2-DA is the strongest option tested** once it uses its native **stretch** preprocessing (not the app's letterbox):
  - matches or beats the current model on coverage/precision on both samples
  - **0 missing openings** on both samples (current: 0 and 2)
  - roughly 40% faster
- The big win came from **preprocessing**, not from Python itself: OpenBIM expects a stretched 512×512 input, while the app was letterboxing it. The adapter now supports `letterbox` and `stretch` per model.
- **Current model remains the default** only because it has more validation history. OpenBIM is the recommended candidate to switch to after testing a few more plans.
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
