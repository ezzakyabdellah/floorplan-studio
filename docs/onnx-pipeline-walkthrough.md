# ONNX Pipeline Walkthrough (Beginner Guide)

This guide explains what each stage of the ONNX extraction pipeline outputs, using the real test run from `src/services/visionModelService.onnx.test.ts`.

The whole pipeline can be summarized as:

> **image → numbers → class scores → masks → line segments → walls in feet**

Reproduce the output with:

```bash
npm run test:onnx
```

---

## STEP 1 — Preprocess: image → tensor

```text
source image { width: 1195, height: 1203 }
letterbox { scale: 0.532, padX: 2.13, padY: 0 }
tensor { dims: [1,3,640,640], stats: { min: 0, max: 1, mean: 0.963 } }
```

- **source image**: the real JPEG size in pixels.
- **scale**: the image is shrunk (here to 53.2%) so it fits inside 640×640.
- **padX / padY**: gray padding added to keep the aspect ratio, so walls are not stretched.
- **dims `[1,3,640,640]`**: 1 image, 3 color channels (R, G, B), 640×640 pixels.
- **stats**: pixel values are divided by 255, so they range from 0 to 1. `mean 0.963` means the plan is mostly white paper.

A **tensor** is just a rectangular array of numbers that the model can read.

---

## STEP 2 — Inference: the model's raw output

```text
output tensor { name: 'logits', dims: [1,4,640,640] }
```

- **`logits`**: the model's raw scores. There are **4 channels**, meaning 4 possible classes per pixel: background, wall, door, window.
- For each pixel the model gives 4 numbers. Higher means more likely for that class. These are **not percentages**; they are raw scores.

### Per-channel scores

| channel | role | min | max | mean | aboveHalfPct |
| --- | --- | --- | --- | --- | --- |
| 0 | ignored | -2.885 | 17.981 | 5.916 | 93.1 |
| 1 | wall | -6.624 | 8.498 | -1.594 | 13.5 |
| 2 | door | -21.299 | 5.466 | -7.616 | 1.0 |
| 3 | window | -15.536 | 5.827 | -6.138 | 1.8 |

- **role**: what the app assumes each channel means (`0` = background/ignored, `1` = wall, `2` = door, `3` = window).
- **min / max / mean**: range and average of that channel's scores.
- **aboveHalfPct**: percentage of pixels whose score is above 0.5 — a rough "how much signal" indicator.

### Argmax class distribution

| class | role | pixels | pct |
| --- | --- | --- | --- |
| 0 | background/ignored | 357362 | 87.2 |
| 1 | wall | 41754 | 10.2 |
| 2 | door | 3742 | 0.9 |
| 3 | window | 6742 | 1.6 |

- **argmax** means "for each pixel, pick the channel with the highest score."
- The result says 87.2% of pixels are background, 10.2% are wall, and so on. This is the model's actual floor-plan segmentation.

---

## STEP 3 — `parseDetections`: the box path

```text
result null - 4D logits are a segmentation tensor, not boxes
```

- `parseDetections` expects an object-**detection** model that outputs **boxes** (like YOLO: `x1, y1, x2, y2, score, class`).
- Our model outputs a **4D mask** (`[1,4,640,640]`), so the function correctly returns `null`.
- This is not a failure — it means we must use the segmentation path instead.

---

## STEP 4 — `segmentationOutputs`: recognize the mask shape

```text
mask layout {
  channels: 4,
  width: 640,
  height: 640,
  layout: '[1, classes, height, width]'
}
```

This step confirms: "yes, this output is a segmentation mask with 4 classes on a 640×640 grid."

---

## STEP 5 — `segmentationToMasks`: scores → binary masks

| channel | role | pixels | bbox |
| --- | --- | --- | --- |
| 0 | ignored | 357362 | `0,0 -> 639,639` |
| 1 | wall | 41754 | `40,95 -> 601,539` |
| 2 | door | 3742 | `235,278 -> 418,467` |
| 3 | window | 6742 | `52,95 -> 545,539` |

- For every pixel, the winning class becomes `1` in that class's mask and `0` elsewhere. This produces four black-and-white images.
- **pixels**: how many pixels belong to that class.
- **bbox**: the smallest rectangle containing all pixels of that class.
  - For the wall mask, `40,95 -> 601,539` means all walls fit inside that box in the 640×640 model space.
  - This bbox is **not** a single wall — it is the extent of the whole class.

---

## STEP 6 — `segmentationPlan`: masks → line segments and opening boxes

```text
segments by orientation { h: 14, v: 20 }
openings by type { door: 5, window: 4 }
```

- **segments** are individual wall pieces. `h` = horizontal, `v` = vertical.
- **openings** are door/window boxes.

### First segments (original image pixels)

| orientation | start | end | center | thickness |
| --- | --- | --- | --- | --- |
| h | 462.16 | 518.55 | 178.57 | 1.88 |
| h | 93.74 | 298.63 | 196.43 | 37.59 |
| h | 945.24 | 1127.57 | 196.43 | 37.59 |
| h | 458.40 | 764.79 | 197.37 | 35.71 |

For a wall segment:

- **start / end**: where the wall begins and ends along its direction.
- **center**: its position across the other axis.
- **thickness**: how thick the wall mask is.

At this stage the coordinates are back in **original image pixels** (the letterbox padding and scale have been undone).

### First openings (original image pixels)

| type | minX | minY | maxX | maxY | score |
| --- | --- | --- | --- | --- | --- |
| door | 644.49 | 522.55 | 747.88 | 554.51 | 0.75 |
| door | 471.56 | 524.43 | 571.18 | 554.51 | 0.75 |
| window | 296.75 | 178.57 | 458.40 | 216.16 | 0.75 |
| window | 762.91 | 180.45 | 947.12 | 214.28 | 0.75 |

- **minX / minY / maxX / maxY**: the opening's bounding box in original image pixels.
- **score 0.75**: a fixed confidence assigned by this segmentation component step.
- Doors and windows are **not yet attached to walls** at this point.

---

## STEP 7 — `processVisionOutputs`: final plan data

```text
usedSegmentation true
```

The production pipeline used the segmentation branch, as expected.

### Walls (now in feet)

| id | x1 | y1 | x2 | y2 | thickness | height |
| --- | --- | --- | --- | --- | --- | --- |
| ...#0 | 0.688 | 2.380 | 104.071 | 2.380 | 0.75 | 8 |
| ...#1 | 0.688 | 36.453 | 103.883 | 36.453 | 0.75 | 8 |
| ...#5 | 2.672 | 0.687 | 2.672 | 70.800 | 0.75 | 8 |

- **x1,y1 → x2,y2**: the wall's endpoints in **feet**, not pixels.
- Example: wall `#0` is a ~103 ft horizontal wall at y = 2.38 ft.
- **thickness**: clamped to 0.25–0.75 ft.
- **height**: default 8 ft (the 3D extrusion height).
- Conversion uses `feetPerPixel = 0.1` in this test, i.e. 10 ft per 100 pixels.

### Openings assigned to walls

| id | wallId | type | positionOnWall | width |
| --- | --- | --- | --- | --- |
| ...#0 | ...#1 | door | 0.584 | 10.34 |
| ...#5 | ...#0 | window | 0.275 | 12.00 |

- **wallId**: which wall this door/window was snapped to.
- **positionOnWall**: `0` = start of the wall, `1` = end. `0.584` means about 58% along it.
- **width**: opening width in feet.

### World size

```text
world { width: 104.57, height: 84.83 }
```

The overall 2D floor-plan bounding box in feet (plus a 0.5 ft margin). The 3D view uses this to frame the scene.

---

## plan02.jpeg comparison

| stage | plan01.jpeg | plan02.jpeg |
| --- | --- | --- |
| source image | 1195 × 1203 | 2070 × 1187 |
| letterbox | scale 0.532, padX 2.13, padY 0 | scale 0.3092, padX 0, padY 136.5 |
| background pixels | 87.2% | 92.6% |
| wall pixels | 10.2% | 6.3% |
| door pixels | 0.9% | 0.4% |
| window pixels | 1.6% | 0.8% |
| segments | 34 (14 h / 20 v) | 62 (34 h / 28 v) |
| openings | 9 (5 doors / 4 windows) | 11 (5 doors / 6 windows) |
| world size | 104.57 × 84.83 ft | 193.12 × 104.57 ft |

---

## STEP 8 — Validation against the colored overlay

`src/services/planOverlayValidation.ts` compares the final plan with the colored overlay, which is the model's class map rendered as colors. It answers: *did the vectorization keep the walls and openings the model saw?*

How it works:

1. Decode the overlay back into classes: blue = wall, green = door, orange = window.
2. Rasterize the final plan walls/openings back into the 640×640 model space.
3. Measure the distance from every reference wall pixel to the nearest plan wall centerline.
   - within tolerance → covered
   - beyond tolerance → **missing wall**
4. Plan wall pixels far from any reference wall/door/window → **phantom wall**.
5. Reference door/window components with less than 35% coverage by plan openings → **missing opening**.

Output images:

- `debug/v_planNN_wall.png`, `debug/v_planNN_door.png`, `debug/v_planNN_window.png` — isolated class masks over the dimmed source image.
- `debug/v_planNN_attachments.png` — final door cuts in magenta and window cuts in cyan over the colored class map.
- `debug/v_planNN_validation.png` — wall/opening coverage and missing-geometry diagnostics.

| Color | Meaning |
| --- | --- |
| green | wall covered by the plan |
| red | missing wall pixels |
| orange | phantom wall pixels |
| blue | matched window |
| magenta | missing door/window |

The console report includes wall coverage, wall precision, missing wall regions (model + original-image bounding boxes), and missing openings.

The same class masks are also used to sanitize the plan before it is returned:

- wall runs that the mask shows but the vectorizer dropped are recovered and added
- openings are re-assigned against the cleaned wall set, so doors/windows that lost their supporting wall are restored
- walls not supported by the class map are dropped

Real results from the sample plans after sanitization:

| | plan01 | plan02 |
| --- | --- | --- |
| wall coverage | 100% | 99.9% |
| wall precision | 100% | 99.2% |
| missing openings | 0 | 0 |

Tuning options are passed to `validatePlanOverlay`: `wallTolerance` (default `14`), `openingTolerance` (default `6`), `phantomTolerance` (default `5`), and `minComponentPixels` (default `20`).

---

## Mental model of the whole run

1. **Image → tensor** — resize into 640×640 numbers.
2. **Model → logits** — 4 scores per pixel.
3. **Box parser → null** — wrong output type for boxes.
4. **Mask layout found** — 4-class segmentation.
5. **Scores → masks** — argmax makes binary wall/door/window masks.
6. **Masks → vectors** — thin wall masks become line segments; blobs become opening boxes.
7. **Vectors → plan** — convert to feet, snap openings to walls, build the final `Wall` / `Opening` data.
8. **Reconcile → sanitize** — use the raw class masks (the colored overlay's source) to recover missing wall runs, re-assign openings, and validate coverage.

The 3D view then extrudes the cleaned walls (height 8 ft) and cuts door/window holes using the assigned openings.

---

## Glossary

- **Tensor**: a multi-dimensional array of numbers; here `[1,3,640,640]` means 1 image × 3 RGB channels × 640 × 640 pixels.
- **Logits**: raw model scores before any softmax/probability conversion; higher means more likely.
- **Argmax**: at each pixel, choose the channel with the highest score.
- **Bounding box (bbox)**: the smallest rectangle that contains a set of pixels.
- **Segment**: one straight piece of wall, stored as orientation, start, end, center, and thickness.
- **Thickness**: the short side of a wall segment, i.e. how wide the wall is.
- **`feetPerPixel`**: conversion factor from image pixels to feet (`feetPer100Pixels / 100`; here `0.1`).
