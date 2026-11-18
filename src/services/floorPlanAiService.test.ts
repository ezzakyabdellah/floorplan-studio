import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateFloorPlanFromPrompt,
  parseGeneratedFloorPlan,
} from "./floorPlanAiService";

afterEach(() => vi.unstubAllGlobals());

const rectangleResponse = {
  name: "Garden Flat",
  walls: [
    { x1: 0, y1: 0, x2: 20, y2: 0, thickness: 0.5, height: 8 },
    { x1: 20, y1: 0, x2: 20, y2: 15, thickness: 0.5, height: 8 },
    { x1: 20, y1: 15, x2: 0, y2: 15, thickness: 0.5, height: 8 },
    { x1: 0, y1: 15, x2: 0, y2: 0, thickness: 0.5, height: 8 },
  ],
  openings: [
    { wallIndex: 2, type: "door", position: 0.5, width: 3 },
    { wallIndex: 0, type: "window", position: 0.5, width: 4 },
  ],
};

describe("AI floor-plan generation", () => {
  it("normalizes generated walls and attaches openings to the referenced wall", () => {
    const plan = parseGeneratedFloorPlan(JSON.stringify(rectangleResponse));
    expect(plan.name).toBe("Garden Flat");
    expect(plan.walls).toHaveLength(4);
    expect(plan.openings).toMatchObject([
      { wallId: "ai-wall-3", type: "door", positionOnWall: 0.5, width: 3 },
      { wallId: "ai-wall-1", type: "window", positionOnWall: 0.5, width: 4 },
    ]);
  });

  it("rejects unsafe wall dimensions and invalid opening references", () => {
    const tooLarge = structuredClone(rectangleResponse);
    tooLarge.walls[0].x2 = 400;
    expect(() => parseGeneratedFloorPlan(JSON.stringify(tooLarge))).toThrow(
      "outside the supported",
    );

    const invalidOpening = structuredClone(rectangleResponse);
    invalidOpening.openings[0].wallIndex = 10;
    expect(() =>
      parseGeneratedFloorPlan(JSON.stringify(invalidOpening)),
    ).toThrow("invalid wall or opening data");
  });

  it("rejects openings that overlap a wall endpoint", () => {
    const plan = structuredClone(rectangleResponse);
    plan.openings[0].position = 0.01;
    expect(() => parseGeneratedFloorPlan(JSON.stringify(plan))).toThrow(
      "does not fit safely",
    );
  });

  it("rejects openings that overlap on the same wall", () => {
    const plan = structuredClone(rectangleResponse);
    plan.openings = [
      { wallIndex: 0, type: "door", position: 0.5, width: 3 },
      { wallIndex: 0, type: "window", position: 0.55, width: 4 },
    ];
    expect(() => parseGeneratedFloorPlan(JSON.stringify(plan))).toThrow(
      "overlaps another opening",
    );
  });

  it("requests structured, bounded JSON from the selected local model", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init) requests.push(init);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(rectangleResponse) }),
        };
      }),
    );

    const plan = await generateFloorPlanFromPrompt(
      "A 20 by 15 foot one-bedroom flat with a living room",
      { model: "qwen2.5" },
    );

    expect(plan.name).toBe("Garden Flat");
    const body = JSON.parse(requests[0].body as string);
    expect(body.model).toBe("qwen2.5");
    expect(body.format.type).toBe("object");
    expect(body.prompt).toContain("Request:");
    expect(body.options.num_predict).toBe(3072);
    expect(body.options.num_ctx).toBe(8192);
  });
});
