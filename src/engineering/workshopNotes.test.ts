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
        "Verify the supplied rise onsite before laying out.",
        "Dry-fit one stringer before making the remaining cuts.",
        "Check bearing and attachments against the approved plan.",
      ],
      cuttingInstructions: [
        "Mark the supplied riser count evenly over the measured rise.",
        "Use the supplied unit run to lay out each tread notch.",
        "Leave end-cut allowance and verify the stock length before cutting.",
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
    expect(body.prompt).toContain("do not calculate or repeat dimensions");
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
});
