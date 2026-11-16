import { describe, expect, it } from "vitest";
import type { Furniture, Wall } from "../types/floorplan";
import {
  getFurnitureScaleFromWalls,
  normalizeFurnitureScaleFactor,
  scaleFurnitureByFactor,
  scaleFurnitureToWalls,
  uniformFurnitureModelScale,
} from "./furnitureScale";

const wall = (height: number): Wall => ({
  id: `wall-${height}`,
  x1: 0,
  y1: 0,
  x2: 12,
  y2: 0,
  thickness: 0.5,
  height,
});

const bed: Furniture = {
  id: "bed",
  roomId: 0,
  kind: "bed",
  source: "geometry",
  roomLabel: "Bedroom",
  x: 5,
  y: 5,
  width: 5.2,
  depth: 6.8,
  height: 2.4,
  rotation: 0,
  confidence: 1,
};

describe("furniture wall-height scaling", () => {
  it("uses one median wall height relative to the standard 8 ft wall", () => {
    expect(getFurnitureScaleFromWalls([])).toBe(1);
    expect(getFurnitureScaleFromWalls([wall(8), wall(10), wall(12)])).toBe(1.25);
    expect(getFurnitureScaleFromWalls([wall(4), wall(4)])).toBe(0.5);
  });

  it("applies the same wall scale to every furniture dimension", () => {
    const [scaled] = scaleFurnitureToWalls([bed], [wall(10)]);

    expect(scaled.width).toBeCloseTo(6.5);
    expect(scaled.depth).toBeCloseTo(8.5);
    expect(scaled.height).toBeCloseTo(3);
    expect(scaled.x).toBe(bed.x);
    expect(scaled.y).toBe(bed.y);
  });

  it("fits imported models uniformly without changing their proportions", () => {
    const scale = uniformFurnitureModelScale(
      { x: 2, y: 1, z: 1 },
      { x: 4, y: 5, z: 3 },
    );

    expect(scale).toBe(2);
    expect({ x: 2 * scale, y: scale, z: scale }).toEqual({ x: 4, y: 2, z: 2 });
  });
});

describe("user furniture scale factor", () => {
  it("scales all furniture dimensions uniformly", () => {
    const [scaled] = scaleFurnitureByFactor([bed], 0.5);

    expect(scaled.width).toBe(2.6);
    expect(scaled.depth).toBe(3.4);
    expect(scaled.height).toBe(1.2);
    expect(scaled.x).toBe(bed.x);
    expect(scaled.y).toBe(bed.y);
  });

  it("clamps factors to the supported range and defaults invalid values", () => {
    expect(normalizeFurnitureScaleFactor(0)).toBe(0.1);
    expect(normalizeFurnitureScaleFactor(5)).toBe(3);
    expect(normalizeFurnitureScaleFactor(Number.NaN)).toBe(1);
  });
});
