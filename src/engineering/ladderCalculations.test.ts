import { describe, expect, it } from "vitest";
import { calculateLadderGeometry } from "./ladderCalculations";
import { createDefaultProjectState } from "./projectStore";
import { runBuildingCodeAudit } from "./buildingCodeAudit";

describe("ladder geometry", () => {
  it("calculates the 4:1 setup and extension ladder allowance", () => {
    const result = calculateLadderGeometry(144, "imperial", "extension");
    expect(result.baseSetback).toBe(36);
    expect(result.ladderAngleDegrees).toBeCloseTo(75.96, 2);
    expect(result.roofExtension).toBe(36);
    expect(result.minimumOverlap).toBe(36);
    expect(result.sectionCount).toBe(2);
  });

  it("does not apply the leaning-ladder setback to a step ladder", () => {
    const result = calculateLadderGeometry(144, "imperial", "step");
    expect(result.baseSetback).toBe(0);
    expect(result.roofExtension).toBe(0);
    expect(result.sectionCount).toBe(1);

    const project = {
      ...createDefaultProjectState(),
      projectType: "ladder" as const,
      ladderParams: {
        ...createDefaultProjectState().ladderParams,
        ladderType: "step" as const,
      },
    };
    expect(runBuildingCodeAudit(project).findings[0].title).toBe(
      "Self-supporting ladder setup",
    );
  });

  it("uses conservative metric setback rounding", () => {
    const result = calculateLadderGeometry(1001, "metric");
    expect(result.baseSetback).toBe(251);
    expect(result.baseSetback).toBeGreaterThanOrEqual(1001 / 4);
  });
});
