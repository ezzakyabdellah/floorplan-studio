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

export type VisionClassRole = "wall" | OpeningType | null;

export type VisionModelConfig = {
  url: string;
  inputSize: number;
  resizeMode: "letterbox" | "stretch";
  normalization: "unit" | "imagenet";
  padding: [number, number, number];
  classRoles: Record<number, VisionClassRole>;
};

export const VISION_MODEL_PRESETS: Record<string, VisionModelConfig> = {
  current: {
    url: "/models/floorplan-layout.onnx",
    inputSize: VISION_INPUT_SIZE,
    resizeMode: "letterbox",
    normalization: "unit",
    padding: [114, 114, 114],
    classRoles: { 0: null, 1: "wall", 2: "door", 3: "window" },
  },
  yytsi: {
    url: "/models/yytsi-floorplan.onnx",
    inputSize: 512,
    resizeMode: "letterbox",
    normalization: "imagenet",
    padding: [124, 116, 104],
    classRoles: { 0: null, 1: "wall", 2: "door", 3: "window" },
  },
  openbim: {
    url: "/models/openbim-floorplan.onnx",
    inputSize: 512,
    resizeMode: "stretch",
    normalization: "imagenet",
    padding: [114, 114, 114],
    classRoles: { 0: null, 1: "wall", 2: "window", 3: "door" },
  },
};

export function resolveVisionModelConfig(): VisionModelConfig {
  const presetName = (
    import.meta.env.VITE_FLOORPLAN_MODEL as string | undefined
  )?.trim();
  const preset =
    (presetName ? VISION_MODEL_PRESETS[presetName] : undefined) ??
    VISION_MODEL_PRESETS.current;
  const url =
    (import.meta.env.VITE_FLOORPLAN_ONNX_MODEL as string | undefined)?.trim() ||
    preset.url;
  return { ...preset, url };
}

export const VISION_MODEL_URL = resolveVisionModelConfig().url;

// Post-processing thresholds for the segmentation path.
const SEGMENTATION_CONFIDENCE_MARGIN = 0.5;
const MIN_WALL_THICKNESS_FEET = 0.1;
const MAX_PARALLEL_WALL_GAP_FEET = 1.5;
const MIN_PARALLEL_OVERLAP = 0.35;
const MIN_WALL_COMPONENT_RATIO = 0.00005;

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
      stage: "sanitize";
      droppedSegments: number;
      recoveredSegments: number;
    }
  | {
      stage: "planSanitize";
      recoveredWalls: number;
      recoveredOpenings: number;
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

export type PlanMeta = {
  minX: number;
  minY: number;
  margin: number;
  feetPerPixel: number;
};

export type ImageTransform = {
  imageWidth: number;
  imageHeight: number;
  scale: number;
  scaleX?: number;
  scaleY?: number;
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
  availabilityPromise ??= probeModel(resolveVisionModelConfig().url);
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
      return ort.InferenceSession.create(resolveVisionModelConfig().url, {
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
  inputSize = VISION_INPUT_SIZE,
): ImageTransform {
  const scale = Math.min(
    inputSize / Math.max(1, width),
    inputSize / Math.max(1, height),
  );

  return {
    imageWidth: width,
    imageHeight: height,
    scale,
    padX: (inputSize - width * scale) / 2,
    padY: (inputSize - height * scale) / 2,
  };
}

export function scaleX(transform: ImageTransform) {
  return transform.scaleX ?? transform.scale;
}

export function scaleY(transform: ImageTransform) {
  return transform.scaleY ?? transform.scale;
}

export function stretchTransform(
  width: number,
  height: number,
  inputSize = VISION_INPUT_SIZE,
): ImageTransform {
  const sx = inputSize / Math.max(1, width);
  const sy = inputSize / Math.max(1, height);
  return {
    imageWidth: width,
    imageHeight: height,
    scale: Math.min(sx, sy),
    scaleX: sx,
    scaleY: sy,
    padX: 0,
    padY: 0,
  };
}

function modelToImageX(x: number, transform: ImageTransform) {
  return (x - transform.padX) / scaleX(transform);
}

function modelToImageY(y: number, transform: ImageTransform) {
  return (y - transform.padY) / scaleY(transform);
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

export function normalizeChw(
  values: Float32Array,
  normalization: VisionModelConfig["normalization"],
): Float32Array {
  if (normalization === "unit") return values;

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const plane = values.length / 3;

  for (let channel = 0; channel < 3; channel += 1) {
    const offset = channel * plane;
    for (let index = 0; index < plane; index += 1) {
      values[offset + index] =
        (values[offset + index] - mean[channel]) / std[channel];
    }
  }

  return values;
}

// Letterbox to the configured input size and normalize into a CHW tensor.
async function buildInputTensor(
  image: HTMLImageElement,
  ort: OrtModule,
  config: VisionModelConfig,
  signal?: AbortSignal,
) {
  const size = config.inputSize;
  const transform =
    config.resizeMode === "stretch"
      ? stretchTransform(image.naturalWidth, image.naturalHeight, size)
      : letterboxTransform(image.naturalWidth, image.naturalHeight, size);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is not available.");

  if (config.resizeMode === "stretch") {
    context.drawImage(image, 0, 0, size, size);
  } else {
    const [r, g, b] = config.padding;
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillRect(0, 0, size, size);
    context.drawImage(
      image,
      transform.padX,
      transform.padY,
      image.naturalWidth * transform.scale,
      image.naturalHeight * transform.scale,
    );
  }

  const { data } = context.getImageData(0, 0, size, size);
  const values = normalizeChw(
    planarFloat32FromPixels(data, 4, size, signal),
    config.normalization,
  );

  return {
    transform,
    tensor: new ort.Tensor("float32", values, [1, 3, size, size]),
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
            thickness: heightPx / scaleY(transform),
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
            thickness: widthPx / scaleX(transform),
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

function drawLineMask(
  mask: Uint8Array,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
) {
  const radius = Math.max(0.75, thickness / 2);
  const radiusSq = radius * radius;
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const cx = x1 + (x2 - x1) * t;
    const cy = y1 + (y2 - y1) * t;
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radiusSq) {
          mask[y * width + x] = 1;
        }
      }
    }
  }
}

function drawModelSegment(
  mask: Uint8Array,
  width: number,
  height: number,
  segment: PixelSegment,
  thickness: number,
) {
  const x1 = segment.orientation === "h" ? segment.start : segment.center;
  const y1 = segment.orientation === "h" ? segment.center : segment.start;
  const x2 = segment.orientation === "h" ? segment.end : segment.center;
  const y2 = segment.orientation === "h" ? segment.center : segment.end;
  drawLineMask(mask, width, height, x1, y1, x2, y2, thickness);
}

function pointNearMask(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
) {
  const minX = Math.max(0, x - radius);
  const maxX = Math.min(width - 1, x + radius);
  const minY = Math.max(0, y - radius);
  const maxY = Math.min(height - 1, y + radius);

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      if (mask[py * width + px]) return true;
    }
  }

  return false;
}

function segmentSupport(
  segment: PixelSegment,
  reference: Uint8Array,
  width: number,
  height: number,
  radius: number,
) {
  const length = segment.end - segment.start;
  const samples = Math.max(2, Math.ceil(length));
  let hits = 0;

  for (let sample = 0; sample <= samples; sample += 1) {
    const t = sample / samples;
    const x =
      segment.orientation === "h"
        ? segment.start + length * t
        : segment.center;
    const y =
      segment.orientation === "h"
        ? segment.center
        : segment.start + length * t;
    if (
      pointNearMask(
        reference,
        width,
        height,
        Math.round(x),
        Math.round(y),
        radius,
      )
    ) {
      hits += 1;
    }
  }

  return hits / (samples + 1);
}

function imageSegmentToModel(
  segment: PixelSegment,
  transform: ImageTransform,
): PixelSegment {
  if (segment.orientation === "h") {
    return {
      orientation: "h",
      start: segment.start * scaleX(transform) + transform.padX,
      end: segment.end * scaleX(transform) + transform.padX,
      center: segment.center * scaleY(transform) + transform.padY,
      thickness: segment.thickness * scaleY(transform),
    };
  }

  return {
    orientation: "v",
    start: segment.start * scaleY(transform) + transform.padY,
    end: segment.end * scaleY(transform) + transform.padY,
    center: segment.center * scaleX(transform) + transform.padX,
    thickness: segment.thickness * scaleX(transform),
  };
}

function modelSegmentToImage(
  segment: PixelSegment,
  transform: ImageTransform,
): PixelSegment {
  if (segment.orientation === "h") {
    return {
      orientation: "h",
      start: (segment.start - transform.padX) / scaleX(transform),
      end: (segment.end - transform.padX) / scaleX(transform),
      center: (segment.center - transform.padY) / scaleY(transform),
      thickness: segment.thickness / scaleY(transform),
    };
  }

  return {
    orientation: "v",
    start: (segment.start - transform.padY) / scaleY(transform),
    end: (segment.end - transform.padY) / scaleY(transform),
    center: (segment.center - transform.padX) / scaleX(transform),
    thickness: segment.thickness / scaleX(transform),
  };
}

function collectMaskComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Uint8Array[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!mask[neighbor] || visited[neighbor]) continue;
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }

    if (tail < minArea) continue;
    if (maxX - minX < 2 || maxY - minY < 2) continue;

    const component = new Uint8Array(mask.length);
    for (let index = 0; index < tail; index += 1) {
      component[queue[index]] = 1;
    }
    components.push(component);
  }

  return components;
}

export type SegmentSanitizeResult = {
  segments: PixelSegment[];
  droppedSegments: number;
  recoveredSegments: number;
};

/**
 * Uses the wall/opening class masks (the same data the colored overlay shows)
 * to remove unsupported segments and recover wall runs the post-processing
 * dropped.
 */
export function sanitizeSegmentsWithMasks(
  segments: PixelSegment[],
  referenceWalls: Uint8Array,
  referenceOpenings: Uint8Array,
  width: number,
  height: number,
  transform: ImageTransform,
): SegmentSanitizeResult {
  const plane = width * height;
  const referenceCombined = new Uint8Array(plane);
  for (let index = 0; index < plane; index += 1) {
    referenceCombined[index] =
      referenceWalls[index] || referenceOpenings[index] ? 1 : 0;
  }

  const modelSegments = segments.map((segment) =>
    imageSegmentToModel(segment, transform),
  );

  const kept: PixelSegment[] = [];
  let droppedSegments = 0;
  for (const segment of modelSegments) {
    const support = segmentSupport(
      segment,
      referenceCombined,
      width,
      height,
      3,
    );
    if (support < 0.3) {
      droppedSegments += 1;
      continue;
    }
    kept.push(segment);
  }

  const planCenterline = new Uint8Array(plane);
  for (const segment of kept) {
    drawModelSegment(planCenterline, width, height, segment, 1.5);
  }

  const missing = new Uint8Array(plane);
  for (let index = 0; index < plane; index += 1) {
    if (!referenceWalls[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    if (!pointNearMask(planCenterline, width, height, x, y, 14)) {
      missing[index] = 1;
    }
  }

  const recovered: PixelSegment[] = [];
  for (const component of collectMaskComponents(missing, width, height, 40)) {
    for (const segment of maskToSegments(component, width, height)) {
      if (segment.end - segment.start < 8) continue;
      recovered.push(segment);
    }
  }

  return {
    segments: [...kept, ...recovered].map((segment) =>
      modelSegmentToImage(segment, transform),
    ),
    droppedSegments,
    recoveredSegments: recovered.length,
  };
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

/**
 * Removes duplicate parallel bands produced by hollow/double-line wall masks
 * and drops thin slivers that sit inside a thicker wall band.
 */
export function dedupeParallelSegments(
  segments: PixelSegment[],
  feetPerPixel: number,
): PixelSegment[] {
  const maxGapPx = MAX_PARALLEL_WALL_GAP_FEET / Math.max(feetPerPixel, 1e-6);
  let result = segments.map((segment) => ({ ...segment }));

  let changed = true;
  while (changed) {
    changed = false;

    // 1) A thin band inside a thicker parallel band is an edge artifact.
    for (let index = 0; index < result.length && !changed; index += 1) {
      const a = result[index];
      for (let other = 0; other < result.length; other += 1) {
        if (other === index) continue;
        const b = result[other];
        if (a.orientation !== b.orientation) continue;

        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        const shortest = Math.min(a.end - a.start, b.end - b.start);
        if (overlap < shortest * MIN_PARALLEL_OVERLAP) continue;

        const aLow = a.center - a.thickness / 2;
        const aHigh = a.center + a.thickness / 2;
        const bLow = b.center - b.thickness / 2;
        const bHigh = b.center + b.thickness / 2;

        if (
          a.thickness < b.thickness * 0.5 &&
          aLow >= bLow - 0.5 &&
          aHigh <= bHigh + 0.5
        ) {
          result.splice(index, 1);
          changed = true;
          break;
        }
      }
    }
    if (changed) continue;

    // 2) Merge two parallel bands separated by a small hollow gap.
    for (let index = 0; index < result.length && !changed; index += 1) {
      const a = result[index];
      for (let other = index + 1; other < result.length; other += 1) {
        const b = result[other];
        if (a.orientation !== b.orientation) continue;

        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        const shortest = Math.min(a.end - a.start, b.end - b.start);
        if (overlap < shortest * MIN_PARALLEL_OVERLAP) continue;

        const aLow = a.center - a.thickness / 2;
        const aHigh = a.center + a.thickness / 2;
        const bLow = b.center - b.thickness / 2;
        const bHigh = b.center + b.thickness / 2;
        const gap = Math.max(aLow, bLow) - Math.min(aHigh, bHigh);
        if (gap <= 0 || gap > maxGapPx) continue;

        const low = Math.min(aLow, bLow);
        const high = Math.max(aHigh, bHigh);
        result = result.filter((_, idx) => idx !== index && idx !== other);
        result.push({
          orientation: a.orientation,
          start: Math.min(a.start, b.start),
          end: Math.max(a.end, b.end),
          center: (low + high) / 2,
          thickness: high - low,
        });
        changed = true;
        break;
      }
    }
  }

  // 3) Drop short perpendicular pieces that sit inside a wall.
  return result.filter((segment) => {
    const length = segment.end - segment.start;
    for (const other of result) {
      if (other === segment || other.orientation === segment.orientation) {
        continue;
      }
      const alongOverlap =
        Math.min(segment.end, other.end) - Math.max(segment.start, other.start);
      if (alongOverlap <= 0) continue;

      const otherLow = other.center - other.thickness / 2;
      const otherHigh = other.center + other.thickness / 2;
      if (segment.center < otherLow || segment.center > otherHigh) continue;

      if (
        length < (other.end - other.start) * 0.5 &&
        length <= other.thickness * 2 + 4
      ) {
        return false;
      }
    }
    return true;
  });
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
  margin = SEGMENTATION_CONFIDENCE_MARGIN,
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
    let secondValue = Number.NEGATIVE_INFINITY;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = readTensorValue(data, channel * plane + index);
      if (value > bestValue) {
        secondValue = bestValue;
        bestValue = value;
        bestChannel = channel;
      } else if (value > secondValue) {
        secondValue = value;
      }
    }
    // Ignore ambiguous pixels where the winning class is not clearly ahead.
    pixels[index] = bestValue - secondValue >= margin ? bestChannel : 0;
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
  classRoles?: Record<number, VisionClassRole>,
): VisionClassRole {
  if (classRoles) return classRoles[classId] ?? null;

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

function removeSmallMaskComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!mask[neighbor] || visited[neighbor]) continue;
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }

    if (tail < minArea) {
      for (let index = 0; index < tail; index += 1) {
        mask[queue[index]] = 0;
      }
    }
  }
}

export function segmentationPlan(
  masks: Uint8Array[],
  channels: number,
  width: number,
  height: number,
  transform: ImageTransform,
  signal?: AbortSignal,
  classRoles?: Record<number, VisionClassRole>,
) {
  const segments: PixelSegment[] = [];
  const openings: PixelOpening[] = [];

  for (let channel = 0; channel < masks.length; channel += 1) {
    throwIfAborted(signal);
    const role = segClassRole(channel, channels, classRoles);
    if (!role) continue;

    if (role === "wall") {
      removeSmallMaskComponents(
        masks[channel],
        width,
        height,
        Math.max(8, Math.round(width * height * MIN_WALL_COMPONENT_RATIO)),
      );
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
      segment.thickness /= scaleY(transform);
    } else {
      segment.start = modelToImageY(segment.start, transform);
      segment.end = modelToImageY(segment.end, transform);
      segment.center = modelToImageX(segment.center, transform);
      segment.thickness /= scaleX(transform);
    }
  }

  return { segments, openings };
}

function distanceWallToBox(
  wall: Wall,
  boxMinX: number,
  boxMinY: number,
  boxMaxX: number,
  boxMaxY: number,
  centerX: number,
  centerY: number,
) {
  const horizontal = Math.abs(wall.y1 - wall.y2) < 1e-6;
  const vertical = Math.abs(wall.x1 - wall.x2) < 1e-6;

  if (!horizontal && !vertical) {
    return distanceToSegment({ x: centerX, y: centerY }, wall);
  }

  if (horizontal) {
    const x1 = Math.min(wall.x1, wall.x2);
    const x2 = Math.max(wall.x1, wall.x2);
    const perpendicular = Math.max(
      0,
      boxMinY - wall.y1,
      wall.y1 - boxMaxY,
    );
    const along = Math.max(0, x1 - boxMaxX, boxMinX - x2);
    return Math.hypot(perpendicular, along);
  }

  const y1 = Math.min(wall.y1, wall.y2);
  const y2 = Math.max(wall.y1, wall.y2);
  const perpendicular = Math.max(
    0,
    boxMinX - wall.x1,
    wall.x1 - boxMaxX,
  );
  const along = Math.max(0, y1 - boxMaxY, boxMinY - y2);
  return Math.hypot(perpendicular, along);
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
    const boxMinX = (opening.minX - offsetX) * feetPerPixel + margin;
    const boxMaxX = (opening.maxX - offsetX) * feetPerPixel + margin;
    const boxMinY = (opening.minY - offsetY) * feetPerPixel + margin;
    const boxMaxY = (opening.maxY - offsetY) * feetPerPixel + margin;

    let bestWall: Wall | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const wall of walls) {
      const distance = distanceWallToBox(
        wall,
        boxMinX,
        boxMinY,
        boxMaxX,
        boxMaxY,
        centerX,
        centerY,
      );
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
    }
  }

  return mergePixelSegments(result);
}

export function buildPlanFromSegments(
  rawSegments: PixelSegment[],
  pixelOpenings: PixelOpening[],
  feetPerPixel: number,
) {
  const cleaned = dedupeParallelSegments(rawSegments, feetPerPixel);
  const merged = dedupeParallelSegments(
    bridgeOpenings(mergePixelSegments(cleaned), pixelOpenings),
    feetPerPixel,
  );
  const segments = merged.filter(
    (segment) =>
      (segment.end - segment.start) * feetPerPixel >= 0.75 &&
      segment.thickness * feetPerPixel <= 8 &&
      segment.thickness * feetPerPixel >= MIN_WALL_THICKNESS_FEET,
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
    meta: { minX, minY, margin, feetPerPixel },
  };
}

function feetToModelPoint(
  x: number,
  y: number,
  transform: ImageTransform,
  meta: PlanMeta,
) {
  const imageX = (x - meta.margin) / meta.feetPerPixel + meta.minX;
  const imageY = (y - meta.margin) / meta.feetPerPixel + meta.minY;
  return {
    x: imageX * scaleX(transform) + transform.padX,
    y: imageY * scaleY(transform) + transform.padY,
  };
}

function modelPointToFeet(
  x: number,
  y: number,
  transform: ImageTransform,
  meta: PlanMeta,
) {
  const imageX = (x - transform.padX) / scaleX(transform);
  const imageY = (y - transform.padY) / scaleY(transform);
  return {
    x: (imageX - meta.minX) * meta.feetPerPixel + meta.margin,
    y: (imageY - meta.minY) * meta.feetPerPixel + meta.margin,
  };
}

function wallOrientation(wall: Wall): Orientation | null {
  if (Math.abs(wall.y1 - wall.y2) < 1e-6) return "h";
  if (Math.abs(wall.x1 - wall.x2) < 1e-6) return "v";
  return null;
}

function wallAlreadyCovered(candidate: Wall, walls: Wall[]) {
  const orientation = wallOrientation(candidate);
  if (!orientation) return false;

  const [candidateStart, candidateEnd, candidateCenter] =
    orientation === "h"
      ? [candidate.x1, candidate.x2, candidate.y1]
      : [candidate.y1, candidate.y2, candidate.x1];

  for (const wall of walls) {
    if (wallOrientation(wall) !== orientation) continue;
    const [start, end, center] =
      orientation === "h"
        ? [wall.x1, wall.x2, wall.y1]
        : [wall.y1, wall.y2, wall.x1];

    const overlap =
      Math.min(candidateEnd, end) - Math.max(candidateStart, start);
    const shortest = Math.min(
      candidateEnd - candidateStart,
      end - start,
    );
    if (overlap < shortest * 0.5) continue;

    if (
      Math.abs(candidateCenter - center) <=
      Math.max(1.5, (wall.thickness + candidate.thickness) / 2 + 0.5)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Reconciles the final plan with the raw class masks (the colored overlay's
 * source): adds missing wall runs and re-assigns openings against the cleaned
 * wall set.
 */
export function sanitizePlanWithMasks(
  plan: ReturnType<typeof buildPlanFromSegments>,
  referenceMasks: Uint8Array[],
  channels: number,
  width: number,
  height: number,
  transform: ImageTransform,
  classRoles?: Record<number, VisionClassRole>,
) {
  const meta = plan.meta;
  const plane = width * height;
  const wallMask = new Uint8Array(plane);
  const doorMask = new Uint8Array(plane);
  const windowMask = new Uint8Array(plane);

  for (let channel = 0; channel < channels; channel += 1) {
    const role = segClassRole(channel, channels, classRoles);
    if (!role) continue;
    const target =
      role === "wall" ? wallMask : role === "door" ? doorMask : windowMask;
    const mask = referenceMasks[channel];
    for (let index = 0; index < plane; index += 1) {
      if (mask[index]) target[index] = 1;
    }
  }

  const planCenterline = new Uint8Array(plane);
  for (const wall of plan.walls) {
    const a = feetToModelPoint(wall.x1, wall.y1, transform, meta);
    const b = feetToModelPoint(wall.x2, wall.y2, transform, meta);
    drawLineMask(planCenterline, width, height, a.x, a.y, b.x, b.y, 1.5);
  }

  const missing = new Uint8Array(plane);
  for (let index = 0; index < plane; index += 1) {
    if (!wallMask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    if (!pointNearMask(planCenterline, width, height, x, y, 14)) {
      missing[index] = 1;
    }
  }

  const walls = [...plan.walls];
  const timestamp = Date.now();
  let recoveredWalls = 0;

  for (const component of collectMaskComponents(missing, width, height, 40)) {
    for (const segment of maskToSegments(component, width, height)) {
      const alongScale =
        segment.orientation === "h"
          ? scaleX(transform)
          : scaleY(transform);
      const acrossScale =
        segment.orientation === "h"
          ? scaleY(transform)
          : scaleX(transform);
      const lengthFeet =
        ((segment.end - segment.start) / alongScale) * meta.feetPerPixel;
      const thicknessFeet =
        (segment.thickness / acrossScale) * meta.feetPerPixel;
      if (
        lengthFeet < 0.75 ||
        thicknessFeet < MIN_WALL_THICKNESS_FEET ||
        thicknessFeet > 8
      ) {
        continue;
      }

      const a =
        segment.orientation === "h"
          ? modelPointToFeet(
              segment.start,
              segment.center,
              transform,
              meta,
            )
          : modelPointToFeet(
              segment.center,
              segment.start,
              transform,
              meta,
            );
      const b =
        segment.orientation === "h"
          ? modelPointToFeet(segment.end, segment.center, transform, meta)
          : modelPointToFeet(segment.center, segment.end, transform, meta);

      const candidate: Wall = {
        id: `vision-recovered-${timestamp}-${recoveredWalls}`,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        thickness: clamp(thicknessFeet, 0.25, 0.75),
        height: DEFAULTS.wallHeight,
      };

      if (wallAlreadyCovered(candidate, walls)) continue;
      walls.push(candidate);
      recoveredWalls += 1;
    }
  }

  const pixelOpenings: PixelOpening[] = [];
  const minArea = Math.max(24, Math.round(width * height * 0.00015));
  for (let channel = 0; channel < channels; channel += 1) {
    const role = segClassRole(channel, channels, classRoles);
    if (role !== "door" && role !== "window") continue;
    const mask = role === "door" ? doorMask : windowMask;
    for (const component of componentBoxes(
      mask,
      width,
      height,
      minArea,
      0.75,
    )) {
      pixelOpenings.push({
        ...component,
        type: role,
        minX: modelToImageX(component.minX, transform),
        maxX: modelToImageX(component.maxX, transform),
        minY: modelToImageY(component.minY, transform),
        maxY: modelToImageY(component.maxY, transform),
      });
    }
  }

  const openings = assignOpenings(
    walls,
    pixelOpenings,
    meta.feetPerPixel,
    meta.minX,
    meta.minY,
    meta.margin,
  );

  let maxWallX = 0;
  let maxWallY = 0;
  for (const wall of walls) {
    maxWallX = Math.max(maxWallX, wall.x1, wall.x2);
    maxWallY = Math.max(maxWallY, wall.y1, wall.y2);
  }

  return {
    ...plan,
    walls,
    openings,
    worldWidth: Math.max(plan.worldWidth, maxWallX + meta.margin),
    worldHeight: Math.max(plan.worldHeight, maxWallY + meta.margin),
    recoveredWalls,
  };
}

export type ProcessedVisionOutputs = {
  segments: PixelSegment[];
  openings: PixelOpening[];
  plan: ReturnType<typeof buildPlanFromSegments> & {
    recoveredWalls?: number;
  };
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
    classRoles?: Record<number, VisionClassRole>;
  },
): ProcessedVisionOutputs {
  let segments: PixelSegment[] = [];
  let pixelOpenings: PixelOpening[] = [];
  let usedSegmentation = false;
  let referenceMasks: Uint8Array[] | null = null;
  let referenceChannels = 0;
  let referenceWidth = 0;
  let referenceHeight = 0;

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
        options?.classRoles,
      );
      // Reference classes come from the raw argmax (the same map the colored
      // overlay shows); the confidence-filtered masks are only used to build
      // the initial segments.
      const rawMasks = segmentationToMasks(
        segmentation.data,
        segmentation.channels,
        segmentation.width,
        segmentation.height,
        0,
      );
      referenceMasks = rawMasks;
      referenceChannels = segmentation.channels;
      referenceWidth = segmentation.width;
      referenceHeight = segmentation.height;
      const plane = segmentation.width * segmentation.height;
      const wallMask = new Uint8Array(plane);
      const openingMask = new Uint8Array(plane);
      for (let channel = 0; channel < segmentation.channels; channel += 1) {
        const role = segClassRole(
          channel,
          segmentation.channels,
          options?.classRoles,
        );
        if (!role) continue;
        const target = role === "wall" ? wallMask : openingMask;
        const mask = rawMasks[channel];
        for (let index = 0; index < plane; index += 1) {
          if (mask[index]) target[index] = 1;
        }
      }

      const sanitized = sanitizeSegmentsWithMasks(
        converted.segments,
        wallMask,
        openingMask,
        segmentation.width,
        segmentation.height,
        transform,
      );
      emitDebug(options?.debug, {
        stage: "sanitize",
        droppedSegments: sanitized.droppedSegments,
        recoveredSegments: sanitized.recoveredSegments,
      });

      segments = sanitized.segments;
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

  let plan: ReturnType<typeof buildPlanFromSegments> & {
    recoveredWalls?: number;
  } = buildPlanFromSegments(segments, pixelOpenings, feetPerPixel);

  if (usedSegmentation && referenceMasks) {
    const beforeOpenings = plan.openings.length;
    plan = sanitizePlanWithMasks(
      plan,
      referenceMasks,
      referenceChannels,
      referenceWidth,
      referenceHeight,
      transform,
      options?.classRoles,
    );
    emitDebug(options?.debug, {
      stage: "planSanitize",
      recoveredWalls: plan.recoveredWalls ?? 0,
      recoveredOpenings: plan.openings.length - beforeOpenings,
    });
  }

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
  const config = resolveVisionModelConfig();

  const image = await loadImageFromFile(file);
  const { tensor, transform } = await buildInputTensor(
    image,
    ort,
    config,
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
    classRoles: config.classRoles,
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
