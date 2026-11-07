import type { Opening, OpeningType, Wall } from "../types/floorplan";
import { pointAtDistance, wallLength } from "../utils/geometry";
import type { ImageTransform } from "./visionModelService";

export const OVERLAY_PALETTE: Record<number, [number, number, number]> = {
  1: [128, 138, 239], // wall
  2: [162, 221, 119], // door
  3: [231, 188, 123], // window
};
export const OVERLAY_DIM = 0.45;

const PALETTE_MATCH_DISTANCE = 70;
const DEFAULT_WALL_TOLERANCE = 14;
const DEFAULT_OPENING_TOLERANCE = 6;
const DEFAULT_PHANTOM_TOLERANCE = 5;
const DEFAULT_MIN_COMPONENT_PIXELS = 20;

export type PlanMeta = {
  minX: number;
  minY: number;
  margin: number;
  feetPerPixel: number;
};

export type PlanGeometry = {
  walls: Wall[];
  openings: Opening[];
};

export type OverlayClasses = {
  walls: Uint8Array;
  doors: Uint8Array;
  windows: Uint8Array;
};

export type OverlayRegion = {
  pixels: number;
  bbox: [number, number, number, number];
  imageBBox: [number, number, number, number];
};

export type MissingOpening = OverlayRegion & {
  type: OpeningType;
  matchedRatio: number;
};

export type PlanValidationReport = {
  width: number;
  height: number;
  referenceWallPixels: number;
  coveredWallPixels: number;
  missingWallPixels: number;
  wallCoverage: number;
  rasterWallPixels: number;
  phantomWallPixels: number;
  wallPrecision: number;
  missingWallRegions: OverlayRegion[];
  referenceDoorPixels: number;
  referenceWindowPixels: number;
  matchedDoorPixels: number;
  matchedWindowPixels: number;
  missingOpenings: MissingOpening[];
  validationImage: Uint8Array;
};

export type ValidationOptions = {
  wallTolerance?: number;
  openingTolerance?: number;
  phantomTolerance?: number;
  minComponentPixels?: number;
};

function decodeOverlayClasses(
  rgb: Uint8Array,
  width: number,
  height: number,
): OverlayClasses {
  const plane = width * height;
  const walls = new Uint8Array(plane);
  const doors = new Uint8Array(plane);
  const windows = new Uint8Array(plane);
  const maxDistanceSq = PALETTE_MATCH_DISTANCE * PALETTE_MATCH_DISTANCE;

  for (let index = 0; index < plane; index += 1) {
    const pixel = index * 3;
    const r = rgb[pixel];
    const g = rgb[pixel + 1];
    const b = rgb[pixel + 2];

    let bestClass = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const classId of [1, 2, 3]) {
      const [R, G, B] = OVERLAY_PALETTE[classId];
      const distance = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestClass = classId;
      }
    }

    if (bestDistance > maxDistanceSq) continue;
    if (bestClass === 1) walls[index] = 1;
    else if (bestClass === 2) doors[index] = 1;
    else if (bestClass === 3) windows[index] = 1;
  }

  return { walls, doors, windows };
}

function scaleX(transform: ImageTransform) {
  return transform.scaleX ?? transform.scale;
}

function scaleY(transform: ImageTransform) {
  return transform.scaleY ?? transform.scale;
}

function feetToModel(
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

function modelToImage(
  x: number,
  y: number,
  transform: ImageTransform,
) {
  return {
    x: (x - transform.padX) / scaleX(transform),
    y: (y - transform.padY) / scaleY(transform),
  };
}

function drawSegment(
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

function rasterizeWalls(
  plan: PlanGeometry,
  width: number,
  height: number,
  transform: ImageTransform,
  meta: PlanMeta,
) {
  const bands = new Uint8Array(width * height);
  const centerlines = new Uint8Array(width * height);

  for (const wall of plan.walls) {
    const a = feetToModel(wall.x1, wall.y1, transform, meta);
    const b = feetToModel(wall.x2, wall.y2, transform, meta);
    const horizontal = Math.abs(wall.y1 - wall.y2) < 1e-6;
    const thickness = Math.max(
      1.5,
      (wall.thickness / meta.feetPerPixel) *
        (horizontal ? scaleY(transform) : scaleX(transform)),
    );
    drawSegment(bands, width, height, a.x, a.y, b.x, b.y, thickness);
    drawSegment(centerlines, width, height, a.x, a.y, b.x, b.y, 1.5);
  }

  return { bands, centerlines };
}

function rasterizeOpenings(
  plan: PlanGeometry,
  width: number,
  height: number,
  transform: ImageTransform,
  meta: PlanMeta,
) {
  const doors = new Uint8Array(width * height);
  const windows = new Uint8Array(width * height);
  const wallsById = new Map(plan.walls.map((wall) => [wall.id, wall]));

  for (const opening of plan.openings) {
    const wall = wallsById.get(opening.wallId);
    if (!wall) continue;
    const length = wallLength(wall);
    if (length <= 0) continue;

    const center = opening.positionOnWall * length;
    const start = pointAtDistance(
      wall,
      Math.max(0, center - opening.width / 2),
    );
    const end = pointAtDistance(
      wall,
      Math.min(length, center + opening.width / 2),
    );
    const a = feetToModel(start.x, start.y, transform, meta);
    const b = feetToModel(end.x, end.y, transform, meta);
    const horizontal = Math.abs(wall.y1 - wall.y2) < 1e-6;
    const thickness = Math.max(
      1.5,
      (wall.thickness / meta.feetPerPixel) *
        (horizontal ? scaleY(transform) : scaleX(transform)),
    );

    drawSegment(
      opening.type === "door" ? doors : windows,
      width,
      height,
      a.x,
      a.y,
      b.x,
      b.y,
      thickness,
    );
  }

  return { doors, windows };
}

function distanceTransform(
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const distances = new Float32Array(width * height);
  const diagonal = Math.SQRT2;

  for (let index = 0; index < mask.length; index += 1) {
    distances[index] = mask[index] ? 0 : Number.POSITIVE_INFINITY;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let best = distances[index];
      if (x > 0) best = Math.min(best, distances[index - 1] + 1);
      if (y > 0) {
        best = Math.min(best, distances[index - width] + 1);
        if (x > 0) {
          best = Math.min(best, distances[index - width - 1] + diagonal);
        }
        if (x < width - 1) {
          best = Math.min(best, distances[index - width + 1] + diagonal);
        }
      }
      distances[index] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let best = distances[index];
      if (x < width - 1) best = Math.min(best, distances[index + 1] + 1);
      if (y < height - 1) {
        best = Math.min(best, distances[index + width] + 1);
        if (x < width - 1) {
          best = Math.min(best, distances[index + width + 1] + diagonal);
        }
        if (x > 0) {
          best = Math.min(best, distances[index + width - 1] + diagonal);
        }
      }
      distances[index] = best;
    }
  }

  return distances;
}

type Component = {
  pixels: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    queue[tail] = start;
    tail += 1;
    visited[start] = 1;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
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

    components.push({ pixels: tail, minX, minY, maxX, maxY });
  }

  return components;
}

function regionFromComponent(
  component: Component,
  transform: ImageTransform,
) {
  const imageTopLeft = modelToImage(
    component.minX,
    component.minY,
    transform,
  );
  const imageBottomRight = modelToImage(
    component.maxX,
    component.maxY,
    transform,
  );
  return {
    pixels: component.pixels,
    bbox: [
      component.minX,
      component.minY,
      component.maxX,
      component.maxY,
    ] as [number, number, number, number],
    imageBBox: [
      Math.round(imageTopLeft.x),
      Math.round(imageTopLeft.y),
      Math.round(imageBottomRight.x),
      Math.round(imageBottomRight.y),
    ] as [number, number, number, number],
  };
}

function computeMissingOpenings(
  reference: Uint8Array,
  openingCenterlines: Uint8Array,
  type: OpeningType,
  width: number,
  height: number,
  transform: ImageTransform,
  tolerance: number,
  minComponentPixels: number,
) {
  const missing: MissingOpening[] = [];
  const missingMask = new Uint8Array(reference.length);
  const matchedMask = new Uint8Array(reference.length);
  let matchedPixels = 0;

  for (const component of connectedComponents(reference, width, height)) {
    if (component.pixels < minComponentPixels) continue;

    // Door masks include the swing arc, so require only that a plan opening
    // line reaches the component's bounding box instead of covering every arc
    // pixel.
    let intersects = false;
    const minX = Math.max(0, component.minX - tolerance);
    const maxX = Math.min(width - 1, component.maxX + tolerance);
    const minY = Math.max(0, component.minY - tolerance);
    const maxY = Math.min(height - 1, component.maxY + tolerance);
    for (let y = minY; y <= maxY && !intersects; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (openingCenterlines[y * width + x]) {
          intersects = true;
          break;
        }
      }
    }

    const target = intersects ? matchedMask : missingMask;
    let hit = 0;
    for (let y = component.minY; y <= component.maxY; y += 1) {
      for (let x = component.minX; x <= component.maxX; x += 1) {
        const index = y * width + x;
        if (!reference[index]) continue;
        target[index] = 1;
        if (intersects) {
          hit += 1;
          matchedPixels += 1;
        }
      }
    }

    if (intersects) continue;
    missing.push({
      ...regionFromComponent(component, transform),
      type,
      matchedRatio: hit / component.pixels,
    });
  }

  return { matchedPixels, missing, missingMask, matchedMask };
}

export function validatePlanOverlay(
  referenceRgb: Uint8Array,
  width: number,
  height: number,
  plan: PlanGeometry,
  transform: ImageTransform,
  meta: PlanMeta,
  options: ValidationOptions = {},
): PlanValidationReport {
  const wallTolerance = options.wallTolerance ?? DEFAULT_WALL_TOLERANCE;
  const openingTolerance =
    options.openingTolerance ?? DEFAULT_OPENING_TOLERANCE;
  const phantomTolerance =
    options.phantomTolerance ?? DEFAULT_PHANTOM_TOLERANCE;
  const minComponentPixels =
    options.minComponentPixels ?? DEFAULT_MIN_COMPONENT_PIXELS;

  const plane = width * height;
  const reference = decodeOverlayClasses(referenceRgb, width, height);
  const rasterWalls = rasterizeWalls(plan, width, height, transform, meta);
  const rasterOpenings = rasterizeOpenings(
    plan,
    width,
    height,
    transform,
    meta,
  );

  const wallDistance = distanceTransform(rasterWalls.centerlines, width, height);
  const referenceWallDistance = distanceTransform(
    reference.walls,
    width,
    height,
  );
  const referenceOpeningMask = new Uint8Array(plane);
  for (let index = 0; index < plane; index += 1) {
    referenceOpeningMask[index] =
      reference.doors[index] || reference.windows[index] ? 1 : 0;
  }
  const referenceOpeningDistance = distanceTransform(
    referenceOpeningMask,
    width,
    height,
  );
  let referenceWallPixels = 0;
  let coveredWallPixels = 0;
  let missingWallPixels = 0;
  let rasterWallPixels = 0;
  let phantomWallPixels = 0;
  let referenceDoorPixels = 0;
  let referenceWindowPixels = 0;
  let matchedDoorPixels = 0;
  let matchedWindowPixels = 0;

  const missingWallMask = new Uint8Array(plane);
  const validationImage = new Uint8Array(plane * 3);

  for (let index = 0; index < plane; index += 1) {
    const pixel = index * 3;
    const luminance =
      0.299 * referenceRgb[pixel] +
      0.587 * referenceRgb[pixel + 1] +
      0.114 * referenceRgb[pixel + 2];
    const base = Math.round(luminance * 0.25);
    validationImage[pixel] = base;
    validationImage[pixel + 1] = base;
    validationImage[pixel + 2] = base + 4;

    if (reference.walls[index]) {
      referenceWallPixels += 1;
      if (wallDistance[index] <= wallTolerance) {
        coveredWallPixels += 1;
        validationImage[pixel] = 60;
        validationImage[pixel + 1] = 180;
        validationImage[pixel + 2] = 110;
      } else {
        missingWallPixels += 1;
        missingWallMask[index] = 1;
        validationImage[pixel] = 240;
        validationImage[pixel + 1] = 60;
        validationImage[pixel + 2] = 60;
      }
    }

    if (reference.doors[index]) {
      referenceDoorPixels += 1;
      validationImage[pixel] = 80;
      validationImage[pixel + 1] = 220;
      validationImage[pixel + 2] = 140;
    }

    if (reference.windows[index]) {
      referenceWindowPixels += 1;
      validationImage[pixel] = 80;
      validationImage[pixel + 1] = 160;
      validationImage[pixel + 2] = 240;
    }
  }

  for (let index = 0; index < plane; index += 1) {
    if (!rasterWalls.bands[index] || reference.walls[index]) continue;
    rasterWallPixels += 1;
    if (
      referenceWallDistance[index] > phantomTolerance &&
      referenceOpeningDistance[index] > phantomTolerance
    ) {
      phantomWallPixels += 1;
      const pixel = index * 3;
      validationImage[pixel] = 250;
      validationImage[pixel + 1] = 170;
      validationImage[pixel + 2] = 50;
    }
  }

  const missingWallRegions = connectedComponents(
    missingWallMask,
    width,
    height,
  )
    .filter((component) => component.pixels >= minComponentPixels)
    .map((component) => regionFromComponent(component, transform));

  const doors = computeMissingOpenings(
    reference.doors,
    rasterOpenings.doors,
    "door",
    width,
    height,
    transform,
    openingTolerance,
    minComponentPixels,
  );
  const windows = computeMissingOpenings(
    reference.windows,
    rasterOpenings.windows,
    "window",
    width,
    height,
    transform,
    openingTolerance,
    minComponentPixels,
  );

  matchedDoorPixels = doors.matchedPixels;
  matchedWindowPixels = windows.matchedPixels;

  for (let index = 0; index < plane; index += 1) {
    const pixel = index * 3;
    if (reference.doors[index]) {
      if (doors.missingMask[index]) {
        validationImage[pixel] = 230;
        validationImage[pixel + 1] = 60;
        validationImage[pixel + 2] = 230;
      } else if (doors.matchedMask[index]) {
        validationImage[pixel] = 80;
        validationImage[pixel + 1] = 220;
        validationImage[pixel + 2] = 140;
      }
    }
    if (reference.windows[index]) {
      if (windows.missingMask[index]) {
        validationImage[pixel] = 230;
        validationImage[pixel + 1] = 60;
        validationImage[pixel + 2] = 230;
      } else if (windows.matchedMask[index]) {
        validationImage[pixel] = 80;
        validationImage[pixel + 1] = 160;
        validationImage[pixel + 2] = 240;
      }
    }
  }

  return {
    width,
    height,
    referenceWallPixels,
    coveredWallPixels,
    missingWallPixels,
    wallCoverage:
      referenceWallPixels > 0
        ? coveredWallPixels / referenceWallPixels
        : 0,
    rasterWallPixels,
    phantomWallPixels,
    wallPrecision:
      rasterWallPixels > 0
        ? (rasterWallPixels - phantomWallPixels) / rasterWallPixels
        : 0,
    missingWallRegions,
    referenceDoorPixels,
    referenceWindowPixels,
    matchedDoorPixels,
    matchedWindowPixels,
    missingOpenings: [...doors.missing, ...windows.missing],
    validationImage,
  };
}
