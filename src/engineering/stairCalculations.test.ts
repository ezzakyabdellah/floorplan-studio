import { describe, expect, it } from "vitest";
import { calculateStairGeometry } from "./stairCalculations";
import { formatLength } from "./units";
import { runBuildingCodeAudit } from "./buildingCodeAudit";
import { createDefaultProjectState } from "./projectStore";

describe("stair geometry", () => {
  it("calculates even risers, treads, stringer and cut angles", () => {
    const result = calculateStairGeometry(
      { totalRise: 108, totalRun: 132 },
      "imperial",
    );

    expect(result.stepCount).toBe(14);
    expect(result.treadCount).toBe(13);
    expect(result.unitRiseExact).toBeCloseTo(108 / 14, 10);
    expect(result.unitRunExact).toBeCloseTo(132 / 13, 10);
    expect(result.stringerLength).toBe(170.5625);
    expect(result.pitchAngleDegrees).toBe(39.29);
    expect(result.plumbCutAngleDegrees + result.levelCutAngleDegrees).toBe(90);
  });

  it("keeps metric dimensional inputs at millimetre precision", () => {
    const result = calculateStairGeometry(
      { totalRise: 2743, totalRun: 3353 },
      "metric",
    );
    expect(result.stepCount).toBe(14);
    expect(Number.isInteger(result.unitRise)).toBe(true);
    expect(Number.isInteger(result.stringerLength)).toBe(true);
  });

  it("formats imperial lengths in reduced sixteenth-inch fractions", () => {
    expect(formatLength(7.6875, "imperial")).toBe("7 11/16 in");
    expect(formatLength(36, "imperial")).toBe("36 in");
    expect(formatLength(0.5, "imperial")).toBe("1/2 in");
    expect(formatLength(914.4, "metric")).toBe("914 mm");
  });

  it("uses site-measured headroom and cites deterministic audit rules", () => {
    const project = createDefaultProjectState();
    expect(runBuildingCodeAudit(project).allPassing).toBe(true);

    const noMeasurement = {
      ...project,
      stairParams: { ...project.stairParams, headroomClearance: null },
    };
    const report = runBuildingCodeAudit(noMeasurement);
    const headroom = report.findings.find((item) => item.id === "stair-headroom");
    expect(headroom?.status).toBe("warning");
    expect(headroom?.citation).toContain("IRC R311.7.2");
    expect(report.disclaimer).toContain("local building official");
  });
});
