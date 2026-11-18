import { describe, expect, it } from "vitest";
import { buildMaterialManifest } from "./billOfMaterials";
import { cutOptimizationCsv, optimizeCutList } from "./cutOptimizer";
import { createDefaultProjectState } from "./projectStore";

describe("deterministic stock cut optimizer", () => {
  it("covers every eligible BOM cut and accounts for kerf and offcut", () => {
    const project = createDefaultProjectState();
    const lines = buildMaterialManifest(project);
    const result = optimizeCutList(project, lines);
    const expectedCuts = lines
      .filter((line) => line.cutLength !== null && line.stockProfile !== null)
      .reduce((sum, line) => sum + line.quantity, 0);
    const actualCuts = result.groups.flatMap((group) => group.patterns)
      .reduce((sum, pattern) => sum + pattern.cuts.length, 0);
    expect(actualCuts).toBe(expectedCuts);
    expect(result.totalStock).toBeCloseTo(result.totalCut + result.totalWaste, 6);
    expect(result.groups.every((group) => group.patterns.every(
      (pattern) => pattern.cuts.reduce((sum, cut) => sum + cut.length, 0) +
        pattern.kerfWaste <= pattern.stockLength + 1e-8,
    ))).toBe(true);
  });

  it("uses custom stock when a cut exceeds standard lengths and exports CSV", () => {
    const project = createDefaultProjectState();
    const lines = buildMaterialManifest(project);
    const result = optimizeCutList(project, lines);
    const csv = cutOptimizationCsv(result, project.units);
    expect(result.kerf).toBeGreaterThan(0);
    expect(csv).toContain("Stock profile");
    expect(csv).toContain("Tread blanks");
  });
});
