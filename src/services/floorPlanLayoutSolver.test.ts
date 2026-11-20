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

  it("replaces the staircase layout with a compact, walkable plan for the 11-room case", () => {
    const plan = validateSemanticFloorPlan({
      grid_unit_m: 0.5,
      entrance_room: "foyer_1",
      rooms: [
        { id: "foyer_1", type: "hallway", area_m2: 6, zone: "front", windows: 0 },
        { id: "living_1", type: "living_room", area_m2: 25, zone: "front", windows: 2 },
        { id: "dining_1", type: "dining_room", area_m2: 12, zone: "front", windows: 1 },
        { id: "kitchen_1", type: "kitchen", area_m2: 10, zone: "service", windows: 1 },
        { id: "hall_1", type: "hallway", area_m2: 8, zone: "core", windows: 0 },
        { id: "bed_1", type: "bedroom", area_m2: 16, zone: "private", windows: 1 },
        { id: "bed_2", type: "bedroom", area_m2: 12, zone: "private", windows: 1 },
        { id: "bed_3", type: "bedroom", area_m2: 11, zone: "private", windows: 1 },
        { id: "bath_1", type: "bathroom", area_m2: 6, zone: "service", windows: 0 },
        { id: "bath_2", type: "bathroom", area_m2: 4, zone: "service", windows: 0 },
        { id: "storage_1", type: "storage", area_m2: 3, zone: "service", windows: 0 },
      ],
      links: [
        { from: "foyer_1", to: "living_1", connection: "door" },
        { from: "foyer_1", to: "hall_1", connection: "door" },
        { from: "foyer_1", to: "storage_1", connection: "door" },
        { from: "living_1", to: "dining_1", connection: "arch" },
        { from: "dining_1", to: "kitchen_1", connection: "door" },
        { from: "hall_1", to: "bed_1", connection: "door" },
        { from: "hall_1", to: "bed_2", connection: "door" },
        { from: "hall_1", to: "bed_3", connection: "door" },
        { from: "hall_1", to: "bath_1", connection: "door" },
        { from: "bed_1", to: "bath_2", connection: "door" },
      ],
    });
    const solved = solveFloorPlanLayout(plan);

    expect(solved.rooms).toHaveLength(plan.rooms.length);

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

    for (const room of solved.rooms) {
      expect(Math.min(room.width_m, room.height_m)).toBeGreaterThanOrEqual(1 - 1e-6);
    }

    const minX = Math.min(...solved.rooms.map((room) => room.x_m));
    const minY = Math.min(...solved.rooms.map((room) => room.y_m));
    const maxX = Math.max(...solved.rooms.map((room) => room.x_m + room.width_m));
    const maxY = Math.max(...solved.rooms.map((room) => room.y_m + room.height_m));
    const roomArea = solved.rooms.reduce(
      (total, room) => total + room.width_m * room.height_m,
      0,
    );
    expect(roomArea / ((maxX - minX) * (maxY - minY))).toBeGreaterThanOrEqual(0.9);

    // Every room must be reachable through door openings.
    const feetToMeters = 0.3048;
    const roomsByWall = new Map<string, string[]>();
    for (const wall of solved.walls) {
      const x1 = wall.x1 * feetToMeters;
      const y1 = wall.y1 * feetToMeters;
      const x2 = wall.x2 * feetToMeters;
      const y2 = wall.y2 * feetToMeters;
      const horizontal = Math.abs(y1 - y2) < 1e-6;
      const ids = solved.rooms
        .filter((room) => {
          if (horizontal) {
            const onEdge =
              Math.abs(room.y_m - y1) < 1e-6 ||
              Math.abs(room.y_m + room.height_m - y1) < 1e-6;
            const overlap =
              Math.min(room.x_m + room.width_m, Math.max(x1, x2)) -
              Math.max(room.x_m, Math.min(x1, x2));
            return onEdge && overlap > 1e-6;
          }
          const onEdge =
            Math.abs(room.x_m - x1) < 1e-6 ||
            Math.abs(room.x_m + room.width_m - x1) < 1e-6;
          const overlap =
            Math.min(room.y_m + room.height_m, Math.max(y1, y2)) -
            Math.max(room.y_m, Math.min(y1, y2));
          return onEdge && overlap > 1e-6;
        })
        .map((room) => room.id);
      roomsByWall.set(wall.id, ids);
    }

    const adjacency = new Map<string, Set<string>>(
      solved.rooms.map((room) => [room.id, new Set<string>()]),
    );
    for (const opening of solved.openings) {
      if (opening.type !== "door") continue;
      const roomIds = roomsByWall.get(opening.wallId) ?? [];
      if (roomIds.length !== 2) continue;
      adjacency.get(roomIds[0])?.add(roomIds[1]);
      adjacency.get(roomIds[1])?.add(roomIds[0]);
    }
    const reached = new Set([plan.entrance_room]);
    const queue = [plan.entrance_room];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const neighbour of adjacency.get(id) ?? []) {
        if (reached.has(neighbour)) continue;
        reached.add(neighbour);
        queue.push(neighbour);
      }
    }
    expect(reached.size).toBe(plan.rooms.length);
    expect(
      solved.warnings.some((warning) => warning.includes("could not be connected")),
    ).toBe(false);
  });
});
