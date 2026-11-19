import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateFloorPlanFromPrompt,
  parseGeneratedFloorPlan,
} from "./floorPlanAiService";

afterEach(() => vi.unstubAllGlobals());

const wallIteration = {
  name: "Garden Flat",
  walls: [
    { x1: 0, y1: 0, x2: 30, y2: 0, thickness: 0.5, height: 8 },
    { x1: 30, y1: 0, x2: 30, y2: 24, thickness: 0.5, height: 8 },
    { x1: 30, y1: 24, x2: 0, y2: 24, thickness: 0.5, height: 8 },
    { x1: 0, y1: 24, x2: 0, y2: 0, thickness: 0.5, height: 8 },
    { x1: 15, y1: 0, x2: 15, y2: 24, thickness: 0.5, height: 8 },
    { x1: 0, y1: 12, x2: 15, y2: 12, thickness: 0.5, height: 8 },
  ],
};

const openingsIteration = {
  openings: [
    { wallIndex: 0, type: "door", position: 0.5, width: 3 },
    { wallIndex: 2, type: "window", position: 0.5, width: 4 },
    { wallIndex: 4, type: "door", position: 0.25, width: 3 },
  ],
};

function jsonStream(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const pieces = [text.slice(0, 80), text.slice(80)];
      for (const piece of pieces) {
        if (!piece) continue;
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify({ response: piece })}\n`),
        );
      }
      controller.close();
    },
  });
}

describe("iterative AI floor-plan generation", () => {
  it("parses the final wall/opening schema and maps openings to wall IDs", () => {
    const plan = parseGeneratedFloorPlan(
      JSON.stringify({ ...wallIteration, ...openingsIteration }),
      "30×24 ft home",
    );

    expect(plan.name).toBe("Garden Flat");
    expect(plan.walls).toHaveLength(6);
    expect(plan.walls.every((wall) => wall.x1 === wall.x2 || wall.y1 === wall.y2)).toBe(true);
    expect(plan.openings).toMatchObject([
      { wallId: "ai-wall-1", type: "door", positionOnWall: 0.5, width: 3 },
      { wallId: "ai-wall-3", type: "window", positionOnWall: 0.5, width: 4 },
      { wallId: "ai-wall-5", type: "door", positionOnWall: 0.25, width: 3 },
    ]);
  });

  it("rejects disconnected walls and invalid opening references", () => {
    const disconnected = structuredClone(wallIteration);
    disconnected.walls.push({
      x1: 5,
      y1: 5,
      x2: 8,
      y2: 5,
      thickness: 0.5,
      height: 8,
    });
    expect(() =>
      parseGeneratedFloorPlan(
        JSON.stringify({ ...disconnected, openings: [] }),
        "30×24 ft",
      ),
    ).toThrow("wall segments are disconnected");

    expect(() =>
      parseGeneratedFloorPlan(
        JSON.stringify({
          ...wallIteration,
          openings: [{ ...openingsIteration.openings[0], wallIndex: 99 }],
        }),
        "30×24 ft",
      ),
    ).toThrow("invalid wall, type, or dimensions");
  });

  it("reports duplicate, degenerate, footprint, and perimeter errors together", () => {
    const brokenWallIteration = {
      name: "Two Bedroom Plan",
      walls: [
        { x1: 0, y1: 0, x2: 24, y2: 0, thickness: 0.5, height: 8 },
        { x1: 24, y1: 0, x2: 0, y2: 0, thickness: 0.5, height: 8 },
        { x1: 0, y1: 24, x2: 0, y2: 24, thickness: 0.5, height: 8 },
        { x1: 24, y1: 24, x2: 24, y2: 0, thickness: 0.5, height: 8 },
      ],
      openings: [],
    };

    try {
      parseGeneratedFloorPlan(
        JSON.stringify(brokenWallIteration),
        "2-bedroom, 30×24 ft",
      );
      throw new Error("Expected invalid wall layout.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("duplicates an existing wall");
      expect(message).toContain("zero-length");
      expect(message).toContain("24×24 ft, not the requested 30×24 ft");
      expect(message).toContain("exterior perimeter is open");
    }
  });

  it("requests walls first and openings in a second indexed iteration", async () => {
    const requests: RequestInit[] = [];
    const outputs = [wallIteration, openingsIteration];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init) requests.push(init);
        const output = outputs.shift();
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(output) }),
        };
      }),
    );

    const plan = await generateFloorPlanFromPrompt(
      "30×24 ft home with two bedrooms",
      { model: "qwen2.5" },
    );

    expect(plan.name).toBe("Garden Flat");
    expect(requests).toHaveLength(2);
    const first = JSON.parse(requests[0].body as string);
    const second = JSON.parse(requests[1].body as string);
    expect(first.format.properties).toHaveProperty("walls");
    expect(first.format.properties).not.toHaveProperty("openings");
    expect(first.prompt).toContain("Iteration 1 of 2");
    expect(second.format.properties).toHaveProperty("openings");
    expect(second.format.properties).not.toHaveProperty("walls");
    expect(second.prompt).toContain("Iteration 2 of 2");
    expect(second.prompt).toContain("W4:");
    expect(second.options.num_predict).toBe(768);
  });

  it("includes specific geometry defects when asking the model to correct walls", async () => {
    const brokenWallIteration = {
      name: "Two Bedroom Plan",
      walls: [
        { x1: 0, y1: 0, x2: 24, y2: 0, thickness: 0.5, height: 8 },
        { x1: 24, y1: 0, x2: 0, y2: 0, thickness: 0.5, height: 8 },
        { x1: 0, y1: 24, x2: 0, y2: 24, thickness: 0.5, height: 8 },
        { x1: 24, y1: 24, x2: 24, y2: 0, thickness: 0.5, height: 8 },
      ],
    };
    const prompts: string[] = [];
    const outputs = [brokenWallIteration, wallIteration, openingsIteration];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        prompts.push(JSON.parse(init?.body as string).prompt);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(outputs.shift()) }),
        };
      }),
    );

    const plan = await generateFloorPlanFromPrompt(
      "2-bedroom, 30×24 ft home",
    );

    expect(plan.walls).toHaveLength(6);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("duplicates an existing wall");
    expect(prompts[1]).toContain("zero-length");
    expect(prompts[1]).toContain("Regenerate the wall layout JSON from scratch");
    expect(prompts[1]).not.toContain(JSON.stringify(brokenWallIteration));
  });

  it("streams both AI iterations while returning the merged plan", async () => {
    const streams = [
      JSON.stringify(wallIteration),
      JSON.stringify(openingsIteration),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: jsonStream(streams.shift()!),
      })),
    );
    const chunks: string[] = [];

    const plan = await generateFloorPlanFromPrompt("30×24 ft home", {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(plan.walls).toHaveLength(6);
    expect(plan.openings).toHaveLength(3);
    expect(chunks.join("")).toContain("Iteration 2/2: generating openings");
  });

  it("adds fallback entry and window when the openings iteration omits them", async () => {
    const outputs = [
      wallIteration,
      { openings: [{ wallIndex: 4, type: "door", position: 0.5, width: 3 }] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: JSON.stringify(outputs.shift()) }),
      })),
    );

    const plan = await generateFloorPlanFromPrompt("30×24 ft home");

    expect(plan.openings.filter((opening) => opening.type === "door")).toHaveLength(2);
    expect(plan.openings.some((opening) => opening.type === "window")).toBe(true);
  });
});
