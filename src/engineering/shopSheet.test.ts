import { describe, expect, it } from "vitest";
import {
  buildShopSheetPdf,
  createShopSheetDocument,
  defaultWorkshopNotes,
  renderShopSheetSvg,
} from "./shopSheet";
import { createDefaultProjectState } from "./projectStore";
import { calculateStairGeometry } from "./stairCalculations";

describe("dynamic 2D shop sheet", () => {
  it("draws all requested views and preserves project dimensions in annotations", () => {
    const project = createDefaultProjectState();
    const svg = renderShopSheetSvg(
      createShopSheetDocument(project, defaultWorkshopNotes(project)),
    );
    expect(svg).toContain("SIDE ELEVATION");
    expect(svg).toContain("TOP PLAN");
    expect(svg).toContain("FRONT ELEVATION");
    expect(svg).toContain("STRINGER NOTCH LAYOUT");
    expect(svg).toContain("LADDER SETUP");
    expect(svg).toContain("RUN 132 in");
    expect(svg).toContain("RISE 108 in");
    expect(svg).toContain("WIDTH 36 in");
    expect(svg).toContain("14 equal risers");
  });

  it("uses updated project state for dimensions and workshop notes", () => {
    const project = createDefaultProjectState();
    const updated = {
      ...project,
      stairParams: {
        ...project.stairParams,
        totalRun: 120,
        width: 42,
      },
    };
    const notes = defaultWorkshopNotes(updated);
    const svg = renderShopSheetSvg(createShopSheetDocument(updated, notes));
    expect(svg).toContain("RUN 120 in");
    expect(svg).toContain("WIDTH 42 in");
    expect(notes.assemblyNotes.join(" ")).toContain("120 in");
  });

  it("renders distinct L, U, and spiral plan geometry", () => {
    const base = createDefaultProjectState();
    const lShape = {
      ...base,
      stairParams: { ...base.stairParams, style: "l-shaped" as const },
    };
    const uShape = {
      ...base,
      stairParams: { ...base.stairParams, style: "u-shaped" as const },
    };
    const spiral = {
      ...base,
      stairParams: {
        ...base.stairParams,
        style: "spiral" as const,
        spiralRadius: 40,
        spiralTurns: 1.5,
      },
    };
    const render = (project: typeof base) =>
      renderShopSheetSvg(
        createShopSheetDocument(project, defaultWorkshopNotes(project)),
      );
    const lSvg = render(lShape);
    const uSvg = render(uShape);
    const spiralSvg = render(spiral);
    expect(lSvg).toContain("L-SHAPED");
    expect(lSvg).toContain("FLIGHT 1");
    expect(lSvg).toContain("LANDING");
    expect(uSvg).toContain("U-SHAPED");
    expect(uSvg).toContain("FLIGHT 2");
    expect(spiralSvg).toContain("RADIAL TREAD PLAN");
    expect(spiralSvg).toContain("R 40 in");
    expect(spiralSvg).toContain("1.5 turns");
    expect(calculateStairGeometry(spiral.stairParams, spiral.units).totalWalkingRun)
      .toBeCloseTo(2 * Math.PI * 40 * 1.5, 6);
  });

  it("produces a valid vector PDF with a consistent cross-reference table", () => {
    const project = createDefaultProjectState();
    const pdf = buildShopSheetPdf(
      createShopSheetDocument(project, defaultWorkshopNotes(project)),
    );
    const source = new TextDecoder().decode(pdf);
    expect(source.startsWith("%PDF-1.4")).toBe(true);
    expect(source.endsWith("%%EOF")).toBe(true);
    const xrefOffset = Number(source.match(/startxref\n(\d+)/)?.[1]);
    expect(source.slice(xrefOffset).startsWith("xref")).toBe(true);
    expect(source).toContain("SIDE ELEVATION");
    expect(source).toContain("SCHEMATIC ONLY");
  });
});
