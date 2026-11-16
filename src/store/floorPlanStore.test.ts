import { beforeEach, describe, expect, it } from "vitest";
import { useFloorPlanStore } from "./floorPlanStore";

describe("furniture scale setting", () => {
  beforeEach(() => {
    const store = useFloorPlanStore.getState();
    store.setFurnitureScaleFactor(1);
    store.resetScene();
  });

  it("resizes existing furniture and applies the factor to future additions", () => {
    const store = useFloorPlanStore.getState();
    const firstId = store.addFurniture("bed", 4, 4);
    expect(useFloorPlanStore.getState().furniture[0].width).toBeCloseTo(5.2);

    useFloorPlanStore.getState().setFurnitureScaleFactor(0.5);
    const scaledExisting = useFloorPlanStore.getState().furniture[0];
    expect(scaledExisting.id).toBe(firstId);
    expect(scaledExisting.width).toBeCloseTo(2.6);
    expect(scaledExisting.depth).toBeCloseTo(3.4);
    expect(scaledExisting.height).toBeCloseTo(1.2);

    useFloorPlanStore.getState().addFurniture("bed", 8, 8);
    expect(useFloorPlanStore.getState().furniture[1].width).toBeCloseTo(2.6);
  });

  it("applies the factor to bulk-added furniture", () => {
    const store = useFloorPlanStore.getState();
    store.setFurnitureScaleFactor(0.75);
    store.setFurniture([
      {
        id: "ai-bed",
        roomId: 0,
        kind: "bed",
        source: "geometry",
        roomLabel: "Bedroom",
        x: 4,
        y: 4,
        width: 5.2,
        depth: 6.8,
        height: 2.4,
        rotation: 0,
        confidence: 1,
      },
    ]);

    const [furniture] = useFloorPlanStore.getState().furniture;
    expect(furniture.width).toBeCloseTo(3.9);
    expect(furniture.depth).toBeCloseTo(5.1);
    expect(furniture.height).toBeCloseTo(1.8);
  });
});
