import { describe, expect, it } from "vitest";
import {
  calculateBalusterSpacing,
  calculateRailingRun,
} from "./railingCalculations";
import { createDefaultProjectState } from "./projectStore";

describe("baluster spacing", () => {
  it("evenly divides a run without exceeding the 4-inch opening rule", () => {
    const result = calculateBalusterSpacing(132, 4, 1.5, "imperial");
    expect(result.balusterCount).toBeGreaterThan(0);
    expect(result.clearGapExact).toBeLessThanOrEqual(4);
    expect(result.clearGap).toBeLessThanOrEqual(4);
  });

  it("caps user-selected spacing at 100 mm in metric projects", () => {
    const result = calculateBalusterSpacing(1000, 180, 38, "metric");
    expect(result.maxAllowedGap).toBe(100);
    expect(result.clearGapExact).toBeLessThanOrEqual(100);
  });

  it("rejects invalid dimensions", () => {
    expect(() => calculateBalusterSpacing(0, 4, 1.5, "imperial")).toThrow(
      "Railing run",
    );
  });

  it("calculates railing length along the sloped flight and L/U landings", () => {
    const project = createDefaultProjectState();
    expect(calculateRailingRun(project.stairParams, project.units)).toBe(
      project.calculatedMetrics.stringerLength,
    );
    const lStair = { ...project.stairParams, style: "l-shaped" as const };
    expect(calculateRailingRun(lStair, project.units)).toBeGreaterThan(
      project.calculatedMetrics.stringerLength,
    );
    expect(
      calculateRailingRun(
        { ...lStair, railingRunOverride: 180 },
        project.units,
      ),
    ).toBe(180);
  });
});
