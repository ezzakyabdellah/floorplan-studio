import { describe, expect, it } from "vitest";
import {
  buildShopSheetPdf,
  createShopSheetDocument,
  defaultWorkshopNotes,
  renderShopSheetSvg,
} from "./shopSheet";
import { createDefaultProjectState } from "./projectStore";

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
