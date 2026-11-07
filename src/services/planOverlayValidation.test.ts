import { describe, expect, it } from "vitest";
import type { Opening, Wall } from "../types/floorplan";
import {
  OVERLAY_PALETTE,
  validatePlanOverlay,
} from "./planOverlayValidation";

const WIDTH = 64;
const HEIGHT = 64;
const TRANSFORM = {
  imageWidth: WIDTH,
  imageHeight: HEIGHT,
  scale: 1,
  padX: 0,
  padY: 0,
};
const META = {
  minX: 0,
  minY: 0,
  margin: 0,
  feetPerPixel: 1,
};

function createOverlay(
  paint: (set: (x: number, y: number, color: [number, number, number]) => void) => void,
) {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    const pixel = index * 3;
    rgb[pixel] = 100;
    rgb[pixel + 1] = 100;
    rgb[pixel + 2] = 100;
  }

  const set = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const pixel = (y * WIDTH + x) * 3;
    rgb[pixel] = color[0];
    rgb[pixel + 1] = color[1];
    rgb[pixel + 2] = color[2];
  };

  paint(set);
  return rgb;
}

const wall: Wall = {
  id: "wall-1",
  x1: 8,
  y1: 32,
  x2: 56,
  y2: 32,
  thickness: 2,
  height: 8,
};

describe("validatePlanOverlay", () => {
  it("reports full coverage when the plan matches the overlay", () => {
    const overlay = createOverlay((set) => {
      for (let x = 8; x <= 56; x += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          set(x, 32 + dy, OVERLAY_PALETTE[1]);
        }
      }
    });

    const report = validatePlanOverlay(
      overlay,
      WIDTH,
      HEIGHT,
      { walls: [wall], openings: [] },
      TRANSFORM,
      META,
    );

    expect(report.wallCoverage).toBeGreaterThan(0.99);
    expect(report.wallPrecision).toBeGreaterThan(0.99);
    expect(report.missingWallRegions).toHaveLength(0);
    expect(report.missingOpenings).toHaveLength(0);
  });

  it("flags a wall that is missing from the plan", () => {
    const overlay = createOverlay((set) => {
      for (let x = 8; x <= 56; x += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          set(x, 32 + dy, OVERLAY_PALETTE[1]);
        }
      }
    });

    const report = validatePlanOverlay(
      overlay,
      WIDTH,
      HEIGHT,
      { walls: [], openings: [] },
      TRANSFORM,
      META,
    );

    expect(report.wallCoverage).toBeLessThan(0.05);
    expect(report.missingWallRegions.length).toBeGreaterThan(0);
  });

  it("flags a door that the plan did not keep", () => {
    const overlay = createOverlay((set) => {
      for (let x = 8; x <= 56; x += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          set(x, 32 + dy, OVERLAY_PALETTE[1]);
        }
      }
      for (let x = 20; x <= 28; x += 1) {
        for (let dy = -3; dy <= 3; dy += 1) {
          set(x, 32 + dy, OVERLAY_PALETTE[2]);
        }
      }
    });

    const withDoor: Opening = {
      id: "opening-1",
      wallId: wall.id,
      type: "door",
      positionOnWall: (24 - 8) / (56 - 8),
      width: 8,
    };
    const matched = validatePlanOverlay(
      overlay,
      WIDTH,
      HEIGHT,
      { walls: [wall], openings: [withDoor] },
      TRANSFORM,
      META,
    );
    expect(matched.missingOpenings).toHaveLength(0);
    expect(matched.matchedDoorPixels).toBeGreaterThan(0);

    const missing = validatePlanOverlay(
      overlay,
      WIDTH,
      HEIGHT,
      { walls: [wall], openings: [] },
      TRANSFORM,
      META,
    );
    expect(missing.missingOpenings).toHaveLength(1);
    expect(missing.missingOpenings[0].type).toBe("door");
  });

  it("does not count a nearby door endpoint as an attached opening", () => {
    const overlay = createOverlay((set) => {
      for (let x = 8; x <= 56; x += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          set(x, 32 + dy, OVERLAY_PALETTE[1]);
        }
      }
      for (let x = 20; x <= 28; x += 1) {
        for (let dy = -3; dy <= 3; dy += 1) {
          set(x, 32 + dy, OVERLAY_PALETTE[2]);
        }
      }
    });
    const adjacentDoor: Opening = {
      id: "opening-adjacent",
      wallId: wall.id,
      type: "door",
      positionOnWall: 1 / 6,
      width: 8,
    };

    const report = validatePlanOverlay(
      overlay,
      WIDTH,
      HEIGHT,
      { walls: [wall], openings: [adjacentDoor] },
      TRANSFORM,
      META,
    );

    expect(report.missingOpenings).toHaveLength(1);
    expect(report.missingOpenings[0].matchedRatio).toBeLessThan(0.35);
  });
});
