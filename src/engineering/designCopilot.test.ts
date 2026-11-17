import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_TOOL_SCHEMAS,
  parseOfflineDesignRequest,
  requestDesignToolCall,
  runOfflineDesignRequest,
} from "./designCopilot";
import { createDefaultProjectState } from "./projectStore";

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

  it("executes the structured update tool and strips model-supplied unknown fields", async () => {
    const modelResponse = {
      tool: "updateDesignParameters",
      arguments: {
        projectType: "staircase",
        stairParams: {
          totalRise: 108,
          totalRun: 120,
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
      "Make a 108 inch rise stair with a 120 inch run",
      createDefaultProjectState(),
    );

    expect(result.toolCall.tool).toBe("updateDesignParameters");
    if (result.toolCall.tool === "updateDesignParameters") {
      expect(result.toolCall.arguments.stairParams).toEqual({
        totalRise: 108,
        totalRun: 120,
      });
    }
    const requestBody = JSON.parse(requests[0].body as string);
    expect(requestBody.format.type).toBe("object");
    expect(requestBody.prompt).toContain("Do not calculate geometry");
  });
});
