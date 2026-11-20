import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateFloorPlanFromPrompt,
  parseGeneratedFloorPlan,
  parsePastedFloorPlan,
} from "./floorPlanAiService";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const roomProgram = {
  grid_unit_m: 0.5,
  entrance_room: "living",
  rooms: [
    { id: "living", type: "living_room", area_m2: 25, zone: "front" },
    { id: "bed_1", type: "bedroom", area_m2: 25, zone: "front" },
    { id: "kitchen", type: "kitchen", area_m2: 25, zone: "front" },
  ],
};

const linksResponse = {
  links: [
    { from: "living", to: "bed_1", connection: "door" },
    { from: "bed_1", to: "kitchen", connection: "open" },
  ],
};

const windowsResponse = {
  windows: [
    { room_id: "living", count: 2 },
    { room_id: "bed_1", count: 1 },
    { room_id: "kitchen", count: 1 },
  ],
};

const semanticPlan = {
  ...roomProgram,
  rooms: roomProgram.rooms.map((room, index) => ({
    ...room,
    windows: windowsResponse.windows[index].count,
  })),
  links: linksResponse.links,
};

function stubPasses(outputs: unknown[], requests: RequestInit[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) requests.push(init);
      return {
        ok: true,
        json: async () => ({ response: JSON.stringify(outputs.shift()) }),
      };
    }),
  );
  return requests;
}

describe("iterative semantic AI floor-plan generation", () => {
  it("runs three strict passes, validates each, and adapts the merged plan", async () => {
    const requests = stubPasses([roomProgram, linksResponse, windowsResponse]);
    const plan = await generateFloorPlanFromPrompt(
      "25 m² living room and two connected rooms",
      { model: "qwen2.5" },
    );

    expect(plan.name).toBe("AI Generated Floor Plan");
    expect(plan.rooms).toHaveLength(3);
    expect(plan.walls.length).toBeGreaterThan(0);
    expect(plan.openings.filter((opening) => opening.type === "door")).toHaveLength(3);
    expect(plan.openings.every((opening) =>
      plan.walls.some((wall) => wall.id === opening.wallId),
    )).toBe(true);
    expect(plan.warnings).toEqual([]);
    expect(requests).toHaveLength(3);

    const bodies = requests.map((request) => JSON.parse(request.body as string));
    expect(bodies[0].prompt).toContain("Pass 1/3");
    expect(Object.keys(bodies[0].format.properties)).toEqual([
      "grid_unit_m",
      "entrance_room",
      "rooms",
    ]);
    expect(bodies[0].format.properties.rooms.items.required).toEqual([
      "id",
      "type",
      "area_m2",
      "zone",
    ]);

    expect(bodies[1].prompt).toContain("Pass 2/3");
    expect(bodies[1].prompt).toContain('"id":"living"');
    expect(Object.keys(bodies[1].format.properties)).toEqual(["links"]);

    expect(bodies[2].prompt).toContain("Pass 3/3");
    expect(bodies[2].prompt).toContain('"from":"living"');
    expect(Object.keys(bodies[2].format.properties)).toEqual(["windows"]);
    expect(bodies.every((body) => body.options.temperature === 0.1)).toBe(true);
  });

  it("rejects an invalid room program before requesting links", async () => {
    const invalidProgram = {
      ...roomProgram,
      entrance_room: "missing",
    };
    const requests = stubPasses(Array(5).fill(invalidProgram));

    await expect(generateFloorPlanFromPrompt("A connected home")).rejects.toThrow(
      "Stopped after 5 failed attempts for pass-1-room-program",
    );
    expect(requests).toHaveLength(5);
    expect(JSON.parse(requests[1].body as string).prompt).toContain(
      'entrance_room "missing" does not exist',
    );
    expect(JSON.parse(requests[1].body as string).prompt).toContain(
      "Fix the existing output",
    );
  });

  it("rejects a disconnected link graph before requesting windows", async () => {
    const requests = stubPasses([roomProgram, ...Array(5).fill({ links: [] })]);

    await expect(generateFloorPlanFromPrompt("A connected home")).rejects.toThrow(
      "Stopped after 5 failed attempts for pass-2-circulation",
    );
    expect(requests).toHaveLength(6);
    expect(JSON.parse(requests[2].body as string).prompt).toContain(
      "room-link graph is disconnected",
    );
  });

  it("names the exact unknown room id in circulation errors", async () => {
    const badLinks = {
      links: [{ from: "living", to: "garden", connection: "door" }],
    };
    const requests = stubPasses([roomProgram, ...Array(5).fill(badLinks)]);

    await expect(generateFloorPlanFromPrompt("A connected home")).rejects.toThrow(
      "link 1 (living -> garden) references unknown room id(s): garden",
    );
    expect(JSON.parse(requests[2].body as string).prompt).toContain(
      "unknown room id(s): garden",
    );
  });

  it("drops duplicate circulation links instead of retrying", async () => {
    const duplicateLinks = {
      links: [
        ...linksResponse.links,
        { from: "bed_1", to: "living", connection: "door" },
      ],
    };
    const requests = stubPasses([
      roomProgram,
      duplicateLinks,
      windowsResponse,
    ]);

    const plan = await generateFloorPlanFromPrompt("A connected home");

    expect(requests).toHaveLength(3);
    expect(plan.openings.filter((opening) => opening.type === "door")).toHaveLength(
      linksResponse.links.length + 1,
    );
    expect(plan.warnings).toEqual([]);
  });

  it("validates unique window assignments and non-negative integer counts", async () => {
    const badWindows = {
      windows: [
        { room_id: "living", count: -1 },
        { room_id: "bed_1", count: 1 },
        { room_id: "kitchen", count: 1 },
      ],
    };
    const requests = stubPasses([
      roomProgram,
      linksResponse,
      ...Array(5).fill(badWindows),
    ]);

    await expect(generateFloorPlanFromPrompt("A connected home")).rejects.toThrow(
      "Stopped after 5 failed attempts for pass-3-windows",
    );
    expect(requests).toHaveLength(7);
    expect(JSON.parse(requests[3].body as string).prompt).toContain(
      "count must be an integer from 0 to 12",
    );
  });

  it("asks whether to continue after five failures and resumes another retry batch", async () => {
    const continueRetry = vi.fn(async () => true);
    const requests = stubPasses([
      roomProgram,
      ...Array(5).fill({ links: [] }),
      linksResponse,
      windowsResponse,
    ]);

    const plan = await generateFloorPlanFromPrompt("A connected home", {
      onRetryLimit: continueRetry,
    });

    expect(plan.rooms).toHaveLength(3);
    expect(requests).toHaveLength(8);
    expect(continueRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "pass-2-circulation",
        attempts: 5,
        batch: 1,
      }),
    );
  });

  it("applies a valid minimal repair patch and re-solves the plan", async () => {
    const tinyProgram = {
      grid_unit_m: 0.5,
      entrance_room: "tiny",
      rooms: [{ id: "tiny", type: "living_room", area_m2: 0.1, zone: "front" }],
    };
    const repairPatch = {
      room_updates: [{ id: "tiny", zone: null, area_m2: 1 }],
      link_updates: [],
      link_removals: [],
    };
    const requests = stubPasses([
      tinyProgram,
      { links: [] },
      { windows: [{ room_id: "tiny", count: 0 }] },
      repairPatch,
    ]);

    const plan = await generateFloorPlanFromPrompt("A tiny room");

    expect(requests).toHaveLength(4);
    expect(JSON.parse(requests[3].body as string).prompt).toContain("area-drift");
    expect(plan.rooms[0].area_m2).toBe(1);
    expect(plan.warnings).toEqual([]);
  });

  it("caps geometry repair at two iterations", async () => {
    const tinyProgram = {
      grid_unit_m: 0.5,
      entrance_room: "tiny",
      rooms: [{ id: "tiny", type: "living_room", area_m2: 0.1, zone: "front" }],
    };
    const driftingPatch = (area_m2: number) => ({
      room_updates: [{ id: "tiny", zone: null, area_m2 }],
      link_updates: [],
      link_removals: [],
    });
    const requests = stubPasses([
      tinyProgram,
      { links: [] },
      { windows: [{ room_id: "tiny", count: 0 }] },
      driftingPatch(0.2),
      driftingPatch(0.3),
    ]);

    const plan = await generateFloorPlanFromPrompt("A tiny room");

    expect(requests).toHaveLength(5);
    expect(plan.warnings.some((warning) => warning.includes("differs from target area"))).toBe(
      true,
    );
  });

  it("stops repairing when the model returns an unchanged patch", async () => {
    const tinyProgram = {
      grid_unit_m: 0.5,
      entrance_room: "tiny",
      rooms: [{ id: "tiny", type: "living_room", area_m2: 0.1, zone: "front" }],
    };
    const noOpPatch = {
      room_updates: [],
      link_updates: [],
      link_removals: [],
    };
    const requests = stubPasses([
      tinyProgram,
      { links: [] },
      { windows: [{ room_id: "tiny", count: 0 }] },
      noOpPatch,
    ]);

    const plan = await generateFloorPlanFromPrompt("A tiny room");

    expect(requests).toHaveLength(4);
    expect(
      plan.warnings.some((warning) => warning.includes("returned no changes")),
    ).toBe(true);
  });

  it("keeps a disconnecting link removal instead of discarding the repair patch", async () => {
    const program = {
      grid_unit_m: 0.5,
      entrance_room: "living",
      rooms: [
        { id: "living", type: "living_room", area_m2: 0.25, zone: "front" },
        { id: "bed", type: "bedroom", area_m2: 25, zone: "private" },
      ],
    };
    const links = {
      links: [{ from: "living", to: "bed", connection: "door" }],
    };
    const windows = {
      windows: [
        { room_id: "living", count: 0 },
        { room_id: "bed", count: 0 },
      ],
    };
    const repairPatch = {
      room_updates: [{ id: "living", zone: null, area_m2: 3 }],
      link_updates: [],
      link_removals: [{ from: "living", to: "bed" }],
    };
    const requests = stubPasses([program, links, windows, repairPatch]);

    const plan = await generateFloorPlanFromPrompt("A tiny living room with a bedroom");

    expect(requests).toHaveLength(4);
    expect(plan.rooms.find((room) => room.id === "living")?.area_m2).toBe(3);
    expect(
      plan.warnings.some((warning) => warning.includes("kept the link between")),
    ).toBe(true);
  });

  it("rejects invalid room references and disconnected graphs in merged JSON", () => {
    expect(() =>
      parseGeneratedFloorPlan(
        JSON.stringify({ ...semanticPlan, entrance_room: "missing" }),
      ),
    ).toThrow('entrance_room "missing" does not exist');

    expect(() =>
      parseGeneratedFloorPlan(
        JSON.stringify({
          ...semanticPlan,
          links: [{ from: "living", to: "missing", connection: "door" }],
        }),
      ),
    ).toThrow("references an unknown room id");

    expect(() =>
      parseGeneratedFloorPlan(JSON.stringify({ ...semanticPlan, rooms: [] })),
    ).toThrow("rooms must contain between 1 and 32 entries");
  });

  it("continues to parse pasted fenced JSON and repair a placeholder entrance id", () => {
    const pasted = `\`\`\`json\n${JSON.stringify({
      ...semanticPlan,
      entrance_room: "entrance_room",
    })}\n\`\`\``;

    const plan = parsePastedFloorPlan(pasted);

    expect(plan.rooms).toHaveLength(3);
    expect(plan.warnings[0]).toContain('using existing room "living" instead');
  });
});
