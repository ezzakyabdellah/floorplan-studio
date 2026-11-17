import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultProjectState, useProjectStore } from "./projectStore";

describe("unified project state", () => {
  beforeEach(() => useProjectStore.getState().resetProject());

  it("recalculates metrics when design parameters change", () => {
    const store = useProjectStore.getState();
    const before = store.calculatedMetrics.stringerLength;
    const result = store.updateDesignParameters({
      stairParams: { totalRise: 120 },
    });
    expect(result.applied).toBe(true);
    expect(useProjectStore.getState().calculatedMetrics.stringerLength).toBeGreaterThan(before);
  });

  it("converts every dimensional field when changing project units", () => {
    const result = useProjectStore.getState().updateDesignParameters({
      stairParams: { totalRise: 108.0625 },
    });
    expect(result.applied).toBe(true);
    useProjectStore.getState().setUnits("metric");
    const metric = useProjectStore.getState();
    expect(metric.units).toBe("metric");
    expect(metric.stairParams.totalRise).toBe(2745);
    expect(metric.stairParams.balusterSpacingMax).toBe(100);
    useProjectStore.getState().setUnits("imperial");
    expect(useProjectStore.getState().stairParams.totalRise).toBe(108.0625);
  });

  it("rejects invalid user or model updates without changing state", () => {
    const before = useProjectStore.getState().stairParams.totalRise;
    const result = useProjectStore
      .getState()
      .updateDesignParameters({ stairParams: { totalRise: Number.NaN } });
    expect(result.applied).toBe(false);
    expect(useProjectStore.getState().stairParams.totalRise).toBe(before);
  });

  it("normalizes L/U landing size and protects spiral walking-line dimensions", () => {
    const store = useProjectStore.getState();
    expect(
      store.updateDesignParameters({
        projectType: "staircase",
        stairParams: { style: "l-shaped", width: 42 },
      }).applied,
    ).toBe(true);
    expect(useProjectStore.getState().stairParams.landingLength).toBe(42);

    const invalidLanding = useProjectStore
      .getState()
      .updateDesignParameters({ stairParams: { landingLength: 30 } });
    expect(invalidLanding.applied).toBe(false);

    const invalidRadius = useProjectStore
      .getState()
      .updateDesignParameters({
        stairParams: { style: "spiral", spiralRadius: 20 },
      });
    expect(invalidRadius.applied).toBe(false);
  });

  it("provides a JSON-serializable single source of truth", () => {
    const project = createDefaultProjectState();
    const roundTrip = JSON.parse(JSON.stringify(project));
    expect(roundTrip.projectType).toBe("staircase");
    expect(roundTrip.calculatedMetrics.stepCount).toBe(14);
    expect(roundTrip.stairParams.totalRise).toBe(108);
  });
});
