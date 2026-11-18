import type { Opening, OpeningType, Wall } from "../types/floorplan";
import { generateLocalJson, type StreamOptions } from "./localAiService";

export type GeneratedFloorPlan = {
  name: string;
  walls: Wall[];
  openings: Opening[];
};

type RawWall = {
  x1?: unknown;
  y1?: unknown;
  x2?: unknown;
  y2?: unknown;
  thickness?: unknown;
  height?: unknown;
};

type RawOpening = {
  wallIndex?: unknown;
  type?: unknown;
  position?: unknown;
  width?: unknown;
};

const FLOOR_PLAN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    walls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
          thickness: { type: "number" },
          height: { type: "number" },
        },
        required: ["x1", "y1", "x2", "y2", "thickness", "height"],
        additionalProperties: false,
      },
    },
    openings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          wallIndex: { type: "integer" },
          type: { type: "string", enum: ["door", "window"] },
          position: { type: "number" },
          width: { type: "number" },
        },
        required: ["wallIndex", "type", "position", "width"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "walls", "openings"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error("The local model returned invalid JSON for the floor plan.");
  }
}

/** Parse and constrain model output before it can enter the editable scene. */
export function parseGeneratedFloorPlan(text: string): GeneratedFloorPlan {
  const decoded = parseResponse(text);
  if (!isRecord(decoded) || !Array.isArray(decoded.walls) || !Array.isArray(decoded.openings)) {
    throw new Error("The AI response must include walls and openings arrays.");
  }
  if (decoded.walls.length < 4 || decoded.walls.length > 40) {
    throw new Error("The AI plan must contain between 4 and 40 walls.");
  }
  if (decoded.openings.length > 64) {
    throw new Error("The AI plan contains too many doors or windows.");
  }

  const walls: Wall[] = decoded.walls.map((rawWall, index) => {
    if (!isRecord(rawWall)) {
      throw new Error(`Wall ${index + 1} is not a valid object.`);
    }
    const wall = rawWall as RawWall;
    const values = [wall.x1, wall.y1, wall.x2, wall.y2, wall.thickness, wall.height];
    if (!values.every(finiteNumber)) {
      throw new Error(`Wall ${index + 1} contains missing or invalid measurements.`);
    }
    const [x1, y1, x2, y2, thickness, height] = values as number[];
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (
      Math.abs(x1) > 100 ||
      Math.abs(y1) > 100 ||
      Math.abs(x2) > 100 ||
      Math.abs(y2) > 100 ||
      length < 1 ||
      length > 200
    ) {
      throw new Error(`Wall ${index + 1} is outside the supported 1–200 ft plan bounds.`);
    }
    if (thickness < 0.1 || thickness > 2 || height < 4 || height > 20) {
      throw new Error(`Wall ${index + 1} has an unsupported thickness or height.`);
    }
    return {
      id: `ai-wall-${index + 1}`,
      x1,
      y1,
      x2,
      y2,
      thickness,
      height,
    };
  });

  const openingRanges = new Map<number, Array<{ position: number; width: number }>>();
  const openings: Opening[] = decoded.openings.map((rawOpening, index) => {
    if (!isRecord(rawOpening)) {
      throw new Error(`Opening ${index + 1} is not a valid object.`);
    }
    const opening = rawOpening as RawOpening;
    const { wallIndex, type, position, width } = opening;
    if (
      typeof wallIndex !== "number" ||
      !Number.isInteger(wallIndex) ||
      wallIndex < 0 ||
      wallIndex >= walls.length ||
      (type !== "door" && type !== "window") ||
      !finiteNumber(position) ||
      !finiteNumber(width)
    ) {
      throw new Error(`Opening ${index + 1} refers to invalid wall or opening data.`);
    }
    const wall = walls[wallIndex];
    const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    const edgeClearance = (width / 2) / length;
    if (
      width < 0.5 ||
      width > 12 ||
      position < edgeClearance ||
      position > 1 - edgeClearance
    ) {
      throw new Error(`Opening ${index + 1} does not fit safely on its wall.`);
    }
    const onWall = openingRanges.get(wallIndex) ?? [];
    if (
      onWall.some(
        (existing) =>
          Math.abs(existing.position - position) * length <
          (existing.width + width) / 2 + 0.25,
      )
    ) {
      throw new Error(`Opening ${index + 1} overlaps another opening.`);
    }
    onWall.push({ position, width });
    openingRanges.set(wallIndex, onWall);
    return {
      id: `ai-opening-${index + 1}`,
      wallId: wall.id,
      type: type as OpeningType,
      positionOnWall: position,
      width,
    };
  });

  const name =
    typeof decoded.name === "string" && decoded.name.trim()
      ? decoded.name.trim().slice(0, 80)
      : "AI Generated Floor Plan";
  return { name, walls, openings };
}

function buildPrompt(request: string) {
  return [
    "You are a floor-plan design assistant. Create an editable 2D architectural floor plan from the user's requirements.",
    "All coordinates and dimensions are in feet on an X/Y plane. Use straight wall segments. Return a complete, connected, closed outer perimeter, plus sensible interior partition walls where requested.",
    "Add door openings for room access and windows on suitable exterior walls. Each opening references a zero-based wallIndex in the walls array, has a position from 0 to 1 along that wall, and a width in feet.",
    "Keep dimensions practical: wall coordinates between -100 and 100 ft, wall lengths 1 to 200 ft, wall thickness 0.1 to 2 ft, wall height 4 to 20 ft, and opening widths 0.5 to 12 ft. Keep openings away from wall endpoints and do not add overlapping openings.",
    "Use at most 40 walls and 64 openings. Do not include furniture. Return only JSON matching the requested schema. Do not add markdown.",
    "",
    `User requirements: ${request.trim()}`,
  ].join("\n");
}

export async function generateFloorPlanFromPrompt(
  request: string,
  options: StreamOptions = {},
): Promise<GeneratedFloorPlan> {
  const trimmedRequest = request.trim();
  if (!trimmedRequest) {
    throw new Error("Describe the rooms and dimensions you want first.");
  }
  if (trimmedRequest.length > 1200) {
    throw new Error("Keep the floor-plan description under 1,200 characters.");
  }

  const response = await generateLocalJson(
    buildPrompt(trimmedRequest),
    {
      ...options,
      numPredict: options.numPredict ?? 3072,
      numContext: options.numContext ?? 8192,
      operation: options.operation ?? "floorplan-generation",
    },
    FLOOR_PLAN_SCHEMA,
  );
  return parseGeneratedFloorPlan(response);
}
