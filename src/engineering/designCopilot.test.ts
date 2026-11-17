import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_TOOL_SCHEMAS,
  formatDesignPatchSummary,
  parseOfflineDesignRequest,
  requestDesignToolCall,
  runOfflineDesignRequest,
} from "./designCopilot";
import { createDefaultProjectState, useProjectStore } from "./projectStore";

afterEach(() => vi.unstubAllGlobals());

describe("design copilot parameter extraction", () => {
  it("exposes only parameter update and deterministic audit tools", () => {
    expect(DESIGN_TOOL_SCHEMAS.map((tool) => tool.name)).toEqual([
      "updateDesignParameters",
      "auditBuildingCode",
    ]);
  });

  it("extracts natural-language stair dimensions and style", () => {
    const patch = parseOfflineDesignRequest(
      "Set floor-to-floor rise to 108 inches, hallway length to 120 inches and use an L-shaped stair",
      { units: "imperial" },
    );
    expect(patch?.projectType).toBe("staircase");
    expect(patch?.stairParams).toMatchObject({
      style: "l-shaped",
      totalRise: 108,
      totalRun: 120,
    });
  });

  it("converts stated dimensions into the selected project units", () => {
    const patch = parseOfflineDesignRequest(
      "Set working height to 12 feet for an extension ladder",
      { units: "metric" },
    );
    expect(patch?.projectType).toBe("ladder");
    expect(patch?.ladderParams?.workingHeight).toBe(3658);
  });

  it("converts metric metre dimensions to millimetres", () => {
    const patch = parseOfflineDesignRequest(
      "Set total rise to 2.8 meters and total run to 6 m",
      { units: "metric" },
    );
    expect(patch?.stairParams).toMatchObject({
      totalRise: 2800,
      totalRun: 6000,
    });
  });

  it("formats copilot response dimensions in the selected project units", () => {
    expect(
      formatDesignPatchSummary(
        { stairParams: { totalRise: 2800, totalRun: 6000 } },
        "metric",
      ),
    ).toBe("Updated total rise: 2800 mm; total run: 6000 mm.");
    expect(
      formatDesignPatchSummary({ stairParams: { totalRise: 108 } }, "imperial"),
    ).toBe("Updated total rise: 108 in.");
    expect(formatDesignPatchSummary(undefined, "metric")).toBe(
      "Project dimensions are in mm.",
    );
  });

  it("uses a room height as stair rise and ignores room dimensions not requested for the stairs", () => {
    const patch = parseOfflineDesignRequest(
      "I have a room 3m x 6m and 2.8m height, I want a stair to the top room, use the longest side (6m) but use optimal run",
      { units: "metric" },
    );
    expect(patch).toMatchObject({
      projectType: "staircase",
      stairParams: {
        totalRise: 2800,
        totalRun: 6000,
      },
    });
    expect(patch?.stairParams).not.toHaveProperty("width");
    expect(patch?.stairParams).not.toHaveProperty("landingLength");
  });

  it("can deterministically audit offline without any model request", async () => {
    const result = await runOfflineDesignRequest(
      "Run a safety audit",
      createDefaultProjectState(),
    );
    expect(result.source).toBe("offline-parser");
    expect(result.audit?.findings.length).toBeGreaterThan(0);
  });

  it("extracts fractional-inch measurements", () => {
    const patch = parseOfflineDesignRequest(
      "Set stair width to 3 1/2 inches",
      { units: "imperial" },
    );
    expect(patch?.stairParams?.width).toBe(3.5);
  });

  it("extracts layout-specific landing and spiral parameters", () => {
    const patch = parseOfflineDesignRequest(
      "Use an L-shaped stair with a 42 inch landing, or a spiral radius of 40 inches and 1.5 turns",
      { units: "imperial" },
    );
    expect(patch?.stairParams).toMatchObject({
      style: "spiral",
      landingLength: 42,
      spiralRadius: 40,
      spiralTurns: 1.5,
    });
  });

  it("constrains nested output, allows enough tokens, and corrects explicit metric dimensions", async () => {
    const modelResponse = {
      tool: "updateDesignParameters",
      arguments: {
        projectType: "staircase",
        stairParams: {
          totalRise: 2.8,
          totalRun: 6,
          width: 0.6,
          landingLength: 0.6,
          spiralRadius: 0,
          spiralTurns: 0,
          balusterSpacingMax: 0,
          untrustedMetric: 9999,
        },
      },
      message: "Parameters extracted.",
    };
    const requests: RequestInit[] = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init) requests.push(init);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(modelResponse) }),
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestDesignToolCall(
      "I have a room 3m x 6m and 2.8m height, I want a stair to the top room, use the longest side (6m) but use optimal run",
      { ...createDefaultProjectState(), units: "metric" },
    );

    expect(result.toolCall.tool).toBe("updateDesignParameters");
    if (result.toolCall.tool === "updateDesignParameters") {
      expect(result.toolCall.arguments.stairParams).toEqual({
        totalRise: 2800,
        totalRun: 6000,
      });
    }
    const requestBody = JSON.parse(requests[0].body as string);
    expect(requestBody.format.type).toBe("object");
    expect(requestBody.format.properties.arguments.properties.stairParams.properties.totalRise.type).toBe("number");
    expect(requestBody.prompt).toContain("Do not calculate geometry");
    expect(requestBody.prompt).toContain("using only mm");
    expect(requestBody.prompt).toContain("Convert input measurements to this unit first");
    expect(requestBody.options.num_predict).toBeGreaterThanOrEqual(512);
  });

  it("applies an AI-selected U-shaped style without applying its zero defaults", async () => {
    const modelResponse = {
      tool: "updateDesignParameters",
      arguments: {
        projectType: "staircase",
        units: "metric",
        stairParams: {
          style: "u-shaped",
          totalRise: 2.8,
          totalRun: 0,
          width: 0,
          landingLength: 0,
          spiralRadius: 0,
          spiralTurns: 0,
          headroomCeilingHeight: 0,
          balusterSpacingMax: 0,
        },
      },
      message: "Updated stair.",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: JSON.stringify(modelResponse) }),
      })),
    );

    const response = await requestDesignToolCall(
      "Set rise to 2.8 m and use U style for the stair",
      { ...createDefaultProjectState(), units: "metric" },
    );

    expect(response.toolCall).toEqual({
      tool: "updateDesignParameters",
      arguments: {
        projectType: "staircase",
        stairParams: {
          totalRise: 2800,
          style: "u-shaped",
        },
      },
    });

    useProjectStore.getState().resetProject();
    useProjectStore.getState().updateDesignParameters({ units: "metric" });
    const applied = useProjectStore
      .getState()
      .updateDesignParameters(response.toolCall.arguments);
    expect(applied.applied).toBe(true);
    expect(useProjectStore.getState().projectType).toBe("staircase");
    expect(useProjectStore.getState().stairParams.style).toBe("u-shaped");
    expect(useProjectStore.getState().stairParams.totalRise).toBe(2800);
    useProjectStore.getState().resetProject();
  });
});
