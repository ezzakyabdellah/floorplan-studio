import { describe, expect, it } from "vitest";
import { buildMaterialManifest, materialManifestCsv } from "./billOfMaterials";
import { createDefaultProjectState } from "./projectStore";

describe("deterministic material manifest", () => {
  it("creates stair quantities and explicit geometric stringer references", () => {
    const project = createDefaultProjectState();
    const manifest = buildMaterialManifest(project);
    expect(manifest.find((line) => line.id === "treads")?.quantity).toBe(
      project.calculatedMetrics.treadCount,
    );
    expect(manifest.filter((line) => line.id.startsWith("stringer-"))).toHaveLength(2);
    expect(manifest.find((line) => line.id === "stringer-1")?.detail).toContain(
      "geometric",
    );
  });

  it("switches to a commercial ladder manifest for ladder projects", () => {
    const project = {
      ...createDefaultProjectState(),
      projectType: "ladder" as const,
    };
    const manifest = buildMaterialManifest(project);
    expect(manifest.map((line) => line.id)).toEqual([
      "ladder-assembly",
      "ladder-inspection-tags",
    ]);
  });

  it("exports quoted CSV cells with escaped quotes", () => {
    const csv = materialManifestCsv([
      {
        id: "test",
        item: 'Tread "A"',
        material: "wood",
        quantity: 1,
        unit: "pcs",
        cutLength: null,
        stockProfile: null,
        detail: "field check",
      },
    ]);
    expect(csv).toContain('"Tread ""A"""');
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});
