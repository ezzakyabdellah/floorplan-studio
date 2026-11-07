import type {
  Furniture,
  FurnitureKind,
  FurnitureSource,
  Opening,
  Wall,
} from "../types/floorplan";
import { distanceToSegment, getSceneBounds, pointAtDistance } from "../utils/geometry";

export type RoomGuess = {
  id: number;
  label: string;
  kind: "bedroom" | "living" | "office" | "dining" | "circulation";
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
  area: number;
  confidence: number;
  doorCount: number;
};

export type FurniturePlan = {
  rooms: RoomGuess[];
  furniture: Furniture[];
  cellSize: number;
};

type RoomBounds = Pick<RoomGuess, "minX" | "minY" | "maxX" | "maxY">;

type FloorGrid = {
  originX: number;
  originY: number;
  cellSize: number;
  columns: number;
  rows: number;
  roomAt: Int32Array;
};

type DetectedRoom = RoomGuess & { cellCount: number };
type DoorTarget = { x: number; y: number; width: number };

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function pointToRectDistance(
  x: number,
  y: number,
  rect: RoomBounds,
) {
  const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
  const dy = Math.max(rect.minY - y, 0, y - rect.maxY);
  return Math.hypot(dx, dy);
}

function getDoorTargets(walls: Wall[], openings: Opening[]): DoorTarget[] {
  return openings
    .filter((opening) => opening.type === "door")
    .flatMap((opening) => {
      const wall = walls.find((candidate) => candidate.id === opening.wallId);
      return wall
        ? [
            {
              ...pointAtDistance(
                wall,
                opening.positionOnWall * Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1),
              ),
              width: opening.width,
            },
          ]
        : [];
    });
}

function rasterizeRooms(walls: Wall[], openings: Opening[]) {
  const bounds = getSceneBounds(walls);
  const cellSize = clamp(Math.max(bounds.width, bounds.height) / 280, 0.18, 0.5);
  const padding = Math.max(2, cellSize * 5);
  const originX = bounds.minX - padding;
  const originY = bounds.minY - padding;
  const columns = Math.ceil((bounds.width + padding * 2) / cellSize);
  const rows = Math.ceil((bounds.height + padding * 2) / cellSize);
  const size = columns * rows;
  const blocked = new Uint8Array(size);
  const visited = new Uint8Array(size);
  const roomAt = new Int32Array(size);
  roomAt.fill(-1);

  for (const wall of walls) {
    const radius = Math.max(0.06, wall.thickness / 2 + cellSize * 0.62);
    const minX = Math.min(wall.x1, wall.x2) - radius;
    const maxX = Math.max(wall.x1, wall.x2) + radius;
    const minY = Math.min(wall.y1, wall.y2) - radius;
    const maxY = Math.max(wall.y1, wall.y2) + radius;
    const startX = clamp(Math.floor((minX - originX) / cellSize), 0, columns - 1);
    const endX = clamp(Math.ceil((maxX - originX) / cellSize), 0, columns - 1);
    const startY = clamp(Math.floor((minY - originY) / cellSize), 0, rows - 1);
    const endY = clamp(Math.ceil((maxY - originY) / cellSize), 0, rows - 1);

    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const center = {
          x: originX + (x + 0.5) * cellSize,
          y: originY + (y + 0.5) * cellSize,
        };
        if (distanceToSegment(center, wall) <= radius) {
          blocked[y * columns + x] = 1;
        }
      }
    }
  }

  const doorPoints = getDoorTargets(walls, openings);

  const minimumArea = Math.max(12, bounds.width * bounds.height * 0.0035);
  const queue = new Int32Array(size);
  const rooms: DetectedRoom[] = [];

  for (let seed = 0; seed < size; seed += 1) {
    if (blocked[seed] || visited[seed]) continue;

    let head = 0;
    let tail = 0;
    let minCellX = columns;
    let maxCellX = -1;
    let minCellY = rows;
    let maxCellY = -1;
    let touchesGridEdge = false;
    queue[tail] = seed;
    tail += 1;
    visited[seed] = 1;

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % columns;
      const y = Math.floor(index / columns);
      minCellX = Math.min(minCellX, x);
      maxCellX = Math.max(maxCellX, x);
      minCellY = Math.min(minCellY, y);
      maxCellY = Math.max(maxCellY, y);
      if (x === 0 || y === 0 || x === columns - 1 || y === rows - 1) {
        touchesGridEdge = true;
      }

      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const next = ny * columns + nx;
        if (blocked[next] || visited[next]) continue;
        visited[next] = 1;
        queue[tail] = next;
        tail += 1;
      }
    }

    const area = tail * cellSize * cellSize;
    if (touchesGridEdge || area < minimumArea) continue;

    const minX = originX + minCellX * cellSize;
    const maxX = originX + (maxCellX + 1) * cellSize;
    const minY = originY + minCellY * cellSize;
    const maxY = originY + (maxCellY + 1) * cellSize;
    const width = maxX - minX;
    const height = maxY - minY;
    if (width < 1.2 || height < 1.2) continue;
    if (area / Math.max(0.01, width * height) < 0.28) continue;

    const roomId = rooms.length;
    for (let index = 0; index < tail; index += 1) {
      roomAt[queue[index]] = roomId;
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const doorCount = doorPoints.filter(
      (point) => pointToRectDistance(point.x, point.y, { minX, minY, maxX, maxY }) <= 3.5,
    ).length;

    rooms.push({
      id: roomId,
      label: "Room",
      kind: "office",
      minX,
      minY,
      maxX,
      maxY,
      centerX,
      centerY,
      area,
      confidence: 0.55,
      doorCount,
      cellCount: tail,
    });
  }

  return {
    bounds,
    grid: { originX, originY, cellSize, columns, rows, roomAt } satisfies FloorGrid,
    rooms,
  };
}

function classifyRooms(rooms: DetectedRoom[], scene: ReturnType<typeof getSceneBounds>) {
  const largestArea = Math.max(1, ...rooms.map((room) => room.area));
  const labelCounts = new Map<RoomGuess["kind"], number>();

  return rooms.map((room) => {
    const centerXRatio = (room.centerX - scene.minX) / scene.width;
    const centerYRatio = (room.centerY - scene.minY) / scene.height;
    const roomWidth = room.maxX - room.minX;
    const roomDepth = room.maxY - room.minY;
    const aspect = Math.max(roomWidth, roomDepth) / Math.max(0.01, Math.min(roomWidth, roomDepth));

    let kind: RoomGuess["kind"];
    let confidence = 0.66;
    if (room.doorCount >= 3 || aspect >= 2.8) {
      kind = "circulation";
      confidence = 0.82;
    } else if (centerYRatio < 0.46) {
      kind = "bedroom";
      confidence = 0.8;
    } else if (centerXRatio > 0.56 && room.area >= largestArea * 0.45) {
      kind = "living";
      confidence = 0.76;
    } else if (centerXRatio < 0.5 && centerYRatio >= 0.46) {
      kind = room.area >= largestArea * 0.42 ? "bedroom" : "office";
      confidence = kind === "bedroom" ? 0.68 : 0.61;
    } else if (room.area >= largestArea * 0.62 && aspect < 2.2) {
      kind = "dining";
      confidence = 0.64;
    } else {
      kind = "bedroom";
      confidence = 0.58;
    }

    const sameKindBefore = labelCounts.get(kind) ?? 0;
    labelCounts.set(kind, sameKindBefore + 1);
    const labels: Record<RoomGuess["kind"], string> = {
      bedroom: `Bedroom ${sameKindBefore + 1}`,
      living: "Living room",
      office: "Study",
      dining: "Dining room",
      circulation: "Hallway",
    };

    return { ...room, kind, confidence, label: labels[kind] };
  });
}

function footprintFitsRoom(
  room: RoomGuess,
  grid: FloorGrid,
  x: number,
  y: number,
  width: number,
  depth: number,
  rotation: number,
) {
  const rotated = Math.abs(Math.sin(rotation)) > 0.5;
  const halfWidth = (rotated ? depth : width) / 2;
  const halfDepth = (rotated ? width : depth) / 2;
  const clearance = grid.cellSize * 0.4;
  if (
    x - halfWidth < room.minX + clearance ||
    x + halfWidth > room.maxX - clearance ||
    y - halfDepth < room.minY + clearance ||
    y + halfDepth > room.maxY - clearance
  ) {
    return false;
  }

  const sampleStep = Math.max(grid.cellSize * 2, Math.min(1.25, Math.min(width, depth) / 3));
  for (let sampleY = y - halfDepth + clearance; sampleY <= y + halfDepth - clearance; sampleY += sampleStep) {
    for (let sampleX = x - halfWidth + clearance; sampleX <= x + halfWidth - clearance; sampleX += sampleStep) {
      const cellX = Math.floor((sampleX - grid.originX) / grid.cellSize);
      const cellY = Math.floor((sampleY - grid.originY) / grid.cellSize);
      if (
        cellX < 0 ||
        cellY < 0 ||
        cellX >= grid.columns ||
        cellY >= grid.rows ||
        grid.roomAt[cellY * grid.columns + cellX] !== room.id
      ) {
        return false;
      }
    }
  }

  return true;
}

function overlapsFurniture(
  x: number,
  y: number,
  width: number,
  depth: number,
  rotation: number,
  placed: Furniture[],
) {
  const rotated = Math.abs(Math.sin(rotation)) > 0.5;
  const halfWidth = (rotated ? depth : width) / 2;
  const halfDepth = (rotated ? width : depth) / 2;
  return placed.some((item) => {
    const otherRotated = Math.abs(Math.sin(item.rotation)) > 0.5;
    const otherHalfWidth = (otherRotated ? item.depth : item.width) / 2;
    const otherHalfDepth = (otherRotated ? item.width : item.depth) / 2;
    return (
      Math.abs(x - item.x) < halfWidth + otherHalfWidth + 0.25 &&
      Math.abs(y - item.y) < halfDepth + otherHalfDepth + 0.25
    );
  });
}

function blocksDoorApproach(
  x: number,
  y: number,
  width: number,
  depth: number,
  rotation: number,
  doorTargets: DoorTarget[],
) {
  const rotated = Math.abs(Math.sin(rotation)) > 0.5;
  const halfWidth = (rotated ? depth : width) / 2;
  const halfDepth = (rotated ? width : depth) / 2;
  return doorTargets.some((door) => {
    const dx = Math.max(Math.abs(door.x - x) - halfWidth, 0);
    const dy = Math.max(Math.abs(door.y - y) - halfDepth, 0);
    return Math.hypot(dx, dy) < door.width / 2 + 0.8;
  });
}

function suggestedFurniture(
  rooms: RoomGuess[],
  grid: FloorGrid,
  openings: Opening[],
  walls: Wall[],
): Furniture[] {
  const doorTargets = getDoorTargets(walls, openings);
  const placements: Furniture[] = [];
  let sequence = 0;

  const place = (
    room: RoomGuess,
    kind: FurnitureKind,
    widthRatio: number,
    depthRatio: number,
    height: number,
    preferred?: { x: number; y: number },
  ) => {
    const roomWidth = room.maxX - room.minX;
    const roomDepth = room.maxY - room.minY;
    const width = Math.max(0.65, roomWidth * widthRatio);
    const depth = Math.max(0.65, roomDepth * depthRatio);
    const rotations = [0, Math.PI / 2];
    const anchors = preferred
      ? [
          preferred,
          { x: preferred.x - roomWidth * 0.18, y: preferred.y },
          { x: preferred.x + roomWidth * 0.18, y: preferred.y },
          { x: preferred.x, y: preferred.y - roomDepth * 0.2 },
          { x: preferred.x, y: preferred.y + roomDepth * 0.2 },
          { x: room.centerX, y: room.centerY },
        ]
      : [
          { x: room.centerX, y: room.centerY },
          { x: room.minX + roomWidth * 0.38, y: room.centerY },
          { x: room.minX + roomWidth * 0.62, y: room.centerY },
          { x: room.centerX, y: room.minY + roomDepth * 0.38 },
          { x: room.centerX, y: room.minY + roomDepth * 0.62 },
        ];
    let best: { x: number; y: number; rotation: number; score: number } | null = null;

    for (const anchor of anchors) {
      for (const rotation of rotations) {
        const xs = preferred
          ? [anchor.x]
          : [anchor.x, anchor.x - roomWidth * 0.08, anchor.x + roomWidth * 0.08];
        const ys = preferred
          ? [anchor.y]
          : [anchor.y, anchor.y - roomDepth * 0.08, anchor.y + roomDepth * 0.08];

        for (const x of xs) {
          for (const y of ys) {
            if (!footprintFitsRoom(room, grid, x, y, width, depth, rotation)) continue;
            const placedInRoom = placements.filter((item) => item.roomLabel === room.label);
            if (overlapsFurniture(x, y, width, depth, rotation, placedInRoom)) continue;
            if (blocksDoorApproach(x, y, width, depth, rotation, doorTargets)) continue;

            const nearestDoor = doorTargets.reduce(
              (nearest, door) => Math.min(nearest, Math.hypot(door.x - x, door.y - y)),
              Number.POSITIVE_INFINITY,
            );
            const centerPenalty = Math.hypot(x - room.centerX, y - room.centerY);
            const score = Math.min(nearestDoor, Math.max(roomWidth, roomDepth)) - centerPenalty * 0.12;
            if (!best || score > best.score) best = { x, y, rotation, score };
          }
        }
      }
    }

    if (!best) return null;
    const item: Furniture = {
      id: `ai-furniture-${room.id}-${sequence++}`,
      roomId: room.id,
      kind,
      source: "geometry",
      roomLabel: room.label,
      x: best.x,
      y: best.y,
      width,
      depth,
      height,
      rotation: best.rotation,
      confidence: room.confidence,
    };
    placements.push(item);
    return item;
  };

  for (const room of rooms) {
    if (room.kind === "circulation") continue;
    const width = room.maxX - room.minX;
    const depth = room.maxY - room.minY;

    if (room.kind === "bedroom") {
      const bed = place(room, "bed", 0.43, 0.54, 0.9);
      if (bed) {
        const rotated = Math.abs(Math.sin(bed.rotation)) > 0.5;
        const bedWidth = rotated ? bed.depth : bed.width;
        const bedDepth = rotated ? bed.width : bed.depth;
        const nightstandWidth = Math.max(0.65, width * 0.12);
        const nightstandDepth = Math.max(0.65, depth * 0.12);
        place(
          room,
          "nightstand",
          nightstandWidth / width,
          nightstandDepth / depth,
          1.8,
          {
            x: bed.x - bedWidth / 2 - nightstandWidth / 2 - 0.35,
            y: bed.y - bedDepth * 0.24,
          },
        );
        place(
          room,
          "nightstand",
          nightstandWidth / width,
          nightstandDepth / depth,
          1.8,
          {
            x: bed.x + bedWidth / 2 + nightstandWidth / 2 + 0.35,
            y: bed.y - bedDepth * 0.24,
          },
        );
      }
      place(room, "wardrobe", 0.3, 0.12, 6.2, {
        x: room.minX + width * 0.79,
        y: room.minY + depth * 0.82,
      });
    } else if (room.kind === "living") {
      const sofa = place(room, "sofa", 0.5, 0.22, 2.8);
      place(room, "coffee-table", 0.25, 0.14, 1.35, {
        x: room.centerX,
        y: sofa ? sofa.y + depth * 0.22 : room.centerY,
      });
      place(room, "media-console", 0.4, 0.1, 2.2, {
        x: room.centerX,
        y: room.minY + depth * 0.16,
      });
    } else if (room.kind === "dining") {
      const table = place(room, "dining-table", 0.42, 0.32, 2.5);
      if (table) {
        place(room, "chair", 0.14, 0.14, 2.8, { x: table.x - table.width * 0.36, y: table.y });
        place(room, "chair", 0.14, 0.14, 2.8, { x: table.x + table.width * 0.36, y: table.y });
        place(room, "chair", 0.14, 0.14, 2.8, { x: table.x, y: table.y - table.depth * 0.4 });
        place(room, "chair", 0.14, 0.14, 2.8, { x: table.x, y: table.y + table.depth * 0.4 });
      }
    } else {
      const desk = place(room, "desk", 0.44, 0.2, 2.5, {
        x: room.centerX,
        y: room.minY + depth * 0.3,
      });
      place(room, "desk-chair", 0.17, 0.17, 2.7, {
        x: desk?.x ?? room.centerX,
        y: desk ? desk.y + depth * 0.2 : room.centerY,
      });
    }
  }

  return placements;
}

export function inferFurnitureRooms(
  walls: Wall[],
  openings: Opening[],
): { rooms: RoomGuess[]; cellSize: number } {
  if (walls.length === 0) return { rooms: [], cellSize: 0 };
  const raster = rasterizeRooms(walls, openings);
  return {
    rooms: classifyRooms(raster.rooms, raster.bounds),
    cellSize: raster.grid.cellSize,
  };
}

export function validateFurnitureSuggestions(
  walls: Wall[],
  openings: Opening[],
  suggestions: Furniture[],
): Furniture[] {
  if (walls.length === 0) return [];
  const raster = rasterizeRooms(walls, openings);
  const rooms = classifyRooms(raster.rooms, raster.bounds);
  const roomsById = new Map(rooms.map((room) => [room.id, room]));
  const doorTargets = getDoorTargets(walls, openings);
  const accepted: Furniture[] = [];
  const maxWallHeight = Math.min(12, Math.max(...walls.map((wall) => wall.height)));

  for (const suggestion of suggestions.slice(0, 80)) {
    const room = roomsById.get(suggestion.roomId);
    if (!room || room.kind === "circulation") continue;
    if (
      ![suggestion.x, suggestion.y, suggestion.width, suggestion.depth, suggestion.height, suggestion.rotation].every(Number.isFinite) ||
      suggestion.width < 0.6 ||
      suggestion.depth < 0.6 ||
      suggestion.height < 0.3
    ) {
      continue;
    }

    const roomWidth = room.maxX - room.minX;
    const roomDepth = room.maxY - room.minY;
    if (
      suggestion.width > roomWidth * 0.78 ||
      suggestion.depth > roomDepth * 0.78 ||
      suggestion.height > maxWallHeight * 0.92
    ) {
      continue;
    }
    if (
      !footprintFitsRoom(
        room,
        raster.grid,
        suggestion.x,
        suggestion.y,
        suggestion.width,
        suggestion.depth,
        suggestion.rotation,
      ) ||
      blocksDoorApproach(
        suggestion.x,
        suggestion.y,
        suggestion.width,
        suggestion.depth,
        suggestion.rotation,
        doorTargets,
      ) ||
      overlapsFurniture(
        suggestion.x,
        suggestion.y,
        suggestion.width,
        suggestion.depth,
        suggestion.rotation,
        accepted.filter((item) => item.roomId === room.id),
      )
    ) {
      continue;
    }

    accepted.push({
      ...suggestion,
      roomLabel: room.label,
      confidence: clamp(suggestion.confidence, 0, 1),
      source: suggestion.source satisfies FurnitureSource,
    });
  }

  return accepted;
}

export function suggestFurnitureLayout(
  walls: Wall[],
  openings: Opening[],
): FurniturePlan {
  if (walls.length === 0) return { rooms: [], furniture: [], cellSize: 0 };

  const raster = rasterizeRooms(walls, openings);
  const classifiedRooms = classifyRooms(raster.rooms, raster.bounds);
  return {
    rooms: classifiedRooms,
    furniture: suggestedFurniture(
      classifiedRooms,
      raster.grid,
      openings,
      walls,
    ),
    cellSize: raster.grid.cellSize,
  };
}
