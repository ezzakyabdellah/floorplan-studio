import { describe, expect, it } from "vitest";
import { buildDxf, buildStl } from "./cadExports";
import { createDefaultProjectState } from "./projectStore";

describe("deterministic CAD exports", () => {
  it("writes a unit-aware DXF with plan and elevation entities", () => {
    const project = createDefaultProjectState();
    const dxf = buildDxf(project);
    expect(dxf).toContain("$INSUNITS");
    expect(dxf).toContain("PLAN");
    expect(dxf).toContain("ELEVATION");
    expect(dxf).toContain("\n0\nLINE\n");
    expect(dxf.endsWith("0\nEOF")).toBe(true);
  });

  it("writes non-empty STL facets in project-native units", () => {
    const project = createDefaultProjectState();
    const stl = buildStl(project);
    expect(stl.startsWith("solid stair_ladder_inch")).toBe(true);
    expect(stl).toContain("facet normal");
    expect(stl).toContain("endsolid");
  });

  it("exports valid spiral plan arcs and closed tread geometry", () => {
    const base = createDefaultProjectState();
    const project = {
      ...base,
      stairParams: {
        ...base.stairParams,
        style: "spiral" as const,
      },
    };
    const dxf = buildDxf(project);
    expect(dxf).toContain("\n0\nARC\n");
    const angles = [...dxf.matchAll(/\n(?:50|51)\n(-?\d+(?:\.\d+)?)/g)]
      .map((match) => Number(match[1]));
    expect(angles.length).toBeGreaterThan(0);
    expect(angles.every((angle) => angle >= 0 && angle <= 360)).toBe(true);
    const stl = buildStl(project);
    expect(stl).toContain("facet normal");
    expect(stl).not.toMatch(/\b(?:NaN|Infinity)\b/);
  });

  it("exports ladder rails and rungs", () => {
    const project = {
      ...createDefaultProjectState(),
      projectType: "ladder" as const,
    };
    const dxf = buildDxf(project);
    expect(dxf).toContain("RAILS");
    expect(dxf).toContain("RUNGS");
    expect(buildStl(project)).toContain("facet normal");
  });
});
