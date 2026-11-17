import { generateLocalJson, type StreamOptions } from "../services/localAiService";
import { logAiError } from "../services/aiLog";
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

const numericTokenPattern =
  /\b\d+(?:\s+\d+\s*\/\s*\d+|\s*\/\s*\d+|(?:,\d{3})*(?:\.\d+)?)\b/g;

function parseNumericToken(token: string): number {
  const mixed = token.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  if (token.includes("/")) {
    const [numerator, denominator] = token.split("/").map(Number);
    return denominator ? numerator / denominator : Number.NaN;
  }
  return Number(token.replace(/,/g, ""));
}

function collectProjectNumbers(value: unknown, numbers = new Set<number>()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    numbers.add(value);
    // The UI and shop sheet display computed dimensions rounded to at most
    // three decimal places; accept those exact display forms as verified data.
    for (let precision = 1; precision <= 3; precision += 1) {
      numbers.add(Number(value.toFixed(precision)));
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectProjectNumbers(item, numbers));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectProjectNumbers(item, numbers));
  }
  return numbers;
}

function validateWorkshopNotes(
  value: unknown,
  project: ProjectState,
): WorkshopNotes {
  if (!value || typeof value !== "object") {
    throw new Error("The local model returned invalid workshop notes.");
  }
  const candidate = value as Record<string, unknown>;
  const verifiedNumbers = collectProjectNumbers(project);
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
          /\b(?:IRC|IBC|OSHA|ANSI|ADA)\b/i.test(line) ||
          [
            ...line.matchAll(
              new RegExp(numericTokenPattern.source, "g"),
            ),
          ].some((match) => {
            const value = parseNumericToken(match[0]);
            return (
              !Number.isFinite(value) ||
              ![...verifiedNumbers].some(
                (verified) => Math.abs(verified - value) < 1e-9,
              )
            );
          }),
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
    "Strict safety boundary: do not calculate dimensions, angles, quantities, material capacities, or code compliance. Do not invent geometry.",
    "You may repeat a numeric value only when it matches a supplied parameter or verified metric, including the same value rounded to at most three decimal places for display. Do not invent or further calculate numbers. Do not cite codes; refer readers to the drawing labels for measurements.",
    "Do not make claims that a design is compliant or structurally adequate. Tell the user to verify site dimensions, stock, connections, and local requirements.",
    "Use the supplied cut reference measurements as references only; do not present the stringer hypotenuse as a final stock blank length.",
    `Project type: ${project.projectType}`,
    `Units: ${project.units}`,
    `Parameters: ${JSON.stringify({ stairParams: project.stairParams, ladderParams: project.ladderParams })}`,
    `Deterministic calculated metrics: ${JSON.stringify(project.calculatedMetrics)}`,
    `Offline note outline for context: ${JSON.stringify(fallback)}`,
  ].join("\n\n");
  const raw = await generateLocalJson(
    prompt,
    {
      ...options,
      operation: options.operation ?? "workshop-assembly-notes",
    },
    notesSchema,
  );
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateWorkshopNotes(parsed, project);
  } catch (error) {
    const validationError =
      error instanceof Error
        ? error
        : new Error("The local model returned malformed workshop-note JSON.");
    await logAiError(
      "workshop-notes-output-validation",
      options.model?.trim() || "llama3.2",
      validationError,
    );
    throw validationError;
  }
}
