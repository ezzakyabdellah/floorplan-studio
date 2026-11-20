import { describe, expect, it } from "vitest";
import {
  critiqueFloorPlanLayout,
  type LayoutDiagnostic,
} from "./floorPlanLayoutCritique";
import {
  solveFloorPlanLayout,
  type SemanticFloorPlan,
  type SolvedFloorPlan,
} from "./floorPlanLayoutSolver";

function plan(overrides: Partial<SemanticFloorPlan> = {}): SemanticFloorPlan {
  return {
    grid_unit_m: 0.5,
    entrance_room: "living",
    rooms: [
      { id: "living", type: "living_room", area_m2: 25, zone: "front", windows: 1 },
      { id: "bedroom", type: "bedroom", area_m2: 25, zone: "front", windows: 1 },
    ],
    links: [{ from: "living", to: "bedroom", connection: "door" }],
    ...overrides,
  };
}

function diagnosticCodes(diagnostics: LayoutDiagnostic[]) {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe("floor-plan geometry critique", () => {
  it("accepts a snapped, connected plan with shared links and exterior windows", () => {
    const semantic = plan();
    const solved = solveFloorPlanLayout(semantic);

    expect(critiqueFloorPlanLayout(semantic, solved)).toEqual([]);
  });

  it("reports a requested window on a habitable room with no exterior wall", () => {
    const semantic: SemanticFloorPlan = {
      grid_unit_m: 0.5,
      entrance_room: "top",
      rooms: [
        { id: "top", type: "living_room", area_m2: 100, zone: "front", windows: 0 },
        { id: "bath", type: "bathroom", area_m2: 25, zone: "core", windows: 0 },
        { id: "middle", type: "bedroom", area_m2: 25, zone: "core", windows: 2 },
        { id: "right", type: "bedroom", area_m2: 25, zone: "core", windows: 0 },
        { id: "bottom", type: "bedroom", area_m2: 100, zone: "private", windows: 0 },
      ],
      links: [],
    };
    const solved: SolvedFloorPlan = {
      rooms: [
        { id: "top", type: "living_room", zone: "front", area_m2: 100, x_m: 0, y_m: 0, width_m: 20, height_m: 5 },
        { id: "bath", type: "bathroom", zone: "core", area_m2: 25, x_m: 0, y_m: 5, width_m: 5, height_m: 5 },
        { id: "middle", type: "bedroom", zone: "core", area_m2: 25, x_m: 5, y_m: 5, width_m: 5, height_m: 5 },
        { id: "right", type: "bedroom", zone: "core", area_m2: 25, x_m: 10, y_m: 5, width_m: 5, height_m: 5 },
        { id: "bottom", type: "bedroom", zone: "private", area_m2: 100, x_m: 0, y_m: 10, width_m: 20, height_m: 5 },
      ],
      walls: [],
      openings: [],
      warnings: [],
    };
    const diagnostics = critiqueFloorPlanLayout(semantic, solved);

    expect(diagnosticCodes(diagnostics)).toContain("no-exterior-wall");
    expect(diagnostics.find((diagnostic) => diagnostic.code === "no-exterior-wall")?.roomIds)
      .toContain("middle");
  });

  it("reports links without shared walls and excessive total area drift", () => {
    const semantic: SemanticFloorPlan = {
      grid_unit_m: 0.5,
      entrance_room: "entry",
      rooms: [
        { id: "entry", type: "living_room", area_m2: 25, zone: "front", windows: 0 },
        { id: "hall", type: "hallway", area_m2: 25, zone: "core", windows: 0 },
        { id: "utility", type: "utility", area_m2: 25, zone: "service", windows: 0 },
        { id: "bedroom", type: "bedroom", area_m2: 25, zone: "private", windows: 0 },
      ],
      links: [
        { from: "entry", to: "hall", connection: "door" },
        { from: "hall", to: "utility", connection: "door" },
        { from: "utility", to: "bedroom", connection: "door" },
        { from: "entry", to: "bedroom", connection: "door" },
      ],
    };
    const solved: SolvedFloorPlan = {
      rooms: [
        { id: "entry", type: "living_room", zone: "front", area_m2: 25, x_m: 0, y_m: 0, width_m: 5, height_m: 5 },
        { id: "hall", type: "hallway", zone: "core", area_m2: 25, x_m: 6, y_m: 0, width_m: 5, height_m: 5 },
        { id: "utility", type: "utility", zone: "service", area_m2: 25, x_m: 0, y_m: 6, width_m: 5, height_m: 5 },
        { id: "bedroom", type: "bedroom", zone: "private", area_m2: 25, x_m: 6, y_m: 6, width_m: 5, height_m: 5 },
      ],
      walls: [],
      openings: [],
      warnings: [],
    };

    expect(diagnosticCodes(critiqueFloorPlanLayout(semantic, solved))).toContain(
      "missing-shared-wall",
    );

    const tiny = plan({
      rooms: [
        { id: "living", type: "living_room", area_m2: 0.1, zone: "front", windows: 0 },
      ],
      links: [],
    });
    expect(
      diagnosticCodes(critiqueFloorPlanLayout(tiny, solveFloorPlanLayout(tiny))),
    ).toContain("area-drift");
  });

  it("reports a shared wall without a door and an unreachable room", () => {
    const semantic: SemanticFloorPlan = {
      grid_unit_m: 0.5,
      entrance_room: "living",
      rooms: [
        { id: "living", type: "living_room", area_m2: 25, zone: "front", windows: 0 },
        { id: "bedroom", type: "bedroom", area_m2: 25, zone: "private", windows: 0 },
      ],
      links: [{ from: "living", to: "bedroom", connection: "door" }],
    };
    const solved: SolvedFloorPlan = {
      rooms: [
        { id: "living", type: "living_room", zone: "front", area_m2: 25, x_m: 0, y_m: 0, width_m: 5, height_m: 5 },
        { id: "bedroom", type: "bedroom", zone: "private", area_m2: 25, x_m: 5, y_m: 0, width_m: 5, height_m: 5 },
      ],
      walls: [
        {
          id: "shared",
          x1: 5 / 0.3048,
          y1: 0,
          x2: 5 / 0.3048,
          y2: 5 / 0.3048,
          thickness: 0.5,
          height: 8,
        },
      ],
      openings: [],
      warnings: [],
    };
    const codes = diagnosticCodes(critiqueFloorPlanLayout(semantic, solved));

    expect(codes).toContain("link-without-opening");
    expect(codes).toContain("unreachable-room");
  });

  it("reports overlaps and disconnected geometry", () => {
    const semantic = plan({
      rooms: [
        { id: "living", type: "living_room", area_m2: 25, zone: "front", windows: 0 },
        { id: "bedroom", type: "bedroom", area_m2: 25, zone: "front", windows: 0 },
      ],
      links: [],
    });
    const solved: SolvedFloorPlan = {
      rooms: [
        {
          id: "living",
          type: "living_room",
          zone: "front",
          area_m2: 25,
          x_m: 0,
          y_m: 0,
          width_m: 5,
          height_m: 5,
        },
        {
          id: "bedroom",
          type: "bedroom",
          zone: "front",
          area_m2: 25,
          x_m: 4,
          y_m: 4,
          width_m: 5,
          height_m: 5,
        },
      ],
      walls: [],
      openings: [],
      warnings: [],
    };

    expect(diagnosticCodes(critiqueFloorPlanLayout(semantic, solved))).toEqual(
      expect.arrayContaining(["room-overlap", "disconnected-geometry"]),
    );
  });
});
