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

  it("switches metric display units without changing stored dimensions", () => {
    useProjectStore.getState().setDisplayUnit("cm");
    const centimetres = useProjectStore.getState();
    expect(centimetres.units).toBe("metric");
    expect(centimetres.displayUnit).toBe("cm");
    expect(centimetres.stairParams.totalRise).toBe(2743);

    useProjectStore.getState().setDisplayUnit("m");
    const metres = useProjectStore.getState();
    expect(metres.units).toBe("metric");
    expect(metres.displayUnit).toBe("m");
    expect(metres.stairParams.totalRise).toBe(2743);

    useProjectStore.getState().setDisplayUnit("in");
    const imperial = useProjectStore.getState();
    expect(imperial.units).toBe("imperial");
    expect(imperial.displayUnit).toBe("in");
    expect(imperial.stairParams.totalRise).toBe(108);
  });

  it("normalizes legacy saved projects without a display unit", () => {
    const saved = createDefaultProjectState("metric");
    const { displayUnit: _displayUnit, ...legacy } = saved;
    const result = useProjectStore
      .getState()
      .loadProjectState(legacy as typeof saved);
    expect(result.applied).toBe(true);
    expect(useProjectStore.getState().displayUnit).toBe("mm");
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

  it("loads a saved parameter snapshot and recalculates instead of trusting stored metrics", () => {
    const saved = createDefaultProjectState();
    const altered = {
      ...saved,
      stairParams: { ...saved.stairParams, totalRise: 120 },
      calculatedMetrics: { ...saved.calculatedMetrics, stepCount: 999 },
    };
    const result = useProjectStore.getState().loadProjectState(altered);
    expect(result.applied).toBe(true);
    expect(useProjectStore.getState().stairParams.totalRise).toBe(120);
    expect(useProjectStore.getState().calculatedMetrics.stepCount).not.toBe(999);
  });

  it("rejects invalid saved projects without replacing the current state", () => {
    const before = useProjectStore.getState().stairParams.totalRise;
    const invalid = {
      ...createDefaultProjectState(),
      stairParams: {
        ...createDefaultProjectState().stairParams,
        totalRise: Number.NaN,
      },
    };
    const result = useProjectStore.getState().loadProjectState(invalid);
    expect(result.applied).toBe(false);
    expect(useProjectStore.getState().stairParams.totalRise).toBe(before);
  });
});
