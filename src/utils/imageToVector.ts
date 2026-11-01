import {
  DEFAULTS,
  type Opening,
  type OpeningType,
  type Wall,
} from "../types/floorplan";

export type ImageVectorOptions = {
  threshold: number;
  contrast: number;
  invert: boolean;
  feetPer100Pixels: number;
  minSegmentPixels?: number;
  minComponentPixels?: number;
  maxDimension?: number;
};

export type VectorizedPlan = {
  walls: Wall[];
  openings: Opening[];
  pixelWidth: number;
  pixelHeight: number;
  worldWidth: number;
  worldHeight: number;
  segmentCount: number;
  openingCount: number;
};

export type PreviewStats = {
  width: number;
  height: number;
  wallPixels: number;
};

type Orientation = "h" | "v";

type DetectedOpening = {
  start: number;
  end: number;
  type: OpeningType;
};

type RawSegment = {
  orientation: Orientation;
  start: number;
  end: number;
  center: number;
  thickness: number;
  openings?: DetectedOpening[];
};

type Band = {
  start: number;
  end: number;
  first: number;
  last: number;
  lastStep: number;
};

const yieldToBrowser = () =>
  new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image file."));
    };
    image.src = url;
  });
}

function prepareImage(image: HTMLImageElement, maxDimension: number) {
  const ratio = Math.min(
    1,
    maxDimension / Math.max(image.width, image.height),
  );
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is not available.");
  context.drawImage(image, 0, 0, width, height);
  return {
    width,
    height,
    imageData: context.getImageData(0, 0, width, height),
  };
}

function removeSmallComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;

    let head = 0;
    let tail = 0;
    queue[tail] = index;
    tail += 1;
    visited[index] = 1;

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
          if (mask[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue[tail] = neighbor;
            tail += 1;
          }
        }
      }
    }

    if (tail < minArea) {
      for (let cursor = 0; cursor < tail; cursor += 1) {
        mask[queue[cursor]] = 0;
      }
    }
  }
}

async function buildWallMask(
  imageData: ImageData,
  options: ImageVectorOptions,
): Promise<Uint8Array> {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  const threshold = clamp(options.threshold, 1, 254);
  const contrast = Math.max(0.1, options.contrast / 100);
  const lightLines = options.invert;
  const chunkRows = 160;

  for (let rowStart = 0; rowStart < height; rowStart += chunkRows) {
    const rowEnd = Math.min(height, rowStart + chunkRows);
    for (let y = rowStart; y < rowEnd; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        const pixel = index * 4;
        if (data[pixel + 3] < 32) continue;
        const gray =
          0.299 * data[pixel] +
          0.587 * data[pixel + 1] +
          0.114 * data[pixel + 2];
        const adjusted = (gray - 128) * contrast + 128;
        const isWall = lightLines
          ? adjusted > 255 - threshold
          : adjusted < threshold;
        if (isWall) mask[index] = 1;
      }
    }
    if (rowEnd < height) await yieldToBrowser();
  }

  removeSmallComponents(
    mask,
    width,
    height,
    options.minComponentPixels ?? 22,
  );
  return mask;
}

function findRowRuns(
  mask: Uint8Array,
  width: number,
  y: number,
  minRun: number,
) {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  const offset = y * width;

  for (let x = 0; x < width; x += 1) {
    if (mask[offset + x]) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start >= minRun) runs.push({ start, end: x });
      start = -1;
    }
  }

  if (start >= 0 && width - start >= minRun) {
    runs.push({ start, end: width });
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

  for (let y = 0; y < height; y += 1) {
    if (mask[y * width + x]) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      if (y - start >= minRun) runs.push({ start, end: y });
      start = -1;
    }
  }

  if (start >= 0 && height - start >= minRun) {
    runs.push({ start, end: height });
  }

  return runs;
}

function finalizeBand(
  band: Band,
  orientation: Orientation,
  minRun: number,
  segments: RawSegment[],
) {
  const thickness = band.last - band.first + 1;
  const length = band.end - band.start;
  if (length < minRun || thickness < 1 || thickness > 80) return;
  segments.push({
    orientation,
    start: band.start,
    end: band.end,
    center: (band.first + band.last) / 2,
    thickness,
  });
}

function detectHorizontal(
  mask: Uint8Array,
  width: number,
  height: number,
  minRun: number,
) {
  const segments: RawSegment[] = [];
  let active: Band[] = [];

  for (let y = 0; y < height; y += 1) {
    const runs = findRowRuns(mask, width, y, minRun);
    const matched = new Set<number>();

    for (const run of runs) {
      let bestIndex = -1;
      let bestOverlap = 0;

      for (let index = 0; index < active.length; index += 1) {
        if (matched.has(index)) continue;
        const band = active[index];
        if (band.lastStep !== y - 1) continue;
        const overlap =
          Math.min(band.end, run.end) - Math.max(band.start, run.start);
        const shortest = Math.min(
          band.end - band.start,
          run.end - run.start,
        );
        if (
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
      if (band.lastStep === y) return true;
      finalizeBand(band, "h", minRun, segments);
      return false;
    });
  }

  for (const band of active) {
    finalizeBand(band, "h", minRun, segments);
  }

  return segments;
}

function detectVertical(
  mask: Uint8Array,
  width: number,
  height: number,
  minRun: number,
) {
  const segments: RawSegment[] = [];
  let active: Band[] = [];

  for (let x = 0; x < width; x += 1) {
    const runs = findColumnRuns(mask, width, height, x, minRun);
    const matched = new Set<number>();

    for (const run of runs) {
      let bestIndex = -1;
      let bestOverlap = 0;

      for (let index = 0; index < active.length; index += 1) {
        if (matched.has(index)) continue;
        const band = active[index];
        if (band.lastStep !== x - 1) continue;
        const overlap =
          Math.min(band.end, run.end) - Math.max(band.start, run.start);
        const shortest = Math.min(
          band.end - band.start,
          run.end - run.start,
        );
        if (
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
      if (band.lastStep === x) return true;
      finalizeBand(band, "v", minRun, segments);
      return false;
    });
  }

  for (const band of active) {
    finalizeBand(band, "v", minRun, segments);
  }

  return segments;
}

function mergeSegments(
  segments: RawSegment[],
  centerTolerance = 6,
  mergeGap = 6,
) {
  const sorted = [...segments].sort(
    (a, b) => a.center - b.center || a.start - b.start,
  );
  const merged: RawSegment[] = [];

  for (const segment of sorted) {
    let target: RawSegment | null = null;

    for (const candidate of merged) {
      if (candidate.orientation !== segment.orientation) continue;
      if (Math.abs(candidate.center - segment.center) > centerTolerance) {
        continue;
      }
      if (
        segment.start <= candidate.end + mergeGap &&
        segment.end >= candidate.start - mergeGap
      ) {
        target = candidate;
        break;
      }
    }

    if (target) {
      const lengthA = target.end - target.start;
      const lengthB = segment.end - segment.start;
      target.center =
        (target.center * lengthA + segment.center * lengthB) /
        Math.max(1, lengthA + lengthB);
      target.start = Math.min(target.start, segment.start);
      target.end = Math.max(target.end, segment.end);
      target.thickness = Math.max(target.thickness, segment.thickness);
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

function snapSegmentEnds(segments: RawSegment[]) {
  const snapped = segments.map((segment) => ({ ...segment }));

  for (const segment of snapped) {
    const perpendicular = snapped.filter(
      (candidate) => candidate.orientation !== segment.orientation,
    );
    const reach = Math.max(segment.thickness, 1) / 2 + 2;

    for (const other of perpendicular) {
      const otherReach = Math.max(other.thickness, 1) / 2 + 2;
      const containsCenter =
        segment.center >= other.start - otherReach &&
        segment.center <= other.end + otherReach;
      if (!containsCenter) continue;

      if (Math.abs(segment.start - other.center) <= reach) {
        segment.start = other.center;
      }
      if (Math.abs(segment.end - other.center) <= reach) {
        segment.end = other.center;
      }
    }
  }

  return snapped.filter((segment) => segment.end > segment.start);
}

function dedupeSegments(segments: RawSegment[]) {
  const unique: RawSegment[] = [];

  for (const segment of segments) {
    const duplicate = unique.some(
      (candidate) =>
        candidate.orientation === segment.orientation &&
        Math.abs(candidate.start - segment.start) < 2 &&
        Math.abs(candidate.end - segment.end) < 2 &&
        Math.abs(candidate.center - segment.center) < 2,
    );
    if (!duplicate) unique.push(segment);
  }

  return unique;
}

function maskHit(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return false;
  return mask[py * width + px] !== 0;
}

function localWallThickness(
  mask: Uint8Array,
  width: number,
  height: number,
  orientation: Orientation,
  along: number,
  center: number,
  radius: number,
) {
  let count = 0;

  if (orientation === "h") {
    const x = Math.round(along);
    const yStart = Math.max(0, Math.floor(center - radius));
    const yEnd = Math.min(height - 1, Math.ceil(center + radius));
    for (let y = yStart; y <= yEnd; y += 1) {
      if (mask[y * width + x]) count += 1;
    }
  } else {
    const y = Math.round(along);
    const xStart = Math.max(0, Math.floor(center - radius));
    const xEnd = Math.min(width - 1, Math.ceil(center + radius));
    for (let x = xStart; x <= xEnd; x += 1) {
      if (mask[y * width + x]) count += 1;
    }
  }

  return count;
}

function windowCoverage(
  mask: Uint8Array,
  width: number,
  height: number,
  segment: RawSegment,
  start: number,
  end: number,
) {
  const half = Math.max(3, Math.ceil(segment.thickness / 2) + 2);
  let hits = 0;
  let total = 0;

  for (let along = Math.round(start); along <= Math.round(end); along += 1) {
    if (segment.orientation === "h") {
      for (
        let perpendicular = Math.floor(segment.center - half);
        perpendicular <= Math.ceil(segment.center + half);
        perpendicular += 1
      ) {
        total += 1;
        if (maskHit(mask, width, height, along, perpendicular)) hits += 1;
      }
    } else {
      for (
        let perpendicular = Math.floor(segment.center - half);
        perpendicular <= Math.ceil(segment.center + half);
        perpendicular += 1
      ) {
        total += 1;
        if (maskHit(mask, width, height, perpendicular, along)) hits += 1;
      }
    }
  }

  return total > 0 ? hits / total : 0;
}

function maxPerpendicularRun(
  mask: Uint8Array,
  width: number,
  height: number,
  segment: RawSegment,
  along: number,
  startOffset: number,
  reach: number,
) {
  let best = 0;

  for (const direction of [-1, 1]) {
    let run = 0;
    for (let offset = startOffset; offset <= startOffset + reach; offset += 1) {
      const perpendicular = segment.center + direction * offset;
      const hit =
        segment.orientation === "h"
          ? maskHit(mask, width, height, along, perpendicular)
          : maskHit(mask, width, height, perpendicular, along);
      if (hit) {
        run += 1;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
  }

  return best;
}

function classifyOpening(
  mask: Uint8Array,
  width: number,
  height: number,
  segment: RawSegment,
  start: number,
  end: number,
  rawStart: number,
  rawEnd: number,
  scale: number,
): OpeningType {
  const gapPixels = Math.max(1, end - start);
  const gapFeet = gapPixels * scale;
  const hasWindowSymbol =
    windowCoverage(mask, width, height, segment, start, end) >= 0.12;
  const startOffset = Math.max(2, Math.ceil(segment.thickness / 2) + 1);
  const reach = Math.max(8, Math.round(gapPixels * 0.9));
  const doorThreshold = Math.max(6, Math.round(gapPixels * 0.35));
  const doorSamples = [rawStart, rawStart + 1, rawEnd - 1, rawEnd];
  const hasDoorSymbol = doorSamples.some(
    (sample) =>
      maxPerpendicularRun(
        mask,
        width,
        height,
        segment,
        sample,
        startOffset,
        reach,
      ) >= doorThreshold,
  );

  if (hasDoorSymbol) return "door";
  if (hasWindowSymbol) return "window";
  return gapFeet <= 4.5 ? "door" : "window";
}

function filterSymbolSegments(segments: RawSegment[]) {
  if (segments.length === 0) return segments;

  const dominant = Math.max(...segments.map((segment) => segment.thickness));
  if (dominant < 3) return segments;

  const minThickness = Math.min(6, Math.max(2.1, dominant * 0.35));
  const filtered = segments.filter(
    (segment) => segment.thickness >= minThickness,
  );
  return filtered.length > 0 ? filtered : segments;
}

function detectOpeningsForSegment(
  segment: RawSegment,
  mask: Uint8Array,
  width: number,
  height: number,
  scale: number,
): DetectedOpening[] {
  const length = Math.max(0, Math.round(segment.end - segment.start));
  if (length < 8) return [];

  const radius = Math.max(3, Math.ceil(segment.thickness / 2) + 2);
  const thicknessThreshold = Math.max(1.5, segment.thickness - 3);
  const minOpeningPixels = Math.max(6, Math.round(1.5 / scale));
  const maxOpeningPixels = Math.max(
    minOpeningPixels + 1,
    Math.round(20 / scale),
  );
  const edgeMargin = Math.max(4, Math.round(segment.thickness * 0.75));
  const trim = 1;
  const profile = new Uint16Array(length + 1);

  for (let offset = 0; offset <= length; offset += 1) {
    profile[offset] = localWallThickness(
      mask,
      width,
      height,
      segment.orientation,
      segment.start + offset,
      segment.center,
      radius,
    );
  }

  const openings: DetectedOpening[] = [];
  let runStart = -1;

  for (let index = 0; index <= profile.length; index += 1) {
    const low = index < profile.length && profile[index] < thicknessThreshold;

    if (low && runStart < 0) {
      runStart = index;
    }

    if (!low && runStart >= 0) {
      const runEnd = index;
      const rawStart = segment.start + runStart;
      const rawEnd = segment.start + runEnd;
      const start = rawStart + trim;
      const end = rawEnd - trim;
      const gapPixels = end - start;

      if (
        gapPixels >= minOpeningPixels &&
        gapPixels <= maxOpeningPixels &&
        start > segment.start + edgeMargin &&
        end < segment.end - edgeMargin
      ) {
        openings.push({
          start,
          end,
          type: classifyOpening(
            mask,
            width,
            height,
            segment,
            start,
            end,
            rawStart,
            rawEnd,
            scale,
          ),
        });
      }

      runStart = -1;
    }
  }

  return openings;
}

function rawSegmentsToWalls(
  segments: RawSegment[],
  scale: number,
  margin: number,
  offsetX: number,
  offsetY: number,
) {
  const walls: Wall[] = [];
  const openings: Opening[] = [];
  const timestamp = Date.now();

  segments.forEach((segment, index) => {
    const thickness = clamp(segment.thickness * scale, 0.2, 1.5);
    const wallId = `blueprint-${timestamp}-${index}`;
    const wallLengthPixels = segment.end - segment.start;

    if (segment.orientation === "h") {
      walls.push({
        id: wallId,
        x1: (segment.start - offsetX) * scale + margin,
        y1: (segment.center - offsetY) * scale + margin,
        x2: (segment.end - offsetX) * scale + margin,
        y2: (segment.center - offsetY) * scale + margin,
        thickness,
        height: DEFAULTS.wallHeight,
      });
    } else {
      walls.push({
        id: wallId,
        x1: (segment.center - offsetX) * scale + margin,
        y1: (segment.start - offsetY) * scale + margin,
        x2: (segment.center - offsetX) * scale + margin,
        y2: (segment.end - offsetY) * scale + margin,
        thickness,
        height: DEFAULTS.wallHeight,
      });
    }

    for (const [openingIndex, opening] of (segment.openings ?? []).entries()) {
      const widthPixels = opening.end - opening.start;
      if (widthPixels <= 0 || wallLengthPixels <= 0) continue;

      const wallLengthFeet = wallLengthPixels * scale;
      const width = Math.min(widthPixels * scale, wallLengthFeet * 0.9);
      const halfNormalized = Math.min(0.45, width / wallLengthFeet / 2);
      const rawPosition =
        (opening.start + opening.end) / 2 - segment.start;
      const positionOnWall = clamp(
        rawPosition / wallLengthPixels,
        halfNormalized,
        1 - halfNormalized,
      );

      openings.push({
        id: `blueprint-opening-${timestamp}-${index}-${openingIndex}`,
        wallId,
        type: opening.type,
        positionOnWall,
        width,
      });
    }
  });

  return { walls, openings };
}

export async function vectorizeFloorPlanImage(
  file: File,
  options: ImageVectorOptions,
): Promise<VectorizedPlan> {
  await yieldToBrowser();
  const image = await loadImageFromFile(file);
  const prepared = prepareImage(image, options.maxDimension ?? 1400);
  const mask = await buildWallMask(prepared.imageData, options);
  await yieldToBrowser();

  const scale = clamp(options.feetPer100Pixels, 1, 100) / 100;
  const minRun = clamp(options.minSegmentPixels ?? 14, 6, 80);
  const mergeGap = clamp(Math.round(20 / scale), 16, 400);
  const horizontal = detectHorizontal(
    mask,
    prepared.width,
    prepared.height,
    minRun,
  );
  await yieldToBrowser();
  const vertical = detectVertical(
    mask,
    prepared.width,
    prepared.height,
    minRun,
  );
  await yieldToBrowser();

  const segments = filterSymbolSegments(
    snapSegmentEnds(
      dedupeSegments(mergeSegments([...horizontal, ...vertical], 6, mergeGap)),
    ).filter((segment) => segment.end - segment.start >= minRun),
  );

  if (segments.length === 0) {
    throw new Error(
      "No wall lines were detected. Try lowering the threshold, increasing contrast, or enabling light-line mode.",
    );
  }

  for (const segment of segments) {
    segment.openings = detectOpeningsForSegment(
      segment,
      mask,
      prepared.width,
      prepared.height,
      scale,
    );
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const segment of segments) {
    if (segment.orientation === "h") {
      minX = Math.min(minX, segment.start);
      maxX = Math.max(maxX, segment.end);
      minY = Math.min(minY, segment.center - segment.thickness / 2);
      maxY = Math.max(maxY, segment.center + segment.thickness / 2);
    } else {
      minY = Math.min(minY, segment.start);
      maxY = Math.max(maxY, segment.end);
      minX = Math.min(minX, segment.center - segment.thickness / 2);
      maxX = Math.max(maxX, segment.center + segment.thickness / 2);
    }
  }

  const margin = 0.5;
  const limited = [...segments]
    .sort(
      (a, b) => b.end - b.start - (a.end - a.start),
    )
    .slice(0, 400);

  const { walls, openings } = rawSegmentsToWalls(
    limited,
    scale,
    margin,
    minX,
    minY,
  );

  return {
    walls,
    openings,
    pixelWidth: prepared.width,
    pixelHeight: prepared.height,
    worldWidth: (maxX - minX) * scale + margin * 2,
    worldHeight: (maxY - minY) * scale + margin * 2,
    segmentCount: walls.length,
    openingCount: openings.length,
  };
}

export async function renderBlueprintPreview(
  image: HTMLImageElement,
  options: ImageVectorOptions,
  canvas: HTMLCanvasElement,
  maxDimension = 760,
): Promise<PreviewStats> {
  const prepared = prepareImage(image, maxDimension);
  const mask = await buildWallMask(prepared.imageData, options);
  canvas.width = prepared.width;
  canvas.height = prepared.height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available.");

  const output = context.createImageData(prepared.width, prepared.height);
  const source = prepared.imageData.data;
  let wallPixels = 0;

  for (let index = 0; index < mask.length; index += 1) {
    const pixel = index * 4;
    if (mask[index]) {
      output.data[pixel] = 125;
      output.data[pixel + 1] = 211;
      output.data[pixel + 2] = 252;
      output.data[pixel + 3] = 255;
      wallPixels += 1;
    } else {
      const gray = Math.round(
        (0.299 * source[pixel] +
          0.587 * source[pixel + 1] +
          0.114 * source[pixel + 2]) *
          0.16,
      );
      output.data[pixel] = gray;
      output.data[pixel + 1] = gray + 2;
      output.data[pixel + 2] = gray + 4;
      output.data[pixel + 3] = 255;
    }
  }

  context.putImageData(output, 0, 0);

  return {
    width: prepared.width,
    height: prepared.height,
    wallPixels,
  };
}
