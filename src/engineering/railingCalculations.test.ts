import { describe, expect, it } from "vitest";
import { calculateBalusterSpacing } from "./railingCalculations";

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
});
