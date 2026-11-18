import { describe, expect, it } from "vitest";
import { buildMaterialManifest } from "./billOfMaterials";
import {
  estimateIllustrativeMaterialCost,
  requestCostSourcingAdvice,
  requestStructuralAdvice,
} from "./designAdvisors";
import { createDefaultProjectState } from "./projectStore";

describe("advisory-only deterministic fallback", () => {
  it("returns structural review prompts without claiming capacity calculations", async () => {
    const project = createDefaultProjectState();
    const result = await requestStructuralAdvice(project);
    expect(result.source).toBe("offline");
    expect(result.advice.join(" ")).toContain("qualified");
    expect(result.disclaimer).toContain("not a structural design");
  });

  it("calculates an explicitly illustrative BOM cost range", async () => {
    const project = createDefaultProjectState();
    const lines = buildMaterialManifest(project);
    const estimate = estimateIllustrativeMaterialCost(lines);
    const result = await requestCostSourcingAdvice(project, lines);
    expect(estimate.low).toBeGreaterThan(0);
    expect(estimate.high).toBeGreaterThan(estimate.low);
    expect(result.source).toBe("offline");
    expect(result.advice[0]).toContain("Illustrative");
    expect(estimate.assumptions.join(" ")).toContain("local supplier");
  });
});
