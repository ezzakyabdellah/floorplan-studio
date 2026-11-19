import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateFloorPlanFromPrompt,
  parseGeneratedFloorPlan,
} from "./floorPlanAiService";

afterEach(() => vi.unstubAllGlobals());

const semanticPlan = {
  grid_unit_m: 0.5,
  entrance_room: "living",
  rooms: [
    { id: "living", type: "living_room", area_m2: 25, zone: "front", windows: 2 },
    { id: "bed_1", type: "bedroom", area_m2: 25, zone: "front", windows: 1 },
    { id: "kitchen", type: "kitchen", area_m2: 25, zone: "front", windows: 1 },
  ],
  links: [
    { from: "living", to: "bed_1", connection: "door" },
    { from: "bed_1", to: "kitchen", connection: "open" },
  ],
};

describe("semantic AI floor-plan generation", () => {
  it("validates semantic output and adapts it to renderer walls and openings", () => {
    const plan = parseGeneratedFloorPlan(JSON.stringify(semanticPlan));

    expect(plan.name).toBe("AI Generated Floor Plan");
    expect(plan.rooms).toHaveLength(3);
    expect(plan.walls.length).toBeGreaterThan(0);
    expect(plan.openings.filter((opening) => opening.type === "door")).toHaveLength(3);
    expect(plan.openings.some((opening) => opening.id === "ai-entrance-door")).toBe(true);
    expect(plan.openings.every((opening) =>
      plan.walls.some((wall) => wall.id === opening.wallId),
    )).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it("rejects missing room references, negative windows, and non-positive areas", () => {
    expect(() =>
      parseGeneratedFloorPlan(
        JSON.stringify({ ...semanticPlan, entrance_room: "missing" }),
      ),
    ).toThrow('entrance_room "missing" does not exist');

    const invalidLink = structuredClone(semanticPlan);
    invalidLink.links[0].to = "missing";
    expect(() => parseGeneratedFloorPlan(JSON.stringify(invalidLink))).toThrow(
      "references an unknown room id",
    );

    const invalidArea = structuredClone(semanticPlan);
    invalidArea.rooms[0].area_m2 = 0;
    expect(() => parseGeneratedFloorPlan(JSON.stringify(invalidArea))).toThrow(
      "area_m2 must be positive",
    );

    const invalidWindows = structuredClone(semanticPlan);
    invalidWindows.rooms[0].windows = -1;
    expect(() => parseGeneratedFloorPlan(JSON.stringify(invalidWindows))).toThrow(
      "windows must be a non-negative integer",
    );
  });

  it("rejects fields outside the strict schema", () => {
    expect(() =>
      parseGeneratedFloorPlan(
        JSON.stringify({ ...semanticPlan, walls: [] }),
      ),
    ).toThrow("unexpected top-level properties");
  });

  it("requests one semantic JSON response with the strict schema and deterministic temperature", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init) requests.push(init);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(semanticPlan) }),
        };
      }),
    );

    const plan = await generateFloorPlanFromPrompt(
      "25 m² living room and two connected rooms",
      { model: "qwen2.5" },
    );

    expect(plan.rooms).toHaveLength(3);
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0].body as string);
    expect(body.format.required).toEqual([
      "grid_unit_m",
      "entrance_room",
      "rooms",
      "links",
    ]);
    expect(body.format.additionalProperties).toBe(false);
    expect(body.format.properties.rooms.items.properties.zone.enum).toEqual([
      "front",
      "core",
      "private",
      "service",
    ]);
    expect(body.format.properties.links.items.properties.connection.enum).toEqual([
      "door",
      "open",
      "arch",
    ]);
    expect(body.options.temperature).toBe(0.1);
    expect(body.prompt).toContain("semantic room graph");
  });

  it("corrects an invalid semantic response once", async () => {
    const prompts: string[] = [];
    const outputs = [
      { ...semanticPlan, entrance_room: "missing" },
      semanticPlan,
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        prompts.push(body.prompt);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(outputs.shift()) }),
        };
      }),
    );

    const plan = await generateFloorPlanFromPrompt("A connected home");
    expect(plan.rooms).toHaveLength(3);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('entrance_room "missing" does not exist');
  });
});
