import { describe, expect, it } from "vitest";
import { createDefaultProjectState } from "./projectStore";
import {
  buildLadder3DLayout,
  buildStair3DLayout,
  calculateHeadroomProfile,
  estimateStairBoundsFromSketch,
  spiralPlanPoint,
} from "./stair3d";

describe("parametric stair 3D layout", () => {
  it("builds a straight flight whose run and rise match project parameters", () => {
    const project = createDefaultProjectState();
    const layout = buildStair3DLayout(project);
    expect(layout.flights).toHaveLength(1);
    expect(layout.flights[0].run).toBeCloseTo(11, 6);
    expect(layout.flights[0].rise).toBeCloseTo(9, 6);
    expect(layout.flights[0].treadCount).toBe(
      project.calculatedMetrics.treadCount,
    );
  });

  it("splits L and U stairs into two flights with a landing", () => {
    const project = createDefaultProjectState();
    for (const style of ["l-shaped", "u-shaped"] as const) {
      const layout = buildStair3DLayout({
        ...project,
        stairParams: { ...project.stairParams, style },
      });
      expect(layout.flights).toHaveLength(2);
      expect(layout.landings).toHaveLength(1);
      expect(layout.flights[0].rise + layout.flights[1].rise).toBeCloseTo(
        layout.totalRise,
        6,
      );
    }
    const uLayout = buildStair3DLayout({
      ...project,
      stairParams: { ...project.stairParams, style: "u-shaped" },
    });
    const landingStartX =
      uLayout.landings[0].center.x - uLayout.landings[0].length / 2;
    const firstFlightEndX =
      uLayout.flights[0].start.x +
      uLayout.flights[0].direction.x * uLayout.flights[0].run;
    expect(firstFlightEndX).toBeCloseTo(landingStartX, 6);
    expect(uLayout.flights[1].start.x).toBeCloseTo(landingStartX, 6);
    expect(uLayout.flights[1].direction.x).toBe(-1);
  });

  it("creates radial spiral treads and a continuous camera path", () => {
    const project = createDefaultProjectState();
    const spiral = {
      ...project,
      stairParams: {
        ...project.stairParams,
        style: "spiral" as const,
        spiralRadius: 42,
        spiralTurns: 1.5,
      },
    };
    const layout = buildStair3DLayout(spiral);
    expect(layout.spiralTreads).toHaveLength(
      project.calculatedMetrics.treadCount,
    );
    expect(layout.spiralTreads[0].lowerElevation).toBe(0);
    expect(layout.spiralTreads[0].elevation).toBeGreaterThan(
      layout.spiralTreads[0].lowerElevation,
    );
    expect(layout.spiralTreads[0].endAngle).toBeCloseTo(
      layout.spiralTreads[1].startAngle,
      10,
    );
    expect(layout.walkPath.length).toBeGreaterThan(48);
    expect(layout.walkPath[0].y).toBe(0);
    expect(layout.walkPath[layout.walkPath.length - 1]?.y).toBeCloseTo(
      layout.totalRise,
      6,
    );
    const firstWalkPoint = layout.walkPath[0];
    const firstTreadStart = spiralPlanPoint(
      layout.spiralTreads[0].innerRadius,
      layout.spiralTreads[0].startAngle,
    );
    const innerToCenterlineRatio =
      layout.spiralTreads[0].innerRadius / (42 / 12);
    expect(firstTreadStart.x).toBeCloseTo(
      firstWalkPoint.x * innerToCenterlineRatio,
      6,
    );
    expect(firstTreadStart.z).toBeCloseTo(
      firstWalkPoint.z * innerToCenterlineRatio,
      6,
    );
  });

  it("marks tight headroom red and leaves clear headroom unflagged", () => {
    const project = createDefaultProjectState();
    const safe = calculateHeadroomProfile(project);
    const low = calculateHeadroomProfile({
      ...project,
      stairParams: { ...project.stairParams, headroomClearance: 72 },
    });
    expect(safe.known).toBe(true);
    expect(safe.belowCode).toBe(false);
    expect(low.belowCode).toBe(true);
    expect(low.samples.some((sample) => sample.belowCode)).toBe(true);
  });

  it("builds both leaning and self-supporting ladder models", () => {
    const project = createDefaultProjectState();
    const leaning = buildLadder3DLayout({
      ...project,
      projectType: "ladder",
    });
    expect(leaning.rails).toHaveLength(2);
    expect(leaning.rungs.length).toBeGreaterThan(5);
    expect(leaning.baseSetback).toBeCloseTo(3, 2);

    const step = buildLadder3DLayout({
      ...project,
      projectType: "ladder",
      ladderParams: { ...project.ladderParams, ladderType: "step" },
    });
    expect(step.rails).toHaveLength(4);
    expect(step.baseSetback).toBe(0);
  });

  it("estimates scale-calibrated run and width bounds from parsed sketch walls", () => {
    const walls = [
      { id: "a", x1: 0, y1: 0, x2: 20, y2: 0, thickness: 0.5, height: 8 },
      { id: "b", x1: 20, y1: 0, x2: 20, y2: 10, thickness: 0.5, height: 8 },
      { id: "c", x1: 20, y1: 10, x2: 0, y2: 10, thickness: 0.5, height: 8 },
      { id: "d", x1: 0, y1: 10, x2: 0, y2: 0, thickness: 0.5, height: 8 },
    ];
    expect(estimateStairBoundsFromSketch(walls)).toEqual({
      runFeet: 20,
      widthFeet: 10,
    });
  });
});
