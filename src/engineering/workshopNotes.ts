import { generateLocalJson, type StreamOptions } from "../services/localAiService";
import { defaultWorkshopNotes, type WorkshopNotes } from "./shopSheet";
import type { ProjectState } from "./types";

const notesSchema = {
  type: "object",
  properties: {
    assemblyNotes: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 5,
    },
    cuttingInstructions: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 5,
    },
  },
  required: ["assemblyNotes", "cuttingInstructions"],
  additionalProperties: false,
};

function validateWorkshopNotes(value: unknown): WorkshopNotes {
  if (!value || typeof value !== "object") {
    throw new Error("The local model returned invalid workshop notes.");
  }
  const candidate = value as Record<string, unknown>;
  const validateLines = (key: "assemblyNotes" | "cuttingInstructions") => {
    const lines = candidate[key];
    if (
      !Array.isArray(lines) ||
      lines.length < 3 ||
      lines.length > 5 ||
      lines.some(
        (line) =>
          typeof line !== "string" ||
          line.trim().length === 0 ||
          line.length > 360 ||
          /\d/.test(line),
      )
    ) {
      throw new Error(`The local model returned invalid ${key}.`);
    }
    return lines.map((line) => line.trim());
  };
  return {
    assemblyNotes: validateLines("assemblyNotes"),
    cuttingInstructions: validateLines("cuttingInstructions"),
  };
}

export async function generateWorkshopNotes(
  project: ProjectState,
  options: StreamOptions = {},
): Promise<WorkshopNotes> {
  const fallback = defaultWorkshopNotes(project);
  const prompt = [
    "You are a workshop note writer. Return concise assembly and cut-sequence notes as JSON.",
    "Strict safety boundary: do not calculate or repeat dimensions, angles, counts, material capacities, or code compliance. Do not invent geometry. The deterministic sheet already labels all verified quantities; refer to those labels in your prose.",
    "Do not include numerals, fractions, measurements, code citations, or numeric claims in generated note strings. If a step needs a quantity, direct the reader to the dimension labels on the sheet.",
    "Do not make claims that a design is compliant or structurally adequate. Tell the user to verify site dimensions, stock, connections, and local requirements.",
    "Use the supplied cut reference measurements as references only; do not present the stringer hypotenuse as a final stock blank length.",
    `Project type: ${project.projectType}`,
    `Units: ${project.units}`,
    `Parameters: ${JSON.stringify({ stairParams: project.stairParams, ladderParams: project.ladderParams })}`,
    `Deterministic calculated metrics: ${JSON.stringify(project.calculatedMetrics)}`,
    `Offline note outline for context: ${JSON.stringify(fallback)}`,
  ].join("\n\n");
  const raw = await generateLocalJson(prompt, options, notesSchema);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The local model returned malformed workshop-note JSON.");
  }
  return validateWorkshopNotes(parsed);
}
