import { generateLocalJson, type StreamOptions } from "./localAiService";
import {
  solveFloorPlanLayout,
  validateSemanticFloorPlan,
  type SolvedRoom,
} from "./floorPlanLayoutSolver";
import type { Opening, Wall } from "../types/floorplan";

export type GeneratedFloorPlan = {
  name: string;
  walls: Wall[];
  openings: Opening[];
  rooms: SolvedRoom[];
  warnings: string[];
};

const SEMANTIC_PLAN_SCHEMA = {
  type: "object",
  properties: {
    grid_unit_m: { type: "number", minimum: 0.1, maximum: 2 },
    entrance_room: { type: "string", minLength: 1 },
    rooms: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          area_m2: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          zone: {
            type: "string",
            enum: ["front", "core", "private", "service"],
          },
          windows: { type: "integer", minimum: 0, maximum: 12 },
        },
        required: ["id", "type", "area_m2", "zone", "windows"],
        additionalProperties: false,
      },
    },
    links: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          connection: { type: "string", enum: ["door", "open", "arch"] },
        },
        required: ["from", "to", "connection"],
        additionalProperties: false,
      },
    },
  },
  required: ["grid_unit_m", "entrance_room", "rooms", "links"],
  additionalProperties: false,
} as const;

function buildSemanticPlanPrompt(request: string) {
  return [
    "Design a residential floor plan as a semantic room graph, not as geometry.",
    "Return exactly one JSON object matching the supplied schema. Do not add markdown, comments, names, coordinates, walls, or other properties.",
    "Use square meters for area_m2 and set grid_unit_m to 0.5 unless the user specifies another metric grid.",
    "Use stable, unique, short room IDs. Use only the zones front, core, private, and service.",
    "Put the main exterior entry in entrance_room. Include a windows integer on every room; use 0 for interior-only bathrooms, closets, and similar rooms.",
    "Use links to describe every important adjacency. connection must be door, open, or arch.",
    "Keep room areas positive and practical. Keep the total layout connected and group private rooms together, service rooms together, and circulation in the core.",
    `User request: ${request}`,
  ].join("\n");
}

function parseJson(text: string) {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch (cause) {
    const error = new Error("The AI returned invalid JSON for the semantic floor plan.");
    console.error("[Floor plan parsing]", error, cause);
    throw error;
  }
}

function parseSemanticPlan(text: string): GeneratedFloorPlan {
  const semanticPlan = validateSemanticFloorPlan(parseJson(text));
  const solved = solveFloorPlanLayout(semanticPlan);
  return {
    name: "AI Generated Floor Plan",
    rooms: solved.rooms,
    walls: solved.walls,
    openings: solved.openings,
    warnings: solved.warnings,
  };
}

async function generateValidated(
  prompt: string,
  parse: (text: string) => GeneratedFloorPlan,
  options: StreamOptions,
) {
  const response = await generateLocalJson(prompt, options, SEMANTIC_PLAN_SCHEMA);
  try {
    return parse(response);
  } catch (firstError) {
    if (options.signal?.aborted) throw firstError;
    console.warn(
      "[Floor plan generation] Invalid response; asking the model to correct it.",
      firstError,
    );
    const reason =
      firstError instanceof Error ? firstError.message : "invalid semantic JSON";
    options.onChunk?.("\n\n[Correcting the semantic floor-plan response…]\n");
    const corrected = await generateLocalJson(
      [
        prompt,
        "",
        `Validation errors to fix: ${reason}`,
        "Regenerate the entire semantic floor-plan JSON from scratch.",
        "Use only the required schema properties, valid room IDs for entrance_room and every link, positive areas, and non-negative integer window counts.",
        "Return one JSON object only.",
      ].join("\n"),
      options,
      SEMANTIC_PLAN_SCHEMA,
    );
    try {
      return parse(corrected);
    } catch (retryError) {
      const retryReason =
        retryError instanceof Error ? retryError.message : "invalid semantic JSON";
      throw new Error(
        `The AI semantic floor plan is still invalid after one correction attempt. ${retryReason}`,
      );
    }
  }
}

export function parseGeneratedFloorPlan(text: string): GeneratedFloorPlan {
  try {
    return parseSemanticPlan(text);
  } catch (error) {
    console.error("[Floor plan parsing]", error);
    throw error;
  }
}

export async function generateFloorPlanFromPrompt(
  request: string,
  options: StreamOptions = {},
): Promise<GeneratedFloorPlan> {
  try {
    const trimmedRequest = request.trim();
    if (!trimmedRequest) {
      throw new Error("Describe the rooms and dimensions you want first.");
    }
    if (trimmedRequest.length > 1200) {
      throw new Error("Keep the floor-plan description under 1,200 characters.");
    }

    const generationOptions: StreamOptions = {
      ...options,
      numContext: options.numContext ?? 8192,
      numPredict: options.numPredict ?? 2200,
      timeoutMs: options.timeoutMs ?? 300_000,
      operation: "floorplan-generation-semantic",
    };
    return await generateValidated(
      buildSemanticPlanPrompt(trimmedRequest),
      parseSemanticPlan,
      generationOptions,
    );
  } catch (error) {
    console.error("[Floor plan generation]", error);
    throw error;
  }
}
