import { describe, expect, it } from "vitest";
import { createDefaultProjectState } from "./projectStore";
import {
  addProjectRevision,
  duplicateLocalProject,
  makeLocalProject,
} from "./projectLibrary";

describe("local multi-project workspace", () => {
  it("creates, revises, and duplicates independent snapshots", () => {
    const initial = createDefaultProjectState();
    const project = makeLocalProject("Entry stair", initial);
    const changed = {
      ...initial,
      stairParams: { ...initial.stairParams, totalRise: 120 },
    };
    const revised = addProjectRevision(project, "Higher landing", changed);
    const copy = duplicateLocalProject(revised, "Entry stair option B");

    expect(revised.revisions).toHaveLength(1);
    expect(revised.project.stairParams.totalRise).toBe(120);
    expect(copy.id).not.toBe(project.id);
    expect(copy.name).toBe("Entry stair option B");
    expect(copy.revisions[0].id).not.toBe(revised.revisions[0].id);
    expect(copy.revisions[0].project.stairParams.totalRise).toBe(120);
    expect(project.project.stairParams.totalRise).toBe(initial.stairParams.totalRise);
  });
});
