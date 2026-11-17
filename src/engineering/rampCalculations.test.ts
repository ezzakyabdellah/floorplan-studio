import { describe, expect, it } from "vitest";
import {
  rampSlopeFromDegrees,
  rampSlopeFromGrade,
  rampSlopeFromRatio,
} from "./rampCalculations";

describe("ramp pitch conversions", () => {
  it("converts the 1:12 maximum to degrees and grade", () => {
    const fromRatio = rampSlopeFromRatio(1, 12);
    expect(fromRatio.gradePercent).toBeCloseTo(100 / 12, 3);
    expect(fromRatio.adaCompliant).toBe(true);
    expect(rampSlopeFromDegrees(fromRatio.degrees).adaCompliant).toBe(true);
    expect(rampSlopeFromGrade(100 / 12).adaCompliant).toBe(true);
  });

  it("flags slopes steeper than 1:12", () => {
    expect(rampSlopeFromRatio(1, 10).adaCompliant).toBe(false);
    expect(rampSlopeFromGrade(10).adaCompliant).toBe(false);
  });

  it("rejects invalid angle and ratio inputs", () => {
    expect(() => rampSlopeFromDegrees(90)).toThrow();
    expect(() => rampSlopeFromRatio(1, 0)).toThrow();
    expect(() => rampSlopeFromGrade(-1)).toThrow();
  });
});
