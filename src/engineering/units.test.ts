import { describe, expect, it } from "vitest";
import {
  displayLength,
  displayLengthStep,
  formatLength,
  projectLengthFromDisplay,
  resolveLengthUnit,
} from "./units";

describe("length display units", () => {
  it("formats metric lengths in millimetres, centimetres, and metres", () => {
    expect(formatLength(914.4, "metric")).toBe("914 mm");
    expect(formatLength(914.4, "metric", "mm")).toBe("914 mm");
    expect(formatLength(914.4, "metric", "cm")).toBe("91.4 cm");
    expect(formatLength(2743.2, "metric", "m")).toBe("2.743 m");
  });

  it("keeps imperial lengths in fractional inches regardless of preference", () => {
    expect(formatLength(7.6875, "imperial", "m")).toBe("7 11/16 in");
  });

  it("converts between stored and displayed lengths", () => {
    expect(displayLength(2743, "metric", "m")).toBeCloseTo(2.743, 6);
    expect(displayLength(2743, "metric", "cm")).toBeCloseTo(274.3, 6);
    expect(projectLengthFromDisplay(2.743, "metric", "m")).toBe(2743);
    expect(projectLengthFromDisplay(274.3, "metric", "cm")).toBe(2743);
    expect(projectLengthFromDisplay(36, "imperial", "in")).toBe(36);
  });

  it("resolves sensible defaults and input steps", () => {
    expect(resolveLengthUnit("imperial", "m")).toBe("in");
    expect(resolveLengthUnit("metric", undefined)).toBe("mm");
    expect(resolveLengthUnit("metric", "cm")).toBe("cm");
    expect(displayLengthStep("imperial")).toBe(1 / 16);
    expect(displayLengthStep("metric", "cm")).toBe(0.1);
    expect(displayLengthStep("metric", "m")).toBe(0.001);
  });
});
