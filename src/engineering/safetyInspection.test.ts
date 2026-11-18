import { describe, expect, it } from "vitest";
import { createDefaultProjectState } from "./projectStore";
import {
  buildInspectionReportPdf,
  createInspectionChecklist,
  inspectionOutcome,
  makeInspectionRecord,
} from "./safetyInspection";

describe("pre-use safety inspection", () => {
  it("requires each item to be checked and reports any failure", () => {
    const project = { ...createDefaultProjectState(), projectType: "ladder" as const };
    const items = createInspectionChecklist(project);
    expect(items.length).toBeGreaterThan(5);
    expect(inspectionOutcome(items)).toBe("incomplete");
    items.forEach((item) => {
      item.answer = "pass";
    });
    expect(inspectionOutcome(items)).toBe("pass");
    items[0].answer = "fail";
    expect(inspectionOutcome(items)).toBe("fail");
  });

  it("creates a timestamped, printable PDF report", () => {
    const project = createDefaultProjectState();
    const items = createInspectionChecklist(project);
    items.forEach((item) => {
      item.answer = "pass";
    });
    const record = makeInspectionRecord({
      projectName: "Test staircase",
      project,
      inspector: "Inspector",
      items,
      inspectedAt: "2026-11-18T12:00:00.000Z",
    });
    const pdf = buildInspectionReportPdf(record);
    expect(record.overall).toBe("pass");
    expect(new TextDecoder().decode(pdf).startsWith("%PDF-1.4")).toBe(true);
  });
});
