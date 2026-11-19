import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateFloorPlanFromPrompt,
  parseGeneratedFloorPlan,
} from "./floorPlanAiService";

afterEach(() => vi.unstubAllGlobals());

const roomPlanResponse = {
  name: "Garden Flat",
  width: 30,
  depth: 24,
  rooms: [
    {
      name: "Living room",
      x: 0,
      y: 0,
      width: 18,
      depth: 14,
      openTo: ["Kitchen"],
    },
    {
      name: "Kitchen",
      x: 18,
      y: 0,
      width: 12,
      depth: 14,
      openTo: ["Living room"],
    },
    {
      name: "Bedroom 1",
      x: 0,
      y: 14,
      width: 10,
      depth: 10,
      openTo: [],
    },
    {
      name: "Bedroom 2",
      x: 10,
      y: 14,
      width: 10,
      depth: 10,
      openTo: [],
    },
    {
      name: "Bathroom",
      x: 20,
      y: 14,
      width: 10,
      depth: 10,
      openTo: [],
    },
  ],
  openings: [
    { room: "Living room", side: "south", type: "door", position: 0.5, width: 3 },
    { room: "Bedroom 1", side: "south", type: "door", position: 0.5, width: 3 },
    { room: "Bedroom 2", side: "south", type: "door", position: 0.5, width: 3 },
    { room: "Bathroom", side: "west", type: "door", position: 0.5, width: 3 },
    { room: "Bedroom 1", side: "west", type: "window", position: 0.5, width: 4 },
  ],
};

describe("AI floor-plan generation", () => {
  it("derives clean wall geometry from semantic room rectangles", () => {
    const plan = parseGeneratedFloorPlan(JSON.stringify(roomPlanResponse));

    expect(plan.name).toBe("Garden Flat");
    expect(plan.walls.length).toBeGreaterThan(4);
    expect(plan.walls.every((wall) => wall.x1 === wall.x2 || wall.y1 === wall.y2)).toBe(true);
    expect(plan.walls.every((wall) =>
      [wall.x1, wall.y1, wall.x2, wall.y2].every((value) => Number.isFinite(value)),
    )).toBe(true);
    expect(plan.openings).toHaveLength(5);
    expect(plan.openings.every((opening) =>
      plan.walls.some((wall) => wall.id === opening.wallId),
    )).toBe(true);
    expect(plan.walls.some(
      (wall) =>
        Math.abs(wall.x1 - 18) < 0.1 &&
        Math.abs(wall.x2 - 18) < 0.1 &&
        Math.abs(wall.y1) < 0.1 &&
        Math.abs(wall.y2 - 14) < 0.1,
    )).toBe(false); // Living room and kitchen are intentionally open to each other.
  });

  it("honors explicit footprint dimensions and room counts", () => {
    const plan = parseGeneratedFloorPlan(
      JSON.stringify(roomPlanResponse),
      "2-bedroom, 24 x 20 ft home",
    );
    expect(Math.max(...plan.walls.flatMap((wall) => [wall.x1, wall.x2]))).toBe(24);
    expect(Math.max(...plan.walls.flatMap((wall) => [wall.y1, wall.y2]))).toBe(20);
  });

  it("rejects overlapping rooms and room counts that contradict the request", () => {
    const overlapping = structuredClone(roomPlanResponse);
    overlapping.rooms[1].x = 17;
    expect(() =>
      parseGeneratedFloorPlan(JSON.stringify(overlapping)),
    ).toThrow("overlap");

    expect(() =>
      parseGeneratedFloorPlan(
        JSON.stringify(roomPlanResponse),
        "3-bedroom, 30 x 24 ft home",
      ),
    ).toThrow("asks for 3");
  });

  it("requests a room-level structured layout from the selected local model", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init) requests.push(init);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(roomPlanResponse) }),
        };
      }),
    );

    const plan = await generateFloorPlanFromPrompt(
      "A 30 by 24 foot home with two bedrooms",
      { model: "qwen2.5" },
    );

    expect(plan.name).toBe("Garden Flat");
    const body = JSON.parse(requests[0].body as string);
    expect(body.model).toBe("qwen2.5");
    expect(body.format.properties.rooms.items.properties).toHaveProperty("openTo");
    expect(body.prompt).toContain("non-overlapping rectangle");
    expect(body.options.num_predict).toBe(3072);
    expect(body.options.num_ctx).toBe(8192);
  });

  it("streams the room-level response and builds deterministic walls", async () => {
    const responseText = JSON.stringify(roomPlanResponse);
    const pieces = [
      responseText.slice(0, 24),
      responseText.slice(24, 80),
      responseText.slice(80),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(
            new TextEncoder().encode(`${JSON.stringify({ response: piece })}\n`),
          );
        }
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: stream,
      })),
    );
    const chunks: string[] = [];

    const plan = await generateFloorPlanFromPrompt(
      "2-bedroom, 30×24 ft home",
      { onChunk: (chunk) => chunks.push(chunk) },
    );

    expect(chunks).toEqual(pieces);
    expect(plan.name).toBe("Garden Flat");
    expect(plan.walls.length).toBeGreaterThan(4);
  });
});
