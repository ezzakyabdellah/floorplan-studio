import type { Furniture, FurnitureKind, Opening, Wall } from "../types/floorplan";
import { furnitureCatalogItem } from "../data/furnitureCatalog";
import { scaleFurnitureToWalls } from "../utils/furnitureScale";
import { pointAtDistance, wallLength } from "../utils/geometry";
import {
  DEFAULT_AI_MODELS,
  checkOllamaStatus,
  generateLocalJson,
  type StreamOptions,
} from "./localAiService";
import {
  inferFurnitureRooms,
  suggestFurnitureLayout,
  validateFurnitureSuggestions,
  type FurniturePlan,
  type RoomGuess,
} from "./furniturePlanner";

export type AiFurnitureResult = FurniturePlan & {
  model: string;
};

export type FurnitureAssistanceResult = {
  plan: FurniturePlan;
  mode: "local-llm" | "geometry";
  model?: string;
  note: string;
};

const FURNITURE_KINDS: FurnitureKind[] = [
  "bed",
  "nightstand",
  "wardrobe",
  "sofa",
  "coffee-table",
  "media-console",
  "desk",
  "desk-chair",
  "dining-table",
  "chair",
];

type RawFurniture = {
  roomId?: unknown;
  kind?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  depth?: unknown;
  height?: unknown;
  rotationDeg?: unknown;
  confidence?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoverCompleteFurnitureRows(text: string) {
  const rowPattern = /\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
  return Array.from(text.matchAll(rowPattern), ([, roomId, kind, x, y, rotationDeg]) => ({
    roomId: Number(roomId),
    kind,
    x: Number(x),
    y: Number(y),
    rotationDeg: Number(rotationDeg),
  }));
}

function parseFurnitureResponse(text: string) {
  const trimmed = text.trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    const objectStart = text.indexOf("{");
    const arrayStart = text.indexOf("[");
    const start = [objectStart, arrayStart]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (start === undefined) {
      throw new Error("The local model did not return a JSON furniture layout.");
    }
    const close = text[start] === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end <= start) {
      const recoveredRows = recoverCompleteFurnitureRows(text);
      if (recoveredRows.length === 0) {
        throw new Error("The local model returned incomplete JSON furniture data.");
      }
      decoded = { furniture: recoveredRows };
    } else {
      try {
        decoded = JSON.parse(text.slice(start, end + 1));
      } catch {
        const recoveredRows = recoverCompleteFurnitureRows(text);
        if (recoveredRows.length === 0) {
          throw new Error("The local model returned invalid JSON for furniture placement.");
        }
        decoded = { furniture: recoveredRows };
      }
    }
  }

  if (decoded === undefined) {
    throw new Error("The local model did not return a JSON furniture layout.");
  }

  const placements = Array.isArray(decoded)
    ? decoded
    : isRecord(decoded) && Array.isArray(decoded.furniture)
      ? decoded.furniture
      : null;
  if (!placements) {
    throw new Error("The local model response did not include a furniture array.");
  }
  return placements.map((item) => {
    if (Array.isArray(item)) {
      const [roomId, kind, x, y, rotationDeg, confidence] = item;
      return { roomId, kind, x, y, rotationDeg, confidence };
    }
    return item as RawFurniture;
  });
}

function roomContext(room: RoomGuess) {
  return `Room ${room.id} (${room.kind}): X ${room.minX.toFixed(1)} to ${room.maxX.toFixed(1)} ft; Y ${room.minY.toFixed(1)} to ${room.maxY.toFixed(1)} ft; width ${(room.maxX - room.minX).toFixed(1)} ft; depth ${(room.maxY - room.minY).toFixed(1)} ft; area ${room.area.toFixed(1)} sq ft; doors ${room.doorCount}.`;
}

function buildFurniturePrompt(walls: Wall[], openings: Opening[], rooms: RoomGuess[]) {
  const wallDimensions = walls.map(
    (wall) =>
      `Wall ${wall.id}: (${wall.x1.toFixed(1)}, ${wall.y1.toFixed(1)}) to (${wall.x2.toFixed(1)}, ${wall.y2.toFixed(1)}); thickness ${wall.thickness.toFixed(2)} ft; height ${wall.height.toFixed(1)} ft.`,
  );
  const openingDimensions = openings.map((opening) => {
    const wall = walls.find((candidate) => candidate.id === opening.wallId);
    const center = wall
      ? pointAtDistance(wall, opening.positionOnWall * wallLength(wall))
      : null;
    return `${opening.type} on wall ${opening.wallId}, position ${opening.positionOnWall.toFixed(3)}, width ${opening.width.toFixed(1)} ft${center ? `, center (${center.x.toFixed(1)}, ${center.y.toFixed(1)})` : ""}.`;
  });

  return [
    "Plan furniture like an interior designer. Units are feet; ground plane is X/Y (Y becomes 3D depth).",
    "Choose one sensible primary furniture item per usable room. Bedrooms need a bed, living rooms a sofa, studies a desk, dining rooms a dining-table. Keep hallways clear. At most one primary item per room, max 5 items.",
    "Use all room, wall, and opening dimensions to choose furniture center points. Place items away from walls and door approaches. Furniture dimensions are assigned locally from the selected type.",
    `Allowed kinds: ${FURNITURE_KINDS.join(", ")}. Return compact JSON only as {"furniture":[[0,"bed",10,10,0]]}. Each row is [roomId, kind, centerX, centerY, rotationDeg]. Use room IDs exactly; do not copy room measurements into the output.`,
    "Detected rooms and their complete dimensions:",
    rooms.map(roomContext).join("\n"),
    "Every wall and its dimensions:",
    wallDimensions.join("\n"),
    "Every door and window with dimensions and locations:",
    openingDimensions.join("\n"),
  ].join("\n\n");
}

export async function suggestFurnitureWithLocalAI(
  walls: Wall[],
  openings: Opening[],
  options: StreamOptions = {},
): Promise<AiFurnitureResult> {
  const { rooms, cellSize } = inferFurnitureRooms(walls, openings);
  if (rooms.length === 0) {
    throw new Error("The floor plan does not contain any enclosed rooms to furnish.");
  }

  const model = options.model?.trim() || "llama3.2";
  const response = await generateLocalJson(
    buildFurniturePrompt(walls, openings, rooms),
    { ...options, model },
  );
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const raw = parseFurnitureResponse(response);
  const suggestions: Furniture[] = raw.flatMap((item, index) => {
    if (
      typeof item.roomId !== "number" ||
      !Number.isInteger(item.roomId) ||
      typeof item.kind !== "string" ||
      !FURNITURE_KINDS.includes(item.kind as FurnitureKind)
    ) {
      return [];
    }
    const room = roomById.get(item.roomId);
    const numbers = [item.x, item.y, item.rotationDeg];
    if (!room || !numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return [];
    }
    const { width, depth, height } = furnitureCatalogItem(item.kind as FurnitureKind);

    return [{
      id: `local-ai-${item.roomId}-${index}`,
      roomId: item.roomId,
      kind: item.kind as FurnitureKind,
      source: "local-llm",
      roomLabel: room.label,
      x: item.x as number,
      y: item.y as number,
      width,
      depth,
      height,
      rotation: ((item.rotationDeg as number) * Math.PI) / 180,
      confidence:
        typeof item.confidence === "number" && Number.isFinite(item.confidence)
          ? Math.max(0, Math.min(1, item.confidence))
          : room.confidence,
    }];
  });

  const geometryPlan = suggestFurnitureLayout(walls, openings);
  const initiallyValid = validateFurnitureSuggestions(walls, openings, suggestions);
  const recoveredSuggestions = suggestions.map((suggestion) => {
    if (initiallyValid.some((item) => item.id === suggestion.id)) return suggestion;
    const matchingGeometry = geometryPlan.furniture
      .filter((item) => item.roomId === suggestion.roomId && item.kind === suggestion.kind)
      .sort(
        (a, b) =>
          Math.hypot(a.x - suggestion.x, a.y - suggestion.y) -
          Math.hypot(b.x - suggestion.x, b.y - suggestion.y),
      )[0];
    return matchingGeometry
      ? {
          ...suggestion,
          x: matchingGeometry.x,
          y: matchingGeometry.y,
          rotation: matchingGeometry.rotation,
        }
      : suggestion;
  });
  const furniture = validateFurnitureSuggestions(walls, openings, recoveredSuggestions);
  if (furniture.length === 0) {
    throw new Error("The local model's furniture suggestions did not fit safely inside the detected rooms.");
  }

  const primaryKinds = new Set<FurnitureKind>([
    "bed",
    "sofa",
    "desk",
    "dining-table",
  ]);
  const roomsWithAiPrimary = new Set(
    furniture
      .filter((item) => primaryKinds.has(item.kind))
      .map((item) => item.roomId),
  );
  const geometryExtras = geometryPlan.furniture.filter(
    (item) =>
      !furniture.some(
        (placed) => placed.roomId === item.roomId && placed.kind === item.kind,
      ) &&
      !(primaryKinds.has(item.kind) && roomsWithAiPrimary.has(item.roomId)),
  );
  const completedFurniture = validateFurnitureSuggestions(
    walls,
    openings,
    [...furniture, ...geometryExtras],
  );

  return { rooms, furniture: completedFurniture, cellSize, model };
}

export async function generateFurnitureLayoutWithAI(
  walls: Wall[],
  openings: Opening[],
  options: StreamOptions = {},
): Promise<FurnitureAssistanceResult> {
  const status = await checkOllamaStatus(options.signal);
  if (!status.online || status.models.length === 0) {
    const geometryPlan = suggestFurnitureLayout(walls, openings);
    return {
      plan: {
        ...geometryPlan,
        furniture: scaleFurnitureToWalls(geometryPlan.furniture, walls),
      },
      mode: "geometry",
      note: "Ollama is offline; used the local geometry-based room guess.",
    };
  }

  const installedModel = DEFAULT_AI_MODELS.map((preferred) =>
    status.models.find(
      (candidate) => candidate === preferred || candidate.startsWith(`${preferred}:`),
    ),
  ).find((candidate) => Boolean(candidate));
  const model = options.model?.trim() || installedModel || status.models[0];

  try {
    const plan = await suggestFurnitureWithLocalAI(walls, openings, {
      ...options,
      model,
    });
    const scaledPlan = {
      ...plan,
      furniture: scaleFurnitureToWalls(plan.furniture, walls),
    };
    return {
      plan: scaledPlan,
      mode: "local-llm",
      model,
      note: `Ollama ${model} suggested ${scaledPlan.furniture.length} placements; room, wall, and door clearances were checked locally.`,
    };
  } catch (error) {
    const geometryPlan = suggestFurnitureLayout(walls, openings);
    return {
      plan: {
        ...geometryPlan,
        furniture: scaleFurnitureToWalls(geometryPlan.furniture, walls),
      },
      mode: "geometry",
      model,
      note: `Ollama could not return a safe layout; used the local geometry-based guess${error instanceof Error ? ` (${error.message})` : ""}.`,
    };
  }
}
