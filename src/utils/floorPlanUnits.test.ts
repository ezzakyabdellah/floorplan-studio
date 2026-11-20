import { describe, expect, it } from "vitest";
import {
  displayLengthToFeet,
  feetToDisplayLength,
  floorPlanInputStep,
  formatFeetLength,
  formatFeetNumber,
  gridStepFor,
  isFloorPlanUnit,
} from "./floorPlanUnits";

describe("floor plan display units", () => {
  it("converts feet into imperial and metric display units", () => {
    expect(feetToDisplayLength(20, "ft")).toBe(20);
    expect(feetToDisplayLength(20, "in")).toBe(240);
    expect(feetToDisplayLength(20, "mm")).toBeCloseTo(6096, 6);
    expect(feetToDisplayLength(20, "cm")).toBeCloseTo(609.6, 6);
    expect(feetToDisplayLength(20, "m")).toBeCloseTo(6.096, 6);
  });

  it("converts display values back to feet", () => {
    expect(displayLengthToFeet(240, "in")).toBeCloseTo(20, 6);
    expect(displayLengthToFeet(6.096, "m")).toBeCloseTo(20, 6);
    expect(displayLengthToFeet(6096, "mm")).toBeCloseTo(20, 6);
  });

  it("formats lengths with the selected unit", () => {
    expect(formatFeetLength(20, "ft")).toBe("20 ft");
    expect(formatFeetLength(3, "ft")).toBe("3 ft");
    expect(formatFeetNumber(20, "m")).toBe("6.096");
    expect(formatFeetLength(20, "cm")).toBe("609.6 cm");
    expect(formatFeetLength(20, "mm")).toBe("6096 mm");
  });

  it("validates unit values and provides input steps", () => {
    expect(isFloorPlanUnit("m")).toBe(true);
    expect(isFloorPlanUnit("yards")).toBe(false);
    expect(floorPlanInputStep("ft")).toBe(0.1);
    expect(floorPlanInputStep("mm")).toBe(10);
  });

  it("chooses readable grid intervals for the current zoom", () => {
    expect(gridStepFor("ft", 20)).toBe(1);
    expect(gridStepFor("ft", 5)).toBe(2);
    expect(gridStepFor("ft", 2)).toBe(5);
    expect(gridStepFor("m", 20 / 0.3048)).toBe(0.2);
  });
});
