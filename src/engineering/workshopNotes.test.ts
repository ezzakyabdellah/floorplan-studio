import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultProjectState } from "./projectStore";
import { defaultWorkshopNotes } from "./shopSheet";
import { generateWorkshopNotes } from "./workshopNotes";

afterEach(() => vi.unstubAllGlobals());

describe("workshop notes", () => {
  it("provides deterministic offline instructions tied to current metrics", () => {
    const project = createDefaultProjectState();
    const notes = defaultWorkshopNotes(project);
    expect(notes.assemblyNotes.length).toBeGreaterThanOrEqual(3);
    expect(notes.cuttingInstructions.join(" ")).toContain(
      `${project.calculatedMetrics.stepCount}`,
    );
    expect(notes.cuttingInstructions.join(" ")).toContain(
      project.calculatedMetrics.pitchAngleDegrees.toString(),
    );
  });

  it("uses structured local model output for shop notes", async () => {
    const generated = {
      assemblyNotes: [
        "Verify the 108 in rise and 132 in run onsite before laying out.",
        "Lay out 14 equal risers and 13 treads from the supplied metrics.",
        "Check bearing and attachments against the approved plan.",
      ],
      cuttingInstructions: [
        "Mark 14 riser positions over the full rise; average rise is 7.714 in.",
        "Lay out 13 tread notches using the 10 1/8 in unit run and 39.29 degree pitch.",
        "Distribute 31 balusters with a 3 7/8 in clear gap.",
      ],
    };
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init) requests.push(init);
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify(generated) }),
        };
      }),
    );

    const notes = await generateWorkshopNotes(createDefaultProjectState(), {
      model: "llama3.2",
    });
    expect(notes).toEqual(generated);
    const body = JSON.parse(requests[0].body as string);
    expect(body.prompt).toContain("rounded to at most three decimal places");
    expect(body.prompt).toContain("Deterministic calculated metrics");
    expect(body.format.type).toBe("object");
  });

  it("rejects malformed or unbounded local model output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            assemblyNotes: ["ok", "ok", "ok"],
            cuttingInstructions: ["x".repeat(361), "ok", "ok"],
          }),
        }),
      })),
    );
    await expect(
      generateWorkshopNotes(createDefaultProjectState()),
    ).rejects.toThrow("invalid cuttingInstructions");
  });

  it("rejects numeric claims that do not match project parameters or metrics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            assemblyNotes: ["Verify site measurements.", "Dry-fit the stringer.", "Check bearing."],
            cuttingInstructions: [
              "Cut the stringer at 42 degrees.",
              "Use the dimension labels.",
              "Verify all cuts before assembly.",
            ],
          }),
        }),
      })),
    );
    await expect(
      generateWorkshopNotes(createDefaultProjectState()),
    ).rejects.toThrow("invalid cuttingInstructions");
  });
});
