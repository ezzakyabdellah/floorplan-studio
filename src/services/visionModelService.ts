import {
  DEFAULTS,
  type Opening,
  type OpeningType,
  type Wall,
} from "../types/floorplan";
import {
  loadImageFromFile,
  vectorizeFloorPlanImage,
  type ImageVectorOptions,
  type VectorizedPlan,
} from "../utils/imageToVector";
import {
  distanceToSegment,
  projectPointOnWall,
  wallLength,
} from "../utils/geometry";

export const VISION_INPUT_SIZE = 640;
export const VISION_MODEL_URL =
  (import.meta.env.VITE_FLOORPLAN_ONNX_MODEL as string | undefined)?.trim() ||
  "/models/floorplan-layout.onnx";

export type VisionModelAvailability = {
  available: boolean;
  url: string;
  reason?: string;
};

export type VisionSource = "onnx" | "heuristic";

export type VisionExtractionOptions = ImageVectorOptions & {
  preferHeuristic?: boolean;
  allowFallback?: boolean;
  debug?: (event: VisionDebugEvent) => void;
  signal?: AbortSignal;
};

export type VisionExtractionResult = VectorizedPlan & {
  source: VisionSource;
  modelUrl: string;
  inferenceMs: number;
  fallbackReason?: string;
};

export type VisionOutputMap = Record<
  string,
  { data: Float32Array | Uint8Array; dims: readonly number[] }
>;

export type VisionDebugEvent =
  | { stage: "availability"; availability: VisionModelAvailability }
  | {
      stage: "input";
      inputName: string;
      dims: readonly number[];
      transform: ImageTransform;
      stats: { min: number; max: number };
    }
  | {
      stage: "output";
      name: string;
      dims: readonly number[];
      stats: { min: number; max: number };
    }
  | {
      stage: "detections";
      output: string;
      parsed: boolean;
      detectionCount: number;
      classCount: number;
    }
  | {
      stage: "detectionSegments";
      segmentCount: number;
      openingCount: number;
      segments: PixelSegment[];
      openings: PixelOpening[];
    }
  | {
      stage: "segmentation";
      channels: number;
      width: number;
      height: number;
      segmentCount: number;
      openingCount: number;
      segments: PixelSegment[];
      openings: PixelOpening[];
    }
  | {
      stage: "plan";
      wallCount: number;
      openingCount: number;
      worldWidth: number;
      worldHeight: number;
      walls: Wall[];
      openings: Opening[];
    };

type OrtModule = typeof import("onnxruntime-web");
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

export type ImageTransform = {
  imageWidth: number;
  imageHeight: number;
  scale: number;
  padX: number;
  padY: number;
};

export type Orientation = "h" | "v";

export type PixelSegment = {
  orientation: Orientation;
  start: number;
  end: number;
  center: number;
  thickness: number;
};

export type PixelOpening = {
  type: OpeningType;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  score: number;
};

export type Detection = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  classId: number;
  score: number;
};

export type ParsedDetections = {
  detections: Detection[];
  classCount: number;
};

let availabilityPromise: Promise<VisionModelAvailability> | null = null;
let ortPromise: Promise<OrtModule> | null = null;
let sessionPromise: Promise<OrtSession> | null = null;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException("Vision extraction was cancelled.", "AbortError");
  }
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function emitDebug(
  debug: VisionExtractionOptions["debug"],
  event: VisionDebugEvent,
) {
  if (!debug) return;
  try {
    debug(event);
  } catch {
    // Debug logging must never break extraction.
  }
}

// The model is optional so the app still works before large weights are added.
async function probeModel(url: string): Promise<VisionModelAvailability> {
  try {
    // A ranged GET works with both Vite and the Tauri asset protocol. The body
    // is cancelled immediately so large weights are never downloaded twice.
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
    });
    await response.body?.cancel();

    if (!response.ok) {
      return {
        available: false,
        url,
        reason: `Vision model not found at ${url} (HTTP ${response.status}).`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      return {
        available: false,
        url,
        reason: `Vision model not found at ${url}.`,
      };
    }

    return { available: true, url };
  } catch (error) {
    return {
      available: false,
      url,
      reason: errorMessage(error, "Could not check for the local vision model."),
    };
  }
}

export function checkVisionModelAvailability(
  force = false,
): Promise<VisionModelAvailability> {
  if (force) availabilityPromise = null;
  availabilityPromise ??= probeModel(VISION_MODEL_URL);
  return availabilityPromise;
}

async function loadOrt(): Promise<OrtModule> {
  ortPromise ??= (async () => {
    const [ort, { default: wasmUrl }, { default: mjsUrl }] = await Promise.all([
      import("onnxruntime-web/wasm"),
      import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url"),
      import("onnxruntime-web/ort-wasm-simd-threaded.mjs?url"),
    ]);

    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = {
      wasm: new URL(wasmUrl, window.location.href).href,
      mjs: new URL(mjsUrl, window.location.href).href,
    };

    return ort;
  })();

  return ortPromise;
}

async function loadSession(signal?: AbortSignal): Promise<OrtSession> {
  throwIfAborted(signal);

  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt();
      return ort.InferenceSession.create(VISION_MODEL_URL, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }

  return sessionPromise;
}

export function letterboxTransform(
  width: number,
  height: number,
): ImageTransform {
  const scale = Math.min(
    VISION_INPUT_SIZE / Math.max(1, width),
    VISION_INPUT_SIZE / Math.max(1, height),
  );

  return {
    imageWidth: width,
    imageHeight: height,
    scale,
    padX: (VISION_INPUT_SIZE - width * scale) / 2,
    padY: (VISION_INPUT_SIZE - height * scale) / 2,
  };
}

function modelToImageX(x: number, transform: ImageTransform) {
  return (x - transform.padX) / transform.scale;
}

function modelToImageY(y: number, transform: ImageTransform) {
  return (y - transform.padY) / transform.scale;
}

// Convert an interleaved 640x640 RGB/RGBA buffer into a normalized CHW tensor.
export function planarFloat32FromPixels(
  pixels: ArrayLike<number>,
  channels: 3 | 4,
  size = VISION_INPUT_SIZE,
  signal?: AbortSignal,
): Float32Array {
  const plane = size * size;
  const values = new Float32Array(plane * 3);

  for (let index = 0; index < plane; index += 1) {
    const pixel = index * channels;
    values[index] = Number(pixels[pixel]) / 255;
    values[plane + index] = Number(pixels[pixel + 1]) / 255;
    values[plane * 2 + index] = Number(pixels[pixel + 2]) / 255;
    if ((index & 65535) === 0) throwIfAborted(signal);
  }

  return values;
}

// Letterbox to 640x640 and normalize RGB values into a CHW float tensor.
async function buildInputTensor(
  image: HTMLImageElement,
  ort: OrtModule,
  signal?: AbortSignal,
) {
  const transform = letterboxTransform(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = VISION_INPUT_SIZE;
  canvas.height = VISION_INPUT_SIZE;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is not available.");

  context.fillStyle = "rgb(114, 114, 114)";
  context.fillRect(0, 0, VISION_INPUT_SIZE, VISION_INPUT_SIZE);
  context.drawImage(
    image,
    transform.padX,
    transform.padY,
    image.naturalWidth * transform.scale,
    image.naturalHeight * transform.scale,
  );

  const { data } = context.getImageData(
    0,
    0,
    VISION_INPUT_SIZE,
    VISION_INPUT_SIZE,
  );
  const values = planarFloat32FromPixels(
    data,
    4,
    VISION_INPUT_SIZE,
    signal,
  );

  return {
    transform,
    tensor: new ort.Tensor("float32", values, [
      1,
      3,
      VISION_INPUT_SIZE,
      VISION_INPUT_SIZE,
    ]),
  };
}

function tensorStats(data: Float32Array | Uint8Array | number[]) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < data.length; index += 1) {
    const value = Number(data[index]);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function readTensorValue(
  data: Float32Array | Uint8Array | number[],
  index: number,
) {
  return Number(data[index]);
}

// Accept YOLO-style detections in either [1, attributes, boxes] or
// [1, boxes, attributes] layout, with normalized or pixel coordinates.
export function parseDetections(
  data: Float32Array | Uint8Array | number[],
  dims: readonly number[],
): ParsedDetections | null {
  if (dims.length < 2 || dims.length > 3) return null;
  if (dims.length === 3 && dims[0] !== 1) return null;

  const second = dims[dims.length - 2];
  const last = dims[dims.length - 1];

  let attributes = 0;
  let count = 0;
  let attributesFirst = false;

  if (second <= 200 && last > second) {
    attributes = second;
    count = last;
    attributesFirst = true;
  } else if (last <= 200 && second > last) {
    attributes = last;
    count = second;
  } else {
    return null;
  }

  if (attributes < 6 || attributes > 200 || count <= 0) return null;

  const valueAt = (box: number, attribute: number) =>
    attributesFirst
      ? readTensorValue(data, attribute * count + box)
      : readTensorValue(data, box * attributes + attribute);

  const maxCoordinate = (() => {
    let max = 0;
    const samples = Math.min(count, 40);
    for (let box = 0; box < samples; box += 1) {
      for (let attribute = 0; attribute < 4; attribute += 1) {
        max = Math.max(max, Math.abs(valueAt(box, attribute)));
      }
    }
    return max;
  })();

  const normalized = maxCoordinate <= 2.5;
  const coordinateScale = normalized ? VISION_INPUT_SIZE : 1;
  const boxes: Detection[] = [];
  let classCount = 1;

  for (let box = 0; box < count; box += 1) {
    const a = valueAt(box, 0) * coordinateScale;
    const b = valueAt(box, 1) * coordinateScale;
    const c = valueAt(box, 2) * coordinateScale;
    const d = valueAt(box, 3) * coordinateScale;

    let score = 0;
    let classId = 0;

    if (attributes === 6) {
      const rawScore = valueAt(box, 4);
      const rawClass = valueAt(box, 5);
      score = rawScore <= 1.5 ? rawScore : 1;
      classId = Math.max(0, Math.round(rawClass));
      classCount = Math.max(classCount, classId + 1);
    } else {
      const classStart = attributes >= 8 ? 5 : 4;
      classCount = Math.max(classCount, attributes - classStart);
      for (let index = classStart; index < attributes; index += 1) {
        const value = valueAt(box, index);
        if (value > score) {
          score = value;
          classId = index - classStart;
        }
      }
      if (attributes >= 8) score *= valueAt(box, 4);
    }

    if (score < 0.25) continue;

    const isXyxy = c > a && d > b && c <= VISION_INPUT_SIZE * 1.25;
    const x1 = isXyxy ? a : a - c / 2;
    const y1 = isXyxy ? b : b - d / 2;
    const x2 = isXyxy ? c : a + c / 2;
    const y2 = isXyxy ? d : b + d / 2;

    boxes.push({
      x1: clamp(Math.min(x1, x2), 0, VISION_INPUT_SIZE),
      y1: clamp(Math.min(y1, y2), 0, VISION_INPUT_SIZE),
      x2: clamp(Math.max(x1, x2), 0, VISION_INPUT_SIZE),
      y2: clamp(Math.max(y1, y2), 0, VISION_INPUT_SIZE),
      classId,
      score,
    });
  }

  return boxes.length > 0 ? { detections: boxes, classCount } : null;
}

export function classRole(
  classId: number,
  classCount: number,
): "wall" | OpeningType | null {
  if (classCount <= 3) {
    if (classId === 0) return "wall";
    if (classId === 1) return "door";
    if (classId === 2) return "window";
    return null;
  }

  if (classId === 1) return "wall";
  if (classId === 2) return "door";
  if (classId === 3) return "window";
  return null;
}

export function detectionSegments(
  detections: Detection[],
  classCount: number,
  transform: ImageTransform,
  feetPerPixel: number,
) {
  const segments: PixelSegment[] = [];
  const openings: PixelOpening[] = [];

  for (const detection of detections) {
    const role = classRole(detection.classId, classCount);
    if (!role) continue;

    const widthPx = detection.x2 - detection.x1;
    const heightPx = detection.y2 - detection.y1;
    if (widthPx < 2 || heightPx < 2) continue;

    if (role === "wall") {
      if (widthPx >= heightPx) {
        const start = modelToImageX(detection.x1, transform);
        const end = modelToImageX(detection.x2, transform);
        const center = modelToImageY(
          (detection.y1 + detection.y2) / 2,
          transform,
        );
        if (end - start >= 4) {
          segments.push({
            orientation: "h",
            start: Math.min(start, end),
            end: Math.max(start, end),
            center,
            thickness: heightPx / transform.scale,
          });
        }
      } else {
        const start = modelToImageY(detection.y1, transform);
        const end = modelToImageY(detection.y2, transform);
        const center = modelToImageX(
          (detection.x1 + detection.x2) / 2,
          transform,
        );
        if (end - start >= 4) {
          segments.push({
            orientation: "v",
            start: Math.min(start, end),
            end: Math.max(start, end),
            center,
            thickness: widthPx / transform.scale,
          });
        }
      }
      continue;
    }

    openings.push({
      type: role,
      minX: modelToImageX(detection.x1, transform),
      minY: modelToImageY(detection.y1, transform),
      maxX: modelToImageX(detection.x2, transform),
      maxY: modelToImageY(detection.y2, transform),
      score: detection.score,
    });
  }

  const minWallThickness = Math.max(2, Math.round(0.35 / feetPerPixel));
  return {
    segments: segments.filter(
      (segment) => segment.thickness >= minWallThickness * 0.25,
    ),
    openings,
  };
}

function findRowRuns(
  mask: Uint8Array,
  width: number,
  y: number,
  minRun: number,
) {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  let end = -1;
  let gap = 0;
  const maxGap = 3;
  const offset = y * width;

  for (let x = 0; x < width; x += 1) {
    if (mask[offset + x]) {
      if (start < 0) start = x;
      end = x + 1;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap > maxGap) {
        if (end - start >= minRun) runs.push({ start, end });
        start = -1;
        end = -1;
        gap = 0;
      }
    }
  }

  if (start >= 0 && end - start >= minRun) {
    runs.push({ start, end });
  }

  return runs;
}

function findColumnRuns(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  minRun: number,
) {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  let end = -1;
  let gap = 0;
  const maxGap = 3;

  for (let y = 0; y < height; y += 1) {
    if (mask[y * width + x]) {
      if (start < 0) start = y;
      end = y + 1;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap > maxGap) {
        if (end - start >= minRun) runs.push({ start, end });
        start = -1;
        end = -1;
        gap = 0;
      }
    }
  }

  if (start >= 0 && end - start >= minRun) {
    runs.push({ start, end });
  }

  return runs;
}

type Band = {
  start: number;
  end: number;
  first: number;
  last: number;
  lastStep: number;
};

function finishBand(
  band: Band,
  orientation: Orientation,
  segments: PixelSegment[],
) {
  const length = band.end - band.start;
  const thickness = band.last - band.first + 1;
  // A wall is elongated: reject the perpendicular pass, which can mistake a
  // thick wall's cross-section (e.g. 20 px) for a long segment.
  if (length < 8 || thickness > 96 || length < thickness * 1.5) return;
  segments.push({
    orientation,
    start: band.start,
    end: band.end,
    center: (band.first + band.last) / 2,
    thickness,
  });
}

function maskToSegments(mask: Uint8Array, width: number, height: number) {
  const horizontal: PixelSegment[] = [];
  let active: Band[] = [];

  for (let y = 0; y < height; y += 1) {
    const runs = findRowRuns(mask, width, y, 8);
    const matched = new Set<number>();

    for (const run of runs) {
      let bestIndex = -1;
      let bestOverlap = 0;
      for (let index = 0; index < active.length; index += 1) {
        if (matched.has(index)) continue;
        const band = active[index];
        if (y - band.lastStep > 3) continue;
        const bandLength = band.end - band.start;
        const runLength = run.end - run.start;
        const overlap =
          Math.min(band.end, run.end) - Math.max(band.start, run.start);
        const shortest = Math.min(bandLength, runLength);
        const longest = Math.max(bandLength, runLength);
        if (
          shortest >= longest * 0.5 &&
          overlap >= Math.max(2, shortest * 0.55) &&
          overlap > bestOverlap
        ) {
          bestIndex = index;
          bestOverlap = overlap;
        }
      }

      if (bestIndex >= 0) {
        const band = active[bestIndex];
        band.start = Math.min(band.start, run.start);
        band.end = Math.max(band.end, run.end);
        band.last = y;
        band.lastStep = y;
        matched.add(bestIndex);
      } else {
        active.push({
          start: run.start,
          end: run.end,
          first: y,
          last: y,
          lastStep: y,
        });
        matched.add(active.length - 1);
      }
    }

    active = active.filter((band) => {
      if (y - band.lastStep <= 3) return true;
      finishBand(band, "h", horizontal);
      return false;
    });
  }

  for (const band of active) finishBand(band, "h", horizontal);

  const vertical: PixelSegment[] = [];
  active = [];

  for (let x = 0; x < width; x += 1) {
    const runs = findColumnRuns(mask, width, height, x, 8);
    const matched = new Set<number>();

    for (const run of runs) {
      let bestIndex = -1;
      let bestOverlap = 0;
      for (let index = 0; index < active.length; index += 1) {
        if (matched.has(index)) continue;
        const band = active[index];
        if (x - band.lastStep > 3) continue;
        const bandLength = band.end - band.start;
        const runLength = run.end - run.start;
        const overlap =
          Math.min(band.end, run.end) - Math.max(band.start, run.start);
        const shortest = Math.min(bandLength, runLength);
        const longest = Math.max(bandLength, runLength);
        if (
          shortest >= longest * 0.5 &&
          overlap >= Math.max(2, shortest * 0.55) &&
          overlap > bestOverlap
        ) {
          bestIndex = index;
          bestOverlap = overlap;
        }
      }

      if (bestIndex >= 0) {
        const band = active[bestIndex];
        band.start = Math.min(band.start, run.start);
        band.end = Math.max(band.end, run.end);
        band.last = x;
        band.lastStep = x;
        matched.add(bestIndex);
      } else {
        active.push({
          start: run.start,
          end: run.end,
          first: x,
          last: x,
          lastStep: x,
        });
        matched.add(active.length - 1);
      }
    }

    active = active.filter((band) => {
      if (x - band.lastStep <= 3) return true;
      finishBand(band, "v", vertical);
      return false;
    });
  }

  for (const band of active) finishBand(band, "v", vertical);

  return [...horizontal, ...vertical];
}

function mergePixelSegments(segments: PixelSegment[]) {
  const sorted = [...segments].sort(
    (a, b) =>
      a.orientation.localeCompare(b.orientation) ||
      a.center - b.center ||
      a.start - b.start,
  );
  const merged: PixelSegment[] = [];

  for (const segment of sorted) {
    let target: PixelSegment | null = null;

    for (const candidate of merged) {
      if (candidate.orientation !== segment.orientation) continue;
      const tolerance = Math.max(8, (candidate.thickness + segment.thickness) / 2);
      if (Math.abs(candidate.center - segment.center) > tolerance) continue;
      if (
        segment.start <= candidate.end + 18 &&
        segment.end >= candidate.start - 18
      ) {
        target = candidate;
        break;
      }
    }

    if (!target) {
      merged.push({ ...segment });
      continue;
    }

    const lengthA = target.end - target.start;
    const lengthB = segment.end - segment.start;
    target.center =
      (target.center * lengthA + segment.center * lengthB) /
      Math.max(1, lengthA + lengthB);
    target.start = Math.min(target.start, segment.start);
    target.end = Math.max(target.end, segment.end);
    target.thickness = Math.max(target.thickness, segment.thickness);
  }

  return merged;
}

function componentBoxes(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
  score: number,
) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const boxes: PixelOpening[] = [];

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;

    let head = 0;
    let tail = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    queue[tail] = index;
    tail += 1;
    visited[index] = 1;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue[tail] = neighbor;
            tail += 1;
          }
        }
      }
    }

    if (tail >= minArea) {
      boxes.push({
        type: "door",
        minX,
        minY,
        maxX: maxX + 1,
        maxY: maxY + 1,
        score,
      });
    }
  }

  return boxes;
}

// Segmentation models output [1, classes, height, width] logits or one mask.
export function segmentationOutputs(
  outputs: Record<string, { data: Float32Array | Uint8Array; dims: readonly number[] }>,
) {
  for (const tensor of Object.values(outputs)) {
    const dims = tensor.dims;
    if (dims.length === 4 && dims[0] === 1 && dims[2] >= 32 && dims[3] >= 32) {
      return {
        data: tensor.data,
        channels: dims[1],
        height: dims[2],
        width: dims[3],
        channelsFirst: true,
      };
    }

    if (
      dims.length === 3 &&
      dims[1] >= 32 &&
      dims[2] >= 32 &&
      dims[0] <= 32
    ) {
      return {
        data: tensor.data,
        channels: dims[0],
        height: dims[1],
        width: dims[2],
        channelsFirst: true,
      };
    }

    if (dims.length === 3 && dims[0] === 1 && dims[1] >= 32 && dims[2] >= 32) {
      return {
        data: tensor.data,
        channels: 1,
        height: dims[1],
        width: dims[2],
        channelsFirst: true,
      };
    }
  }

  return null;
}

export function segmentationToMasks(
  data: Float32Array | Uint8Array,
  channels: number,
  width: number,
  height: number,
) {
  const plane = width * height;
  const stats = tensorStats(data);
  const threshold = stats.min < -0.05 || stats.max > 1.5 ? 0 : 0.5;
  const masks = Array.from(
    { length: channels },
    () => new Uint8Array(plane),
  );
  const pixels = new Uint8Array(plane);

  if (channels === 1) {
    for (let index = 0; index < plane; index += 1) {
      pixels[index] = readTensorValue(data, index) > threshold ? 1 : 0;
    }
    masks[0] = pixels;
    return masks;
  }

  for (let index = 0; index < plane; index += 1) {
    let bestChannel = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = readTensorValue(data, channel * plane + index);
      if (value > bestValue) {
        bestValue = value;
        bestChannel = channel;
      }
    }
    pixels[index] = bestChannel;
  }

  for (let channel = 0; channel < channels; channel += 1) {
    const mask = masks[channel];
    for (let index = 0; index < plane; index += 1) {
      mask[index] = pixels[index] === channel ? 1 : 0;
    }
  }

  return masks;
}

export function segClassRole(
  classId: number,
  channels: number,
): "wall" | OpeningType | null {
  if (channels <= 3) {
    if (classId === 0) return "wall";
    if (classId === 1) return "door";
    if (classId === 2) return "window";
    return null;
  }

  if (classId === 1) return "wall";
  if (classId === 2) return "door";
  if (classId === 3) return "window";
  return null;
}

export function segmentationPlan(
  masks: Uint8Array[],
  channels: number,
  width: number,
  height: number,
  transform: ImageTransform,
  signal?: AbortSignal,
) {
  const segments: PixelSegment[] = [];
  const openings: PixelOpening[] = [];

  for (let channel = 0; channel < masks.length; channel += 1) {
    throwIfAborted(signal);
    const role = segClassRole(channel, channels);
    if (!role) continue;

    if (role === "wall") {
      segments.push(...maskToSegments(masks[channel], width, height));
      continue;
    }

    const components = componentBoxes(
      masks[channel],
      width,
      height,
      Math.max(24, Math.round(width * height * 0.00015)),
      0.75,
    );

    for (const component of components) {
      openings.push({
        ...component,
        type: role,
        minX: modelToImageX(component.minX, transform),
        maxX: modelToImageX(component.maxX, transform),
        minY: modelToImageY(component.minY, transform),
        maxY: modelToImageY(component.maxY, transform),
      });
    }
  }

  for (const segment of segments) {
    if (segment.orientation === "h") {
      segment.start = modelToImageX(segment.start, transform);
      segment.end = modelToImageX(segment.end, transform);
      segment.center = modelToImageY(segment.center, transform);
    } else {
      segment.start = modelToImageY(segment.start, transform);
      segment.end = modelToImageY(segment.end, transform);
      segment.center = modelToImageX(segment.center, transform);
    }
    segment.thickness /= transform.scale;
  }

  return { segments, openings };
}

function assignOpenings(
  walls: Wall[],
  pixelOpenings: PixelOpening[],
  feetPerPixel: number,
  offsetX: number,
  offsetY: number,
  margin: number,
) {
  const openings: Opening[] = [];
  const timestamp = Date.now();
  let index = 0;

  for (const opening of pixelOpenings) {
    const centerX =
      ((opening.minX + opening.maxX) / 2 - offsetX) * feetPerPixel + margin;
    const centerY =
      ((opening.minY + opening.maxY) / 2 - offsetY) * feetPerPixel + margin;

    let bestWall: Wall | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const wall of walls) {
      const distance = distanceToSegment({ x: centerX, y: centerY }, wall);
      const threshold = wall.thickness / 2 + Math.max(1.5, 3);
      if (distance <= threshold && distance < bestDistance) {
        bestWall = wall;
        bestDistance = distance;
      }
    }

    if (!bestWall) continue;

    const length = wallLength(bestWall);
    if (length <= 0.5) continue;

    const projection = projectPointOnWall(
      { x: centerX, y: centerY },
      bestWall,
    );
    const boxWidth = (opening.maxX - opening.minX) * feetPerPixel;
    const boxHeight = (opening.maxY - opening.minY) * feetPerPixel;
    const width = clamp(
      Math.max(boxWidth, boxHeight),
      1.5,
      Math.min(12, length * 0.9),
    );

    const halfNormalized = Math.min(0.45, width / length / 2);
    const positionOnWall = clamp(
      projection.t,
      halfNormalized,
      1 - halfNormalized,
    );

    const overlaps = openings.some((existing) => {
      if (existing.wallId !== bestWall?.id) return false;
      const distanceInFeet =
        Math.abs(existing.positionOnWall - positionOnWall) * length;
      return distanceInFeet < (existing.width + width) / 2 + 0.2;
    });
    if (overlaps) continue;

    openings.push({
      id: `vision-opening-${timestamp}-${index}`,
      wallId: bestWall.id,
      type: opening.type,
      positionOnWall,
      width,
    });
    index += 1;
  }

  return openings;
}

// Segmentation masks omit wall pixels at doors and windows, so a single wall
// arrives as two collinear stubs. Bridge those stubs back into one wall and let
// the detected opening cut the hole again.
function bridgeOpenings(
  segments: PixelSegment[],
  openings: PixelOpening[],
): PixelSegment[] {
  let result = [...segments];

  for (const opening of openings) {
    const width = opening.maxX - opening.minX;
    const height = opening.maxY - opening.minY;
    const orientation: Orientation = width >= height ? "h" : "v";
    const main =
      orientation === "h"
        ? (opening.minX + opening.maxX) / 2
        : (opening.minY + opening.maxY) / 2;
    const perp =
      orientation === "h"
        ? (opening.minY + opening.maxY) / 2
        : (opening.minX + opening.maxX) / 2;
    const span = Math.max(8, orientation === "h" ? width : height);
    const cross = Math.max(8, orientation === "h" ? height : width);
    const tolerance = Math.max(12, cross * 0.8);

    const candidates = result.filter(
      (segment) =>
        segment.orientation === orientation &&
        Math.abs(segment.center - perp) <= tolerance,
    );
    const left = candidates
      .filter((segment) => segment.end <= main + span * 0.5)
      .sort((a, b) => b.end - a.end)[0];
    const right = candidates
      .filter((segment) => segment.start >= main - span * 0.5)
      .sort((a, b) => a.start - b.start)[0];

    if (left && right && right.start - left.end <= span * 2) {
      const merged: PixelSegment = {
        orientation,
        start: Math.min(left.start, right.start),
        end: Math.max(left.end, right.end),
        center:
          (left.center * (left.end - left.start) +
            right.center * (right.end - right.start)) /
          Math.max(1, left.end - left.start + (right.end - right.start)),
        thickness: Math.max(left.thickness, right.thickness),
      };
      result = result.filter((segment) => segment !== left && segment !== right);
      result.push(merged);
      continue;
    }

    const only = left ?? right;
    if (!only) continue;

    if (only.end <= main + span * 0.5) {
      only.end = Math.max(only.end, main + span * 0.5 + 1);
    } else {
      only.start = Math.min(only.start, main - span * 0.5 - 1);
    }
  }

  return mergePixelSegments(result);
}

export function buildPlanFromSegments(
  rawSegments: PixelSegment[],
  pixelOpenings: PixelOpening[],
  feetPerPixel: number,
) {
  const merged = bridgeOpenings(mergePixelSegments(rawSegments), pixelOpenings);
  const segments = merged.filter(
    (segment) =>
      (segment.end - segment.start) * feetPerPixel >= 0.75 &&
      segment.thickness * feetPerPixel <= 8,
  );

  if (segments.length === 0) {
    throw new Error("The vision model did not return any usable wall geometry.");
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const segment of segments) {
    const half = segment.thickness / 2;
    if (segment.orientation === "h") {
      minX = Math.min(minX, segment.start);
      maxX = Math.max(maxX, segment.end);
      minY = Math.min(minY, segment.center - half);
      maxY = Math.max(maxY, segment.center + half);
    } else {
      minY = Math.min(minY, segment.start);
      maxY = Math.max(maxY, segment.end);
      minX = Math.min(minX, segment.center - half);
      maxX = Math.max(maxX, segment.center + half);
    }
  }

  const margin = 0.5;
  const timestamp = Date.now();
  const walls: Wall[] = segments.map((segment, index) => {
    // The mask paints walls wider than their architectural thickness, so use
    // the detected thickness only as a hint and clamp it to a sane range.
    const thickness = clamp(segment.thickness * feetPerPixel, 0.25, 0.75);
    const wallId = `vision-wall-${timestamp}-${index}`;

    if (segment.orientation === "h") {
      return {
        id: wallId,
        x1: (segment.start - minX) * feetPerPixel + margin,
        y1: (segment.center - minY) * feetPerPixel + margin,
        x2: (segment.end - minX) * feetPerPixel + margin,
        y2: (segment.center - minY) * feetPerPixel + margin,
        thickness,
        height: DEFAULTS.wallHeight,
      };
    }

    return {
      id: wallId,
      x1: (segment.center - minX) * feetPerPixel + margin,
      y1: (segment.start - minY) * feetPerPixel + margin,
      x2: (segment.center - minX) * feetPerPixel + margin,
      y2: (segment.end - minY) * feetPerPixel + margin,
      thickness,
      height: DEFAULTS.wallHeight,
    };
  });

  const openings = assignOpenings(
    walls,
    pixelOpenings,
    feetPerPixel,
    minX,
    minY,
    margin,
  );

  return {
    walls,
    openings,
    worldWidth: (maxX - minX) * feetPerPixel + margin * 2,
    worldHeight: (maxY - minY) * feetPerPixel + margin * 2,
  };
}

export type ProcessedVisionOutputs = {
  segments: PixelSegment[];
  openings: PixelOpening[];
  plan: ReturnType<typeof buildPlanFromSegments>;
  usedSegmentation: boolean;
};

/**
 * Converts raw ONNX output tensors into plan geometry. Shared by the live
 * inference path and the real-model integration test so both run identical
 * parsing, segmentation, and wall-building logic.
 */
export function processVisionOutputs(
  outputs: VisionOutputMap,
  transform: ImageTransform,
  feetPerPixel: number,
  options?: {
    debug?: VisionExtractionOptions["debug"];
    signal?: AbortSignal;
  },
): ProcessedVisionOutputs {
  let segments: PixelSegment[] = [];
  let pixelOpenings: PixelOpening[] = [];
  let usedSegmentation = false;

  for (const [outputName, output] of Object.entries(outputs)) {
    emitDebug(options?.debug, {
      stage: "output",
      name: outputName,
      dims: output.dims,
      stats: tensorStats(output.data),
    });

    const detectionOutput = parseDetections(output.data, output.dims);
    emitDebug(options?.debug, {
      stage: "detections",
      output: outputName,
      parsed: Boolean(detectionOutput),
      detectionCount: detectionOutput?.detections.length ?? 0,
      classCount: detectionOutput?.classCount ?? 0,
    });
    if (!detectionOutput) continue;

    const converted = detectionSegments(
      detectionOutput.detections,
      detectionOutput.classCount,
      transform,
      feetPerPixel,
    );
    emitDebug(options?.debug, {
      stage: "detectionSegments",
      segmentCount: converted.segments.length,
      openingCount: converted.openings.length,
      segments: converted.segments,
      openings: converted.openings,
    });
    segments = [...segments, ...converted.segments];
    pixelOpenings = [...pixelOpenings, ...converted.openings];
  }

  if (segments.length === 0) {
    const segmentation = segmentationOutputs(outputs);

    if (segmentation) {
      throwIfAborted(options?.signal);
      const masks = segmentationToMasks(
        segmentation.data,
        segmentation.channels,
        segmentation.width,
        segmentation.height,
      );
      const converted = segmentationPlan(
        masks,
        segmentation.channels,
        segmentation.width,
        segmentation.height,
        transform,
        options?.signal,
      );
      segments = converted.segments;
      pixelOpenings = converted.openings;
      usedSegmentation = true;
      emitDebug(options?.debug, {
        stage: "segmentation",
        channels: segmentation.channels,
        width: segmentation.width,
        height: segmentation.height,
        segmentCount: segments.length,
        openingCount: pixelOpenings.length,
        segments,
        openings: pixelOpenings,
      });
    }
  }

  if (segments.length === 0) {
    throw new Error(
      "The ONNX model returned no detectable walls. Check that the model outputs boxes or a wall segmentation mask.",
    );
  }

  const plan = buildPlanFromSegments(segments, pixelOpenings, feetPerPixel);
  emitDebug(options?.debug, {
    stage: "plan",
    wallCount: plan.walls.length,
    openingCount: plan.openings.length,
    worldWidth: plan.worldWidth,
    worldHeight: plan.worldHeight,
    walls: plan.walls,
    openings: plan.openings,
  });

  return { segments, openings: pixelOpenings, plan, usedSegmentation };
}

async function heuristicExtraction(
  file: File,
  options: VisionExtractionOptions,
  fallbackReason: string,
  startedAt: number,
): Promise<VisionExtractionResult> {
  const plan = await vectorizeFloorPlanImage(file, options);
  return {
    ...plan,
    source: "heuristic",
    modelUrl: VISION_MODEL_URL,
    inferenceMs: Math.max(0, performance.now() - startedAt),
    fallbackReason,
  };
}

async function onnxExtraction(
  file: File,
  options: VisionExtractionOptions,
  startedAt: number,
): Promise<VisionExtractionResult> {
  throwIfAborted(options.signal);

  const ort = await loadOrt();
  const session = await loadSession(options.signal);
  throwIfAborted(options.signal);

  const image = await loadImageFromFile(file);
  const { tensor, transform } = await buildInputTensor(
    image,
    ort,
    options.signal,
  );
  const inputName = session.inputNames[0];
  if (!inputName) {
    throw new Error("The ONNX model does not expose an input tensor.");
  }

  emitDebug(options.debug, {
    stage: "input",
    inputName,
    dims: tensor.dims,
    transform,
    stats: tensorStats(tensor.data as Float32Array),
  });

  const outputs = await session.run({ [inputName]: tensor });
  throwIfAborted(options.signal);

  const outputMap: VisionOutputMap = {};
  for (const [outputName, output] of Object.entries(outputs)) {
    outputMap[outputName] = {
      data: output.data as Float32Array | Uint8Array,
      dims: output.dims,
    };
  }

  const feetPerPixel = clamp(options.feetPer100Pixels, 1, 100) / 100;
  const { plan } = processVisionOutputs(outputMap, transform, feetPerPixel, {
    debug: options.debug,
    signal: options.signal,
  });

  return {
    ...plan,
    pixelWidth: image.naturalWidth,
    pixelHeight: image.naturalHeight,
    segmentCount: plan.walls.length,
    openingCount: plan.openings.length,
    source: "onnx",
    modelUrl: VISION_MODEL_URL,
    inferenceMs: Math.max(0, performance.now() - startedAt),
  };
}

export async function extractVectorsFromImage(
  file: File,
  options: VisionExtractionOptions,
): Promise<VisionExtractionResult> {
  const startedAt = performance.now();

  if (options.preferHeuristic) {
    return heuristicExtraction(
      file,
      options,
      "Heuristic vectorizer selected.",
      startedAt,
    );
  }

  const allowFallback = options.allowFallback !== false;
  const availability = await checkVisionModelAvailability();
  emitDebug(options.debug, { stage: "availability", availability });

  if (!availability.available) {
    const reason =
      availability.reason ?? "Local ONNX vision model is not available.";
    if (!allowFallback) throw new Error(reason);
    console.warn(`[vision] ${reason} Falling back to the heuristic vectorizer.`);
    return heuristicExtraction(file, options, reason, startedAt);
  }

  try {
    return await onnxExtraction(file, options, startedAt);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    const reason = `ONNX inference failed: ${errorMessage(error, "unknown error")}`;
    if (!allowFallback) throw new Error(reason);
    console.warn(`[vision] ${reason} Falling back to the heuristic vectorizer.`);
    return heuristicExtraction(file, options, reason, startedAt);
  }
}
