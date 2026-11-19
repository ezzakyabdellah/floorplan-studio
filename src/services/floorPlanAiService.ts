import type { Opening, OpeningType, Wall } from "../types/floorplan";
import { distanceToSegment } from "../utils/geometry";
import { generateLocalJson, type StreamOptions } from "./localAiService";

export type GeneratedFloorPlan = {
  name: string;
  walls: Wall[];
  openings: Opening[];
};

type WallDimensions = {
  width: number;
  depth: number;
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

type ParsedWalls = {
  name: string;
  dimensions: WallDimensions;
  walls: Wall[];
};

const WALLS_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    walls: {
      type: "array",
      minItems: 4,
      maxItems: 48,
      items: {
        type: "object",
        properties: {
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
          thickness: { type: "number", minimum: 0.1, maximum: 2 },
          height: { type: "number", minimum: 4, maximum: 20 },
        },
        required: ["x1", "y1", "x2", "y2", "thickness", "height"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "walls"],
  additionalProperties: false,
} as const;

const OPENINGS_SCHEMA = {
  type: "object",
  properties: {
    openings: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        properties: {
          wallIndex: { type: "integer", minimum: 0, maximum: 47 },
          type: { type: "string", enum: ["door", "window"] },
          position: { type: "number", minimum: 0.05, maximum: 0.95 },
          width: { type: "number", minimum: 0.5, maximum: 12 },
        },
        required: ["wallIndex", "type", "position", "width"],
        additionalProperties: false,
      },
    },
  },
  required: ["openings"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseJson(text: string, description: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error(`The AI returned invalid JSON for ${description}.`);
  }
}

function explicitDimensions(request: string): WallDimensions | null {
  const matches = Array.from(
    request.matchAll(
      /(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')?/gi,
    ),
    ([, width, depth]) => ({
      width: Number(width),
      depth: Number(depth),
    }),
  );
  return (
    matches.sort((a, b) => b.width * b.depth - a.width * a.depth)[0] ?? null
  );
}

function snap(value: number) {
  return Math.round(value * 2) / 2;
}

function roundDimension(value: number) {
  return Number(value.toFixed(2));
}

function canonicalWall(
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
  height: number,
): Wall {
  if (Math.abs(y1 - y2) < 0.1 && x1 > x2) {
    [x1, x2] = [x2, x1];
  } else if (Math.abs(x1 - x2) < 0.1 && y1 > y2) {
    [y1, y2] = [y2, y1];
  }
  return { id, x1, y1, x2, y2, thickness, height };
}

function mergeCollinearWalls(walls: Wall[]) {
  const groups = new Map<string, Wall[]>();
  for (const wall of walls) {
    const horizontal = Math.abs(wall.y1 - wall.y2) < 0.1;
    const coordinate = horizontal ? wall.y1 : wall.x1;
    const key = `${horizontal ? "h" : "v"}:${coordinate.toFixed(2)}`;
    const group = groups.get(key) ?? [];
    group.push(wall);
    groups.set(key, group);
  }

  const result: Wall[] = [];
  for (const group of groups.values()) {
    const horizontal = Math.abs(group[0].y1 - group[0].y2) < 0.1;
    const coordinate = horizontal ? group[0].y1 : group[0].x1;
    const intervals = group
      .map((wall) => ({
        start: horizontal ? wall.x1 : wall.y1,
        end: horizontal ? wall.x2 : wall.y2,
        thickness: wall.thickness,
        height: wall.height,
      }))
      .sort((a, b) => a.start - b.start);
    const merged: typeof intervals = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (previous && interval.start <= previous.end + 0.05) {
        previous.end = Math.max(previous.end, interval.end);
        previous.thickness = Math.max(previous.thickness, interval.thickness);
        previous.height = Math.max(previous.height, interval.height);
      } else {
        merged.push({ ...interval });
      }
    }
    for (const interval of merged) {
      result.push(
        canonicalWall(
          `ai-wall-${result.length + 1}`,
          horizontal ? interval.start : coordinate,
          horizontal ? coordinate : interval.start,
          horizontal ? interval.end : coordinate,
          horizontal ? coordinate : interval.end,
          interval.thickness,
          interval.height,
        ),
      );
    }
  }
  return result;
}

function wallsTouch(a: Wall, b: Wall) {
  const endpointsA = [
    { x: a.x1, y: a.y1 },
    { x: a.x2, y: a.y2 },
  ];
  const endpointsB = [
    { x: b.x1, y: b.y1 },
    { x: b.x2, y: b.y2 },
  ];
  if (
    endpointsA.some((point) => distanceToSegment(point, b) <= 0.25) ||
    endpointsB.some((point) => distanceToSegment(point, a) <= 0.25)
  ) {
    return true;
  }

  const aHorizontal = Math.abs(a.y1 - a.y2) < 0.1;
  const bHorizontal = Math.abs(b.y1 - b.y2) < 0.1;
  if (aHorizontal === bHorizontal) return false;
  const horizontal = aHorizontal ? a : b;
  const vertical = aHorizontal ? b : a;
  return (
    vertical.x1 >= Math.min(horizontal.x1, horizontal.x2) - 0.25 &&
    vertical.x1 <= Math.max(horizontal.x1, horizontal.x2) + 0.25 &&
    horizontal.y1 >= Math.min(vertical.y1, vertical.y2) - 0.25 &&
    horizontal.y1 <= Math.max(vertical.y1, vertical.y2) + 0.25
  );
}

function wallConnectivityIssue(walls: Wall[]) {
  if (walls.length < 4 || walls.length > 48) {
    return `expected 4–48 unique wall segments, got ${walls.length}`;
  }
  const connected = new Set([0]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of [...connected]) {
      walls.forEach((wall, candidateIndex) => {
        if (!connected.has(candidateIndex) && wallsTouch(walls[index], wall)) {
          connected.add(candidateIndex);
          changed = true;
        }
      });
    }
  }
  if (connected.size !== walls.length) {
    return "some wall segments are disconnected";
  }
  return null;
}

function hasContinuousBoundary(
  walls: Wall[],
  axis: "horizontal" | "vertical",
  coordinate: number,
  extent: number,
) {
  const intervals = walls
    .filter((wall) =>
      axis === "horizontal"
        ? Math.abs(wall.y1 - wall.y2) < 0.1 &&
          Math.abs(wall.y1 - coordinate) < 0.1
        : Math.abs(wall.x1 - wall.x2) < 0.1 &&
          Math.abs(wall.x1 - coordinate) < 0.1,
    )
    .map((wall) => ({
      start: axis === "horizontal" ? wall.x1 : wall.y1,
      end: axis === "horizontal" ? wall.x2 : wall.y2,
    }))
    .sort((a, b) => a.start - b.start);
  let coveredTo = 0;
  for (const interval of intervals) {
    if (interval.start > coveredTo + 0.25) return false;
    coveredTo = Math.max(coveredTo, interval.end);
    if (coveredTo >= extent - 0.25) return true;
  }
  return false;
}

function requestedBedroomCount(request: string) {
  const values: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  const match = request.match(
    /\b(\d+|one|two|three|four|five|six)\s*[- ]?\s*bedrooms?\b/i,
  );
  if (!match) return null;
  return Number.isFinite(Number(match[1]))
    ? Number(match[1])
    : values[match[1].toLowerCase()] ?? null;
}

function parseWalls(text: string, request: string): ParsedWalls {
  const value = parseJson(text, "the wall layout");
  if (!isRecord(value) || !Array.isArray(value.walls)) {
    throw new Error("The AI wall iteration must return a walls array.");
  }
  const issues: string[] = [];
  if (value.walls.length > 48) {
    issues.push(`the response contains ${value.walls.length} walls (maximum 48)`);
  }
  const rawWalls: Wall[] = [];
  const wallKeys = new Set<string>();
  value.walls.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(`wall ${index + 1} is not an object`);
      return;
    }
    const raw = item as RawWall;
    const { x1, y1, x2, y2, thickness, height } = raw;
    if (![x1, y1, x2, y2, thickness, height].every(finiteNumber)) {
      issues.push(`wall ${index + 1} has missing or non-finite values`);
      return;
    }
    const x1n = x1 as number;
    const y1n = y1 as number;
    const x2n = x2 as number;
    const y2n = y2 as number;
    const thicknessN = thickness as number;
    const heightN = height as number;
    if (thicknessN < 0.1 || thicknessN > 2 || heightN < 4 || heightN > 20) {
      issues.push(
        `wall ${index + 1} has invalid thickness (${thicknessN}) or height (${heightN})`,
      );
      return;
    }
    const wall = canonicalWall(
      `raw-${index + 1}`,
      snap(x1n),
      snap(y1n),
      snap(x2n),
      snap(y2n),
      roundDimension(thicknessN),
      roundDimension(heightN),
    );
    const horizontal = Math.abs(wall.y1 - wall.y2) < 0.1;
    const vertical = Math.abs(wall.x1 - wall.x2) < 0.1;
    if (!horizontal && !vertical) {
      issues.push(`wall ${index + 1} is diagonal; walls must be horizontal or vertical`);
      return;
    }
    if (Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) < 1) {
      issues.push(
        `wall ${index + 1} is zero-length or shorter than 1 ft`,
      );
      return;
    }
    const key = `${wall.x1.toFixed(2)},${wall.y1.toFixed(2)}:${wall.x2.toFixed(2)},${wall.y2.toFixed(2)}`;
    if (wallKeys.has(key)) {
      issues.push(`wall ${index + 1} duplicates an existing wall in reverse or forward`);
      return;
    }
    wallKeys.add(key);
    rawWalls.push(wall);
  });

  const walls = mergeCollinearWalls(rawWalls);
  const connectivityIssue = wallConnectivityIssue(walls);
  if (connectivityIssue) issues.push(connectivityIssue);
  if (walls.length === 0) {
    throw new Error(`Invalid wall layout: ${issues.join("; ") || "no usable walls"}.`);
  }

  const minX = Math.min(...walls.flatMap((wall) => [wall.x1, wall.x2]));
  const maxX = Math.max(...walls.flatMap((wall) => [wall.x1, wall.x2]));
  const minY = Math.min(...walls.flatMap((wall) => [wall.y1, wall.y2]));
  const maxY = Math.max(...walls.flatMap((wall) => [wall.y1, wall.y2]));
  const footprint = explicitDimensions(request) ?? {
    width: snap(maxX - minX),
    depth: snap(maxY - minY),
  };
  const width = snap(footprint.width);
  const depth = snap(footprint.depth);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (
    width < 8 ||
    depth < 8 ||
    width > 100 ||
    depth > 100
  ) {
    issues.push(`the requested ${width}×${depth} ft footprint is outside supported bounds`);
  }
  if (Math.abs(spanX - width) > 1 || Math.abs(spanY - depth) > 1) {
    issues.push(
      `the walls span ${snap(spanX)}×${snap(spanY)} ft, not the requested ${width}×${depth} ft`,
    );
  }

  const normalizedWalls = walls.map((wall, index) =>
    canonicalWall(
      `ai-wall-${index + 1}`,
      snap(wall.x1 - minX),
      snap(wall.y1 - minY),
      snap(wall.x2 - minX),
      snap(wall.y2 - minY),
      wall.thickness,
      wall.height,
    ),
  );
  const missingEdges = [
    !hasContinuousBoundary(normalizedWalls, "horizontal", 0, width) && "south",
    !hasContinuousBoundary(normalizedWalls, "horizontal", depth, width) && "north",
    !hasContinuousBoundary(normalizedWalls, "vertical", 0, depth) && "west",
    !hasContinuousBoundary(normalizedWalls, "vertical", width, depth) && "east",
  ].filter((edge): edge is string => Boolean(edge));
  if (missingEdges.length > 0) {
    issues.push(`the exterior perimeter is open on the ${missingEdges.join(", ")} edge(s)`);
  }
  const interiorWallCount = normalizedWalls.filter(
    (wall) => !exteriorWall(wall, { width, depth }),
  ).length;
  const bedrooms = requestedBedroomCount(request);
  const requiredInteriorWalls =
    bedrooms === null || bedrooms === 0 ? 0 : Math.max(1, bedrooms - 1);
  if (interiorWallCount < requiredInteriorWalls) {
    issues.push(
      `the request needs ${requiredInteriorWalls} or more interior partition wall(s), but only ${interiorWallCount} were returned`,
    );
  }
  if (issues.length > 0) {
    throw new Error(`Invalid wall layout: ${issues.join("; ")}.`);
  }
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim().slice(0, 80)
      : "AI Generated Floor Plan";
  return { name, dimensions: { width, depth }, walls: normalizedWalls };
}

function wallLength(wall: Wall) {
  return Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
}

function exteriorWall(wall: Wall, dimensions: WallDimensions) {
  return (
    (Math.abs(wall.y1 - wall.y2) < 0.1 &&
      (Math.abs(wall.y1) < 0.1 ||
        Math.abs(wall.y1 - dimensions.depth) < 0.1)) ||
    (Math.abs(wall.x1 - wall.x2) < 0.1 &&
      (Math.abs(wall.x1) < 0.1 ||
        Math.abs(wall.x1 - dimensions.width) < 0.1))
  );
}

function parseOpenings(text: string, plan: ParsedWalls): Opening[] {
  const value = parseJson(text, "the openings");
  if (!isRecord(value) || !Array.isArray(value.openings)) {
    throw new Error("The AI openings iteration must return an openings array.");
  }
  if (value.openings.length > 24) {
    throw new Error(
      `The AI returned ${value.openings.length} openings; the limit is 24.`,
    );
  }

  const openings: Opening[] = [];
  const occupied = new Map<number, Array<{ center: number; width: number }>>();
  value.openings.forEach((item, index) => {
    if (!isRecord(item)) throw new Error(`Opening ${index + 1} is not an object.`);
    const raw = item as RawOpening;
    const { wallIndex, type, position, width } = raw;
    if (
      !finiteNumber(wallIndex) ||
      !Number.isInteger(wallIndex) ||
      wallIndex < 0 ||
      wallIndex >= plan.walls.length ||
      (type !== "door" && type !== "window") ||
      !finiteNumber(position) ||
      !finiteNumber(width) ||
      position < 0.05 ||
      position > 0.95 ||
      width < 0.5 ||
      width > 12
    ) {
      throw new Error(`Opening ${index + 1} has invalid wall, type, or dimensions.`);
    }

    const wall = plan.walls[wallIndex];
    const length = wallLength(wall);
    const center = position * length;
    if (center - width / 2 < 0.05 || center + width / 2 > length - 0.05) {
      throw new Error(`Opening ${index + 1} does not fit on wall ${wallIndex}.`);
    }
    if (type === "window" && !exteriorWall(wall, plan.dimensions)) {
      throw new Error(`Window ${index + 1} is not on an exterior wall.`);
    }
    const existing = occupied.get(wallIndex) ?? [];
    if (
      existing.some(
        (other) => Math.abs(other.center - center) < (other.width + width) / 2 + 0.25,
      )
    ) {
      throw new Error(`Opening ${index + 1} overlaps another opening.`);
    }
    occupied.set(wallIndex, [...existing, { center, width }]);
    openings.push({
      id: `ai-opening-${index + 1}`,
      wallId: wall.id,
      type: type as OpeningType,
      positionOnWall: position,
      width,
    });
  });
  return openings;
}

function ensureExteriorOpenings(plan: ParsedWalls, openings: Opening[]) {
  const add = (
    wallIndex: number,
    type: OpeningType,
    width: number,
    position = 0.5,
  ) => {
    const wall = plan.walls[wallIndex];
    const length = wallLength(wall);
    const center = position * length;
    if (
      length < width + 0.1 ||
      center - width / 2 < 0.05 ||
      center + width / 2 > length - 0.05 ||
      openings.some((opening) => {
        if (opening.wallId !== wall.id) return false;
        const other = opening.positionOnWall * length;
        return Math.abs(other - center) < (opening.width + width) / 2 + 0.25;
      })
    ) {
      return false;
    }
    openings.push({
      id: `ai-opening-${openings.length + 1}`,
      wallId: wall.id,
      type,
      positionOnWall: position,
      width,
    });
    return true;
  };

  if (!openings.some((opening) => opening.type === "door" && exteriorWall(
    plan.walls.find((wall) => wall.id === opening.wallId)!,
    plan.dimensions,
  ))) {
    const entryIndex = plan.walls
      .map((wall, index) => ({ wall, index }))
      .filter(({ wall }) => exteriorWall(wall, plan.dimensions) && wallLength(wall) >= 3.5)
      .sort((a, b) => wallLength(b.wall) - wallLength(a.wall))[0]?.index;
    if (entryIndex === undefined || !add(entryIndex, "door", 3)) {
      throw new Error("No exterior wall is long enough for an entry door.");
    }
  }

  if (!openings.some((opening) => opening.type === "window")) {
    const candidates = plan.walls
      .map((wall, index) => ({ wall, index }))
      .filter(({ wall }) => exteriorWall(wall, plan.dimensions) && wallLength(wall) >= 4.5)
      .sort((a, b) => {
        const aUsed = openings.some((opening) => opening.wallId === a.wall.id);
        const bUsed = openings.some((opening) => opening.wallId === b.wall.id);
        return Number(aUsed) - Number(bUsed) || wallLength(b.wall) - wallLength(a.wall);
      });
    for (const { index } of candidates) {
      if (
        add(index, "window", 4, 0.5) ||
        add(index, "window", 4, 0.25) ||
        add(index, "window", 4, 0.75)
      ) {
        break;
      }
    }
  }
  return openings;
}

function parseFinalPlan(text: string, request: string): GeneratedFloorPlan {
  const value = parseJson(text, "the complete floor plan");
  if (!isRecord(value) || !Array.isArray(value.walls) || !Array.isArray(value.openings)) {
    throw new Error("The final AI JSON must contain walls and openings arrays.");
  }
  const wallsResponse = JSON.stringify({ name: value.name, walls: value.walls });
  const parsed = parseWalls(wallsResponse, request);
  const openingsResponse = JSON.stringify({ openings: value.openings });
  const openings = ensureExteriorOpenings(
    parsed,
    parseOpenings(openingsResponse, parsed),
  );
  return { name: parsed.name, walls: parsed.walls, openings };
}

function buildWallsPrompt(request: string) {
  return [
    "Iteration 1 of 2: generate the wall layout only. Return one JSON object matching the supplied schema.",
    "Use feet with origin (0,0) at the southwest; X goes east and Y north. Make a closed exterior perimeter and sensible connected, axis-aligned interior walls for the requested rooms. Use each wall once; do not include doors or windows in this iteration.",
    "Honor the user's overall dimensions. All wall coordinates must be between 0 and the requested footprint dimensions. Use practical 0.5 ft thickness and 8 ft height unless the user specifies otherwise.",
    `User request: ${request}`,
  ].join("\n");
}

function buildOpeningsPrompt(request: string, plan: ParsedWalls) {
  const wallList = plan.walls.map((wall, index) => {
    const role = exteriorWall(wall, plan.dimensions) ? "exterior" : "interior";
    return `W${index}: (${wall.x1},${wall.y1})-(${wall.x2},${wall.y2}), ${wallLength(wall).toFixed(1)} ft, ${role}`;
  });
  return [
    "Iteration 2 of 2: add doors and windows to the already validated walls. Do not change or repeat the walls.",
    "Return only JSON with an openings array. Each opening uses a zero-based wallIndex from the list, type door/window, position 0.05–0.95 along the wall, and width in feet.",
    "Add an exterior entry door, interior doors for room access, and windows only on exterior walls. Keep openings at least 0.25 ft from wall ends and do not overlap them. Use at most 24 openings.",
    `User request: ${request}`,
    `Validated footprint: ${plan.dimensions.width}×${plan.dimensions.depth} ft.`,
    "Wall index list:",
    wallList.join("\n"),
  ].join("\n");
}

async function generateValidated<T>(
  prompt: string,
  schema: unknown,
  parse: (text: string) => T,
  options: StreamOptions,
  stage: string,
): Promise<T> {
  const response = await generateLocalJson(prompt, options, schema);
  try {
    return parse(response);
  } catch (firstError) {
    if (options.signal?.aborted) throw firstError;
    const reason =
      firstError instanceof Error ? firstError.message : "invalid JSON";
    options.onChunk?.(`\n\n[Correcting the ${stage} iteration…]\n`);
    const corrected = await generateLocalJson(
      [
        prompt,
        "",
        `Validation errors to fix: ${reason}`,
        `Regenerate the ${stage} JSON from scratch. Do not copy the invalid response.`,
        stage === "wall layout"
          ? "Return the exact requested footprint, one connected closed exterior perimeter, no duplicate/reversed walls, no zero-length or diagonal walls, and the requested interior partitions."
          : "Use only the supplied wall indices. Keep openings away from endpoints, avoid overlaps, and place windows only on exterior walls.",
        "Follow the schema exactly and return one JSON object only.",
      ].join("\n"),
      options,
      schema,
    );
    try {
      return parse(corrected);
    } catch (retryError) {
      const retryReason =
        retryError instanceof Error ? retryError.message : "invalid JSON";
      throw new Error(
        `The AI ${stage} is still invalid after one correction attempt. ${retryReason}`,
      );
    }
  }
}

export function parseGeneratedFloorPlan(
  text: string,
  request = "",
): GeneratedFloorPlan {
  return parseFinalPlan(text, request);
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

  const baseOptions: StreamOptions = {
    ...options,
    numContext: options.numContext ?? 8192,
    timeoutMs: options.timeoutMs ?? 300_000,
  };
  const roomOptions: StreamOptions = {
    ...baseOptions,
    numPredict: options.numPredict ?? 1800,
    operation: "floorplan-generation-walls",
  };
  const parsedWalls = await generateValidated(
    buildWallsPrompt(trimmedRequest),
    WALLS_SCHEMA,
    (text) => parseWalls(text, trimmedRequest),
    roomOptions,
    "wall layout",
  );

  options.onChunk?.("\n\n[Walls validated. Iteration 2/2: generating openings…]\n");
  const openingOptions: StreamOptions = {
    ...baseOptions,
    numPredict: options.numPredict ? Math.min(options.numPredict, 768) : 768,
    operation: "floorplan-generation-openings",
  };
  const openingResponse = await generateValidated(
    buildOpeningsPrompt(trimmedRequest, parsedWalls),
    OPENINGS_SCHEMA,
    (text) => parseOpenings(text, parsedWalls),
    openingOptions,
    "openings",
  );
  const openings = ensureExteriorOpenings(parsedWalls, openingResponse);
  return {
    name: parsedWalls.name,
    walls: parsedWalls.walls,
    openings,
  };
}
