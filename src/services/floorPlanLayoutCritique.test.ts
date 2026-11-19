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
    const solved = solveFloorPlanLayout(semantic);
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
        { id: "bedroom", type: "bedroom", area_m2: 25, zone: "private", windows: 0 },
      ],
      links: [{ from: "entry", to: "bedroom", connection: "door" }],
    };
    const solved = solveFloorPlanLayout(semantic);

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
