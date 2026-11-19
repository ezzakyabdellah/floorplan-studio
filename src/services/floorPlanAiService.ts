import type { Opening, OpeningType, Wall } from "../types/floorplan";
import { generateLocalJson, type StreamOptions } from "./localAiService";

export type GeneratedFloorPlan = {
  name: string;
  walls: Wall[];
  openings: Opening[];
};

type RawRoom = {
  name?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  depth?: unknown;
  openTo?: unknown;
};

type RawOpening = {
  room?: unknown;
  side?: unknown;
  type?: unknown;
  position?: unknown;
  width?: unknown;
};

type Room = {
  name: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  openTo: string[];
};

type WallLine = {
  axis: "horizontal" | "vertical";
  coordinate: number;
  start: number;
  end: number;
};

const FLOOR_PLAN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    width: { type: "number" },
    depth: { type: "number" },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          depth: { type: "number" },
          openTo: { type: "array", items: { type: "string" } },
        },
        required: ["name", "x", "y", "width", "depth", "openTo"],
        additionalProperties: false,
      },
    },
    openings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          room: { type: "string" },
          side: { type: "string", enum: ["north", "east", "south", "west"] },
          type: { type: "string", enum: ["door", "window"] },
          position: { type: "number" },
          width: { type: "number" },
        },
        required: ["room", "side", "type", "position", "width"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "width", "depth", "rooms", "openings"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function snap(value: number) {
  return Math.round(value * 2) / 2;
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new Error("The local model returned invalid JSON for the floor plan.");
  }
}

function explicitDimensions(request: string) {
  const match = request.match(
    /(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')?/i,
  );
  return match ? { width: Number(match[1]), depth: Number(match[2]) } : null;
}

function explicitRoomCount(request: string, kind: "bedroom" | "bathroom") {
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  const pattern =
    kind === "bedroom"
      ? /\b(\d+|one|two|three|four|five|six)\s*[- ]?\s*bedrooms?\b/i
      : /\b(\d+|one|two|three|four|five|six)\s*[- ]?\s*bathrooms?\b/i;
  const match = request.match(pattern);
  if (!match) return null;
  return Number.isFinite(Number(match[1]))
    ? Number(match[1])
    : words[match[1].toLowerCase()] ?? null;
}

function sideLine(room: Room, side: string): WallLine {
  switch (side) {
    case "north":
      return {
        axis: "horizontal",
        coordinate: room.y + room.depth,
        start: room.x,
        end: room.x + room.width,
      };
    case "south":
      return {
        axis: "horizontal",
        coordinate: room.y,
        start: room.x,
        end: room.x + room.width,
      };
    case "east":
      return {
        axis: "vertical",
        coordinate: room.x + room.width,
        start: room.y,
        end: room.y + room.depth,
      };
    default:
      return {
        axis: "vertical",
        coordinate: room.x,
        start: room.y,
        end: room.y + room.depth,
      };
  }
}

function rectEdges(room: Room): WallLine[] {
  return (["north", "east", "south", "west"] as const).map((side) =>
    sideLine(room, side),
  );
}

function roomOpenTo(room: Room, otherName: string) {
  return room.openTo.some(
    (name) => name.toLocaleLowerCase() === otherName.toLocaleLowerCase(),
  );
}

function validateRooms(rooms: Room[], width: number, depth: number) {
  if (rooms.length === 0 || rooms.length > 16) {
    throw new Error("The plan must contain between 1 and 16 rooms.");
  }
  const names = new Set<string>();
  for (const room of rooms) {
    if (!room.name) throw new Error("Every room needs a name.");
    const key = room.name.toLocaleLowerCase();
    if (names.has(key)) throw new Error(`Duplicate room name: ${room.name}.`);
    names.add(key);
    if (
      room.x < 0 ||
      room.y < 0 ||
      room.width < 4 ||
      room.depth < 4 ||
      room.x + room.width > width + 0.1 ||
      room.y + room.depth > depth + 0.1
    ) {
      throw new Error(`${room.name} does not fit inside the overall floor plan.`);
    }
    if (
      room.openTo.some(
        (name) =>
          name.toLocaleLowerCase() === key ||
          !rooms.some(
            (candidate) =>
              candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          ),
      )
    ) {
      throw new Error(`${room.name} has an invalid open-plan connection.`);
    }
  }

  for (let left = 0; left < rooms.length; left += 1) {
    for (let right = left + 1; right < rooms.length; right += 1) {
      const a = rooms[left];
      const b = rooms[right];
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.depth, b.y + b.depth) - Math.max(a.y, b.y);
      if (overlapX > 0.1 && overlapY > 0.1) {
        throw new Error(`${a.name} and ${b.name} overlap.`);
      }
    }
  }

  if (rooms.length > 1) {
    const connected = new Set([0]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const index of [...connected]) {
        const room = rooms[index];
        rooms.forEach((candidate, candidateIndex) => {
          if (connected.has(candidateIndex)) return;
          const shareVertical =
            (Math.abs(room.x + room.width - candidate.x) < 0.1 ||
              Math.abs(candidate.x + candidate.width - room.x) < 0.1) &&
            Math.min(room.y + room.depth, candidate.y + candidate.depth) -
              Math.max(room.y, candidate.y) >
              0.1;
          const shareHorizontal =
            (Math.abs(room.y + room.depth - candidate.y) < 0.1 ||
              Math.abs(candidate.y + candidate.depth - room.y) < 0.1) &&
            Math.min(room.x + room.width, candidate.x + candidate.width) -
              Math.max(room.x, candidate.x) >
              0.1;
          if (shareVertical || shareHorizontal) {
            connected.add(candidateIndex);
            changed = true;
          }
        });
      }
    }
    if (connected.size !== rooms.length) {
      throw new Error("Rooms must share walls to form a connected floor plan.");
    }
  }

  for (const room of rooms) {
    for (const targetName of room.openTo) {
      const target = rooms.find(
        (candidate) =>
          candidate.name.toLocaleLowerCase() === targetName.toLocaleLowerCase(),
      )!;
      const shareVertical =
        (Math.abs(room.x + room.width - target.x) < 0.1 ||
          Math.abs(target.x + target.width - room.x) < 0.1) &&
        Math.min(room.y + room.depth, target.y + target.depth) -
          Math.max(room.y, target.y) >
          0.1;
      const shareHorizontal =
        (Math.abs(room.y + room.depth - target.y) < 0.1 ||
          Math.abs(target.y + target.depth - room.y) < 0.1) &&
        Math.min(room.x + room.width, target.x + target.width) -
          Math.max(room.x, target.x) >
          0.1;
      if (!shareVertical && !shareHorizontal) {
        throw new Error(`${room.name} and ${target.name} are not adjacent.`);
      }
    }
  }
}

function splitWallLines(lines: WallLine[]): WallLine[] {
  const groups = new Map<string, WallLine[]>();
  for (const line of lines) {
    const key = `${line.axis}:${line.coordinate.toFixed(2)}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }

  const result: WallLine[] = [];
  for (const group of groups.values()) {
    const points = [...new Set(group.flatMap((line) => [line.start, line.end]))]
      .sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const midpoint = (start + end) / 2;
      if (end - start < 0.1 || !group.some((line) => midpoint >= line.start && midpoint <= line.end)) {
        continue;
      }
      result.push({
        axis: group[0].axis,
        coordinate: group[0].coordinate,
        start,
        end,
      });
    }
  }
  return result;
}

function isOpenConnection(line: WallLine, rooms: Room[]) {
  const midpoint = (line.start + line.end) / 2;
  const touching = rooms.flatMap((room) =>
    rectEdges(room)
      .filter(
        (edge) =>
          edge.axis === line.axis &&
          Math.abs(edge.coordinate - line.coordinate) < 0.1 &&
          midpoint > edge.start - 0.1 &&
          midpoint < edge.end + 0.1,
      )
      .map(() => room),
  );
  for (let left = 0; left < touching.length; left += 1) {
    for (let right = left + 1; right < touching.length; right += 1) {
      if (
        roomOpenTo(touching[left], touching[right].name) ||
        roomOpenTo(touching[right], touching[left].name)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isExteriorWall(
  line: WallLine,
  width: number,
  depth: number,
  side: string,
) {
  if (side === "north") return line.axis === "horizontal" && Math.abs(line.coordinate - depth) < 0.1;
  if (side === "south") return line.axis === "horizontal" && Math.abs(line.coordinate) < 0.1;
  if (side === "east") return line.axis === "vertical" && Math.abs(line.coordinate - width) < 0.1;
  return line.axis === "vertical" && Math.abs(line.coordinate) < 0.1;
}

/** Validate room-level geometry, then derive unique wall segments locally. */
export function parseGeneratedFloorPlan(
  text: string,
  request = "",
): GeneratedFloorPlan {
  const decoded = parseResponse(text);
  if (
    !isRecord(decoded) ||
    !Array.isArray(decoded.rooms) ||
    !Array.isArray(decoded.openings)
  ) {
    throw new Error("The AI response must include room and opening arrays.");
  }
  if (decoded.rooms.length === 0 || decoded.rooms.length > 16 || decoded.openings.length > 64) {
    throw new Error("The AI plan has an unsupported number of rooms or openings.");
  }
  const widthValue = decoded.width;
  const depthValue = decoded.depth;
  if (
    !finiteNumber(widthValue) ||
    !finiteNumber(depthValue) ||
    widthValue < 8 ||
    depthValue < 8 ||
    widthValue > 100 ||
    depthValue > 100
  ) {
    throw new Error("The AI response must include overall width and depth.");
  }
  const requested = explicitDimensions(request);
  const width = snap(requested?.width ?? widthValue);
  const depth = snap(requested?.depth ?? depthValue);
  if (width < 8 || depth < 8 || width > 100 || depth > 100) {
    throw new Error("Use floor-plan dimensions between 8 and 100 feet.");
  }
  const scaleX = width / widthValue;
  const scaleY = depth / depthValue;

  const rooms: Room[] = decoded.rooms.map((rawRoom, index) => {
    if (!isRecord(rawRoom)) {
      throw new Error(`Room ${index + 1} is not a valid object.`);
    }
    const room = rawRoom as RawRoom;
    if (
      typeof room.name !== "string" ||
      ![room.x, room.y, room.width, room.depth].every(finiteNumber) ||
      (room.openTo !== undefined &&
        (!Array.isArray(room.openTo) ||
          !room.openTo.every((name) => typeof name === "string")))
    ) {
      throw new Error(`Room ${index + 1} has incomplete geometry.`);
    }
    return {
      name: room.name.trim().slice(0, 40),
      x: snap((room.x as number) * scaleX),
      y: snap((room.y as number) * scaleY),
      width: snap((room.width as number) * scaleX),
      depth: snap((room.depth as number) * scaleY),
      openTo: (room.openTo as string[] | undefined) ?? [],
    };
  });
  validateRooms(rooms, width, depth);
  for (const kind of ["bedroom", "bathroom"] as const) {
    const requestedCount = explicitRoomCount(request, kind);
    if (requestedCount === null) continue;
    const pattern = kind === "bedroom" ? /bedroom/i : /bathroom/i;
    const actualCount = rooms.filter((room) => pattern.test(room.name)).length;
    if (actualCount !== requestedCount) {
      throw new Error(
        `The AI returned ${actualCount} ${kind}${actualCount === 1 ? "" : "s"} but your prompt asks for ${requestedCount}. Try again with a simpler description.`,
      );
    }
  }

  const name =
    typeof decoded.name === "string" && decoded.name.trim()
      ? decoded.name.trim().slice(0, 80)
      : "AI Generated Floor Plan";

  const lines: WallLine[] = [
    { axis: "horizontal", coordinate: 0, start: 0, end: width },
    { axis: "horizontal", coordinate: depth, start: 0, end: width },
    { axis: "vertical", coordinate: 0, start: 0, end: depth },
    { axis: "vertical", coordinate: width, start: 0, end: depth },
    ...rooms.flatMap(rectEdges),
  ];
  const wallLines = splitWallLines(lines).filter(
    (line) => !isOpenConnection(line, rooms),
  );
  const walls: Wall[] = wallLines.map((line, index) => ({
    id: `ai-wall-${index + 1}`,
    x1: line.axis === "horizontal" ? line.start : line.coordinate,
    y1: line.axis === "horizontal" ? line.coordinate : line.start,
    x2: line.axis === "horizontal" ? line.end : line.coordinate,
    y2: line.axis === "horizontal" ? line.coordinate : line.end,
    thickness: 0.5,
    height: 8,
  }));
  const openings: Opening[] = [];
  const openingRanges = new Map<string, Array<{ center: number; width: number }>>();

  const addOpening = (
    line: WallLine,
    type: OpeningType,
    center: number,
    openingWidth: number,
  ) => {
    const wall = walls.find((candidate) => {
      const wallLine =
        Math.abs(candidate.y1 - candidate.y2) < 0.1
          ? {
              axis: "horizontal" as const,
              coordinate: candidate.y1,
              start: Math.min(candidate.x1, candidate.x2),
              end: Math.max(candidate.x1, candidate.x2),
            }
          : {
              axis: "vertical" as const,
              coordinate: candidate.x1,
              start: Math.min(candidate.y1, candidate.y2),
              end: Math.max(candidate.y1, candidate.y2),
            };
      return (
        wallLine.axis === line.axis &&
        Math.abs(wallLine.coordinate - line.coordinate) < 0.1 &&
        center - openingWidth / 2 >= wallLine.start + 0.05 &&
        center + openingWidth / 2 <= wallLine.end - 0.05
      );
    });
    if (!wall) throw new Error("An opening does not fit on its selected room wall.");
    const start = line.axis === "horizontal" ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2);
    const wallLength = line.axis === "horizontal"
      ? Math.abs(wall.x2 - wall.x1)
      : Math.abs(wall.y2 - wall.y1);
    const positionOnWall = (center - start) / wallLength;
    const existing = openingRanges.get(wall.id) ?? [];
    if (
      existing.some(
        (opening) =>
          Math.abs(opening.center - center) <
          (opening.width + openingWidth) / 2 + 0.25,
      )
    ) {
      throw new Error("The AI placed overlapping openings.");
    }
    openingRanges.set(wall.id, [...existing, { center, width: openingWidth }]);
    openings.push({
      id: `ai-opening-${openings.length + 1}`,
      wallId: wall.id,
      type,
      positionOnWall,
      width: openingWidth,
    });
  };

  for (const [index, rawOpening] of decoded.openings.entries()) {
    if (!isRecord(rawOpening)) {
      throw new Error(`Opening ${index + 1} is not a valid object.`);
    }
    const opening = rawOpening as RawOpening;
    if (
      typeof opening.room !== "string" ||
      typeof opening.side !== "string" ||
      !["north", "east", "south", "west"].includes(opening.side) ||
      (opening.type !== "door" && opening.type !== "window") ||
      !finiteNumber(opening.position) ||
      !finiteNumber(opening.width) ||
      opening.position < 0.05 ||
      opening.position > 0.95 ||
      opening.width < 0.5 ||
      opening.width > 12
    ) {
      throw new Error(`Opening ${index + 1} has invalid type, location, or width.`);
    }
    const roomName = opening.room;
    const room = rooms.find(
      (candidate) =>
        candidate.name.toLocaleLowerCase() === roomName.toLocaleLowerCase(),
    );
    if (!room) throw new Error(`Opening ${index + 1} references an unknown room.`);
    const side = opening.side as "north" | "east" | "south" | "west";
    const line = sideLine(room, side);
    const onExterior = isExteriorWall(line, width, depth, side);
    const oppositeSide: Record<string, string> = {
      north: "south",
      east: "west",
      south: "north",
      west: "east",
    };
    const bordersAnotherRoom = rooms.some((candidate) => {
      if (candidate.name === room.name) return false;
      const sharedLine = sideLine(candidate, oppositeSide[side]);
      return (
        Math.abs(sharedLine.coordinate - line.coordinate) < 0.1 &&
        Math.min(sharedLine.end, line.end) - Math.max(sharedLine.start, line.start) >
          0.1
      );
    });
    if (
      opening.type === "window" &&
      !onExterior
    ) {
      throw new Error("Windows must be placed on exterior room walls.");
    }
    if (opening.type === "door" && !onExterior && !bordersAnotherRoom) {
      throw new Error("Interior doors must connect adjacent rooms.");
    }
    const center = line.start + (line.end - line.start) * opening.position;
    addOpening(line, opening.type, center, opening.width);
  }

  // Guarantee an entry and natural light if the model omitted them.
  const hasExteriorDoor = openings.some((opening) => {
    const wall = walls.find((candidate) => candidate.id === opening.wallId)!;
    return (
      opening.type === "door" &&
      (Math.abs(wall.y1) < 0.1 && Math.abs(wall.y2) < 0.1 ||
        Math.abs(wall.x1) < 0.1 && Math.abs(wall.x2) < 0.1 ||
        Math.abs(wall.x1 - width) < 0.1 && Math.abs(wall.x2 - width) < 0.1 ||
        Math.abs(wall.y1 - depth) < 0.1 && Math.abs(wall.y2 - depth) < 0.1)
    );
  });
  if (!hasExteriorDoor) {
    const southWalls = walls
      .filter((wall) => Math.abs(wall.y1) < 0.1 && Math.abs(wall.y2) < 0.1)
      .sort((a, b) => Math.abs(b.x2 - b.x1) - Math.abs(a.x2 - a.x1));
    const wall = southWalls[0];
    if (!wall || Math.abs(wall.x2 - wall.x1) < 3.5) {
      throw new Error("Could not place an entry door on the exterior boundary.");
    }
    addOpening(
      { axis: "horizontal", coordinate: 0, start: 0, end: width },
      "door",
      (Math.min(wall.x1, wall.x2) + Math.max(wall.x1, wall.x2)) / 2,
      3,
    );
  }
  const hasWindow = openings.some((opening) => opening.type === "window");
  if (!hasWindow) {
    const exteriorWalls = walls
      .filter((wall) => Math.abs(wall.y1 - wall.y2) < 0.1 && Math.abs(wall.y1 - depth) < 0.1)
      .sort((a, b) => Math.abs(b.x2 - b.x1) - Math.abs(a.x2 - a.x1));
    const wall = exteriorWalls[0];
    if (wall && Math.abs(wall.x2 - wall.x1) >= 4.5) {
      addOpening(
        { axis: "horizontal", coordinate: depth, start: 0, end: width },
        "window",
        (Math.min(wall.x1, wall.x2) + Math.max(wall.x1, wall.x2)) / 2,
        4,
      );
    }
  }

  return { name, walls, openings };
}

function buildPrompt(request: string) {
  return [
    "Design a practical floor plan and return only the requested JSON.",
    "Use feet, origin (0,0) at the southwest corner, X east and Y north. Define each room as a non-overlapping rectangle inside the overall footprint; coordinate rooms so they share walls and form a sensible connected layout.",
    "Prioritize the user's exact room count and dimensions. Keep bedrooms private, group kitchen/dining/living as requested, and provide doors between connected rooms. Use openTo for open-plan spaces. Add an exterior entry door and windows on exterior walls. Do not invent extra rooms.",
    "Room x/y is its southwest corner; width extends east and depth north. Opening position is 0–1 along the named room side. All opening widths are feet. Keep rooms at least 4 ft wide/deep and the overall footprint between 8 and 100 ft.",
    `User request: ${request.trim()}`,
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
      timeoutMs: options.timeoutMs ?? 300_000,
      operation: options.operation ?? "floorplan-generation",
    },
    FLOOR_PLAN_SCHEMA,
  );
  return parseGeneratedFloorPlan(response, trimmedRequest);
}
