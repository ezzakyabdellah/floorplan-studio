import { DEFAULTS, type Furniture, type Wall } from "../types/floorplan";

type Size3 = { x: number; y: number; z: number };

export const MIN_FURNITURE_SCALE_FACTOR = 0.1;
export const MAX_FURNITURE_SCALE_FACTOR = 3;

export function normalizeFurnitureScaleFactor(factor: number) {
  if (!Number.isFinite(factor)) return 1;
  return Math.max(
    MIN_FURNITURE_SCALE_FACTOR,
    Math.min(MAX_FURNITURE_SCALE_FACTOR, factor),
  );
}

export function scaleFurnitureByFactor(furniture: Furniture[], factor: number) {
  if (factor === 1) return furniture;
  return furniture.map((item) => ({
    ...item,
    width: item.width * factor,
    depth: item.depth * factor,
    height: item.height * factor,
  }));
}

/** Fits an asset within catalog bounds without changing its proportions. */
export function uniformFurnitureModelScale(source: Size3, target: Size3) {
  return Math.min(
    target.x / Math.max(source.x, 0.001),
    target.y / Math.max(source.y, 0.001),
    target.z / Math.max(source.z, 0.001),
  );
}

/** Uses the median wall height to estimate one consistent furniture scale. */
export function getFurnitureScaleFromWalls(walls: readonly Wall[]) {
  const heights = walls
    .map((wall) => wall.height)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return 1;

  const middle = Math.floor(heights.length / 2);
  const wallHeight = heights.length % 2 === 0
    ? (heights[middle - 1] + heights[middle]) / 2
    : heights[middle];
  return Math.max(0.5, Math.min(1.5, wallHeight / DEFAULTS.wallHeight));
}

export function scaleFurnitureToWalls(furniture: Furniture[], walls: readonly Wall[]) {
  const scale = getFurnitureScaleFromWalls(walls);
  if (scale === 1) return furniture;
  return furniture.map((item) => ({
    ...item,
    width: item.width * scale,
    depth: item.depth * scale,
    height: item.height * scale,
  }));
}
