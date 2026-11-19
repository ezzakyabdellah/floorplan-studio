import { describe, expect, it } from "vitest";
import {
  solveFloorPlanLayout,
  validateSemanticFloorPlan,
} from "./floorPlanLayoutSolver";

type LayoutRect = {
  id: string;
  x_m: number;
  y_m: number;
  width_m: number;
  height_m: number;
};

function areRoomsAdjacent(a: LayoutRect, b: LayoutRect) {
  const verticalOverlap =
    Math.min(a.y_m + a.height_m, b.y_m + b.height_m) - Math.max(a.y_m, b.y_m);
  const horizontalOverlap =
    Math.min(a.x_m + a.width_m, b.x_m + b.width_m) - Math.max(a.x_m, b.x_m);
  return (
    (Math.abs(a.x_m + a.width_m - b.x_m) < 1e-6 ||
      Math.abs(b.x_m + b.width_m - a.x_m) < 1e-6) &&
    verticalOverlap > 1e-6
  ) || (
    (Math.abs(a.y_m + a.height_m - b.y_m) < 1e-6 ||
      Math.abs(b.y_m + b.height_m - a.y_m) < 1e-6) &&
    horizontalOverlap > 1e-6
  );
}

function connectedRoomIds(rooms: LayoutRect[]) {
  const reached = new Set([rooms[0].id]);
  let updated = true;
  while (updated) {
    updated = false;
    for (const room of rooms) {
      if (reached.has(room.id)) continue;
      if (
        rooms.some(
          (other) =>
            reached.has(other.id) && areRoomsAdjacent(room, other),
        )
      ) {
        reached.add(room.id);
        updated = true;
      }
    }
  }
  return reached;
}

describe("deterministic floor-plan layout solver", () => {
  it("snaps rooms to the metric grid, keeps practical proportions, and makes one connected layout", () => {
    const plan = validateSemanticFloorPlan({
      grid_unit_m: 0.5,
      entrance_room: "living",
      rooms: [
        { id: "living", type: "living_room", area_m2: 28, zone: "front", windows: 2 },
        { id: "kitchen", type: "kitchen", area_m2: 13, zone: "service", windows: 1 },
        { id: "bed_1", type: "bedroom", area_m2: 15, zone: "private", windows: 1 },
        { id: "bath", type: "bathroom", area_m2: 5, zone: "service", windows: 0 },
        { id: "hall", type: "hallway", area_m2: 6, zone: "core", windows: 0 },
      ],
      links: [
        { from: "living", to: "hall", connection: "open" },
        { from: "hall", to: "kitchen", connection: "door" },
        { from: "kitchen", to: "bed_1", connection: "door" },
        { from: "bed_1", to: "bath", connection: "door" },
      ],
    });
    const solved = solveFloorPlanLayout(plan);

    expect(solved.rooms).toHaveLength(plan.rooms.length);
    expect(solved.rooms.find((room) => room.id === "living")?.y_m).toBe(0);
    for (const room of solved.rooms) {
      for (const dimension of [room.x_m, room.y_m, room.width_m, room.height_m]) {
        expect(dimension / plan.grid_unit_m).toBeCloseTo(
          Math.round(dimension / plan.grid_unit_m),
        );
      }
      const ratio = Math.max(room.width_m, room.height_m) /
        Math.min(room.width_m, room.height_m);
      expect(ratio).toBeGreaterThanOrEqual(1);
      expect(ratio).toBeLessThanOrEqual(2);
    }

    for (let first = 0; first < solved.rooms.length; first += 1) {
      for (let second = first + 1; second < solved.rooms.length; second += 1) {
        const a = solved.rooms[first];
        const b = solved.rooms[second];
        const overlapX =
          Math.min(a.x_m + a.width_m, b.x_m + b.width_m) -
          Math.max(a.x_m, b.x_m);
        const overlapY =
          Math.min(a.y_m + a.height_m, b.y_m + b.height_m) -
          Math.max(a.y_m, b.y_m);
        expect(overlapX > 1e-6 && overlapY > 1e-6).toBe(false);
      }
    }
    expect(connectedRoomIds(solved.rooms).size).toBe(solved.rooms.length);
  });

  it("places centered shared-wall openings and an exterior entrance door", () => {
    const plan = validateSemanticFloorPlan({
      grid_unit_m: 0.5,
      entrance_room: "living",
      rooms: [
        { id: "living", type: "living_room", area_m2: 25, zone: "front", windows: 0 },
        { id: "bedroom", type: "bedroom", area_m2: 25, zone: "front", windows: 0 },
      ],
      links: [{ from: "living", to: "bedroom", connection: "arch" }],
    });
    const solved = solveFloorPlanLayout(plan);
    const entry = solved.openings.find((opening) => opening.id === "ai-entrance-door")!;
    const arch = solved.openings.find((opening) => opening.id.startsWith("ai-link-"))!;

    expect(entry.type).toBe("door");
    expect(entry.positionOnWall).toBeCloseTo(0.5);
    expect(entry.width * 0.3048).toBeCloseTo(0.9, 2);
    expect(arch.type).toBe("door");
    expect(arch.positionOnWall).toBeCloseTo(0.5);
    expect(arch.width * 0.3048).toBeCloseTo(1.5, 2);
    expect(solved.walls.find((wall) => wall.id === entry.wallId)?.y1).toBe(0);
    expect(solved.warnings).toEqual([]);
  });

  it("anchors a linked room across zone rows when their areas require separate bands", () => {
    const plan = validateSemanticFloorPlan({
      grid_unit_m: 0.5,
      entrance_room: "living",
      rooms: [
        { id: "living", type: "living_room", area_m2: 25, zone: "front", windows: 0 },
        { id: "great_room", type: "great_room", area_m2: 100, zone: "front", windows: 0 },
      ],
      links: [{ from: "living", to: "great_room", connection: "door" }],
    });
    const solved = solveFloorPlanLayout(plan);
    const living = solved.rooms.find((room) => room.id === "living")!;
    const greatRoom = solved.rooms.find((room) => room.id === "great_room")!;

    expect(areRoomsAdjacent(living, greatRoom)).toBe(true);
    expect(solved.openings.some((opening) => opening.id.startsWith("ai-link-"))).toBe(
      true,
    );
  });

  it("clamps window counts when a room has limited exterior wall and reports the shortfall", () => {
    const plan = validateSemanticFloorPlan({
      grid_unit_m: 0.5,
      entrance_room: "only_room",
      rooms: [
        { id: "only_room", type: "bathroom", area_m2: 0.25, zone: "front", windows: 8 },
      ],
      links: [],
    });
    const solved = solveFloorPlanLayout(plan);
    const windows = solved.openings.filter((opening) => opening.type === "window");

    expect(windows.length).toBeGreaterThan(0);
    expect(windows.length).toBeLessThan(8);
    expect(solved.warnings.some((warning) => warning.includes("requested 8 window(s)"))).toBe(
      true,
    );
    expect(
      windows.every((opening) =>
        solved.walls.some((wall) => wall.id === opening.wallId),
      ),
    ).toBe(true);
  });

  it("warns instead of failing when requested windows belong to an enclosed room", () => {
    const plan = validateSemanticFloorPlan({
      grid_unit_m: 0.5,
      entrance_room: "top",
      rooms: [
        { id: "top", type: "living_room", area_m2: 100, zone: "front", windows: 0 },
        { id: "bath", type: "bathroom", area_m2: 25, zone: "core", windows: 0 },
        { id: "left", type: "bedroom", area_m2: 25, zone: "core", windows: 2 },
        { id: "right", type: "bedroom", area_m2: 25, zone: "core", windows: 0 },
        { id: "bottom", type: "bedroom", area_m2: 100, zone: "private", windows: 0 },
      ],
      links: [
        { from: "top", to: "bath", connection: "door" },
        { from: "bath", to: "left", connection: "door" },
        { from: "bath", to: "right", connection: "door" },
        { from: "bath", to: "bottom", connection: "door" },
      ],
    });
    const solved = solveFloorPlanLayout(plan);

    expect(solved.rooms).toHaveLength(5);
    expect(solved.openings.filter((opening) => opening.type === "window")).toHaveLength(
      0,
    );
    expect(solved.warnings.some((warning) => warning.includes('Room "left" requested 2'))).toBe(
      true,
    );
  });

  it("keeps target areas and places every linked door for a three-bedroom plan", () => {
    const plan = validateSemanticFloorPlan({
      grid_unit_m: 0.5,
      entrance_room: "living_room",
      rooms: [
        { id: "living_room", type: "living_room", area_m2: 30, zone: "front", windows: 4 },
        { id: "kitchen", type: "kitchen", area_m2: 15, zone: "service", windows: 2 },
        { id: "bedroom1", type: "bedroom", area_m2: 20, zone: "private", windows: 1 },
        { id: "bedroom2", type: "bedroom", area_m2: 20, zone: "private", windows: 1 },
        { id: "bedroom3", type: "bedroom", area_m2: 20, zone: "private", windows: 1 },
        { id: "bathroom1", type: "bathroom", area_m2: 5, zone: "service", windows: 0 },
        { id: "bathroom2", type: "bathroom", area_m2: 5, zone: "service", windows: 0 },
        { id: "storage", type: "storage", area_m2: 10, zone: "service", windows: 0 },
      ],
      links: [
        { from: "living_room", to: "kitchen", connection: "door" },
        { from: "kitchen", to: "bedroom1", connection: "door" },
        { from: "bedroom1", to: "bathroom1", connection: "door" },
        { from: "bedroom1", to: "bedroom2", connection: "door" },
        { from: "bedroom2", to: "bathroom2", connection: "door" },
        { from: "bedroom2", to: "bedroom3", connection: "door" },
        { from: "bedroom3", to: "storage", connection: "door" },
      ],
    });
    const solved = solveFloorPlanLayout(plan);
    const solvedArea = solved.rooms.reduce(
      (total, room) => total + room.width_m * room.height_m,
      0,
    );
    const targetArea = plan.rooms.reduce((total, room) => total + room.area_m2, 0);

    expect(Math.abs(solvedArea - targetArea) / targetArea).toBeLessThan(0.2);
    expect(solved.openings.filter((opening) => opening.type === "door")).toHaveLength(
      plan.links.length + 1,
    );
    expect(solved.warnings).toEqual([]);
  });
});
