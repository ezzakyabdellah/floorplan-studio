import {
  DEFAULTS,
  type Opening,
  type Wall,
} from "../types/floorplan";

export type RoomZone = "front" | "core" | "private" | "service";
export type RoomConnection = "door" | "open" | "arch";

export type SemanticRoom = {
  id: string;
  type: string;
  area_m2: number;
  zone: RoomZone;
  windows: number;
};

export type SemanticLink = {
  from: string;
  to: string;
  connection: RoomConnection;
};

export type SemanticFloorPlan = {
  grid_unit_m: number;
  entrance_room: string;
  rooms: SemanticRoom[];
  links: SemanticLink[];
};

export type SolvedRoom = {
  id: string;
  type: string;
  zone: RoomZone;
  area_m2: number;
  x_m: number;
  y_m: number;
  width_m: number;
  height_m: number;
};

export type SolvedFloorPlan = {
  rooms: SolvedRoom[];
  walls: Wall[];
  openings: Opening[];
  warnings: string[];
};

type RoomSize = {
  room: SemanticRoom;
  candidateHeights: Map<number, number>;
};

type LayoutRow = {
  zone: RoomZone;
  rooms: Array<{ room: SemanticRoom; widthSteps: number }>;
  heightSteps: number;
};

type RoomEdge = {
  roomId: string;
  axis: "horizontal" | "vertical";
  coordinate: number;
  start: number;
  end: number;
};

type WallSegment = {
  axis: "horizontal" | "vertical";
  coordinate: number;
  start: number;
  end: number;
  roomIds: string[];
  wall: Wall;
};

const METERS_TO_FEET = 1 / 0.3048;
const MIN_ROOM_DIMENSION_M = 1;
const MIN_OPENING_WIDTH_M = 0.6;
const DOOR_WIDTH_M = 0.9;
const OPENING_WIDTH_M = 1.5;
const WINDOW_WIDTH_M = 1.2;
const OPENING_END_CLEARANCE_M = 0.05;
const OPENING_SPACING_M = 0.25;

function compareStrings(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function roundGridSteps(value: number) {
  return Number(value.toFixed(8));
}

function meterToFeet(value: number) {
  return Number((value * METERS_TO_FEET).toFixed(6));
}

const ROOM_ASPECT_MIN = 0.5;
const ROOM_ASPECT_MAX = 2;
const AREA_ERROR_WEIGHT = 6;

function roomHeightOptions(room: SemanticRoom, grid: number) {
  const minSteps = Math.max(1, Math.ceil(MIN_ROOM_DIMENSION_M / grid));
  const maxSteps = Math.max(
    minSteps,
    Math.ceil(Math.sqrt(Math.max(room.area_m2, 1)) / grid) + minSteps * 2,
  );
  const candidates = new Map<number, number>();
  for (let heightSteps = minSteps; heightSteps <= maxSteps; heightSteps += 1) {
    const rawWidthSteps = room.area_m2 / (heightSteps * grid * grid);
    if (rawWidthSteps > heightSteps * ROOM_ASPECT_MAX + 1e-9) continue;
    const widthSteps = Math.max(
      minSteps,
      Math.ceil(heightSteps * ROOM_ASPECT_MIN - 1e-9),
      Math.ceil(rawWidthSteps - 1e-8),
    );
    if (widthSteps <= heightSteps * ROOM_ASPECT_MAX + 1e-9) {
      candidates.set(heightSteps, widthSteps);
    }
  }
  if (candidates.size === 0) {
    const heightSteps = Math.max(
      minSteps,
      Math.ceil(Math.sqrt(Math.max(room.area_m2, 1) / ROOM_ASPECT_MAX) / grid),
    );
    const widthSteps = Math.max(
      minSteps,
      Math.ceil(room.area_m2 / (heightSteps * grid * grid) - 1e-8),
      Math.ceil(heightSteps * ROOM_ASPECT_MIN - 1e-9),
    );
    candidates.set(heightSteps, widthSteps);
  }
  return candidates;
}

function chooseHeightStep(
  roomSizes: RoomSize[],
  possibleHeights: Set<number>,
  grid: number,
) {
  return [...possibleHeights].sort((a, b) => {
    const score = (heightSteps: number) =>
      roomSizes.reduce((total, item) => {
        const widthSteps = item.candidateHeights.get(heightSteps) ?? heightSteps;
        const solvedArea = widthSteps * heightSteps * grid * grid;
        const areaError =
          Math.abs(solvedArea - item.room.area_m2) / item.room.area_m2;
        return (
          total +
          Math.abs(Math.log(widthSteps / heightSteps)) +
          areaError * AREA_ERROR_WEIGHT
        );
      }, 0);
    return score(a) - score(b) || a - b;
  })[0];
}

/**
 * Depth-first walk over the circulation graph. Rooms that are connected end up
 * next to each other in the ordering, so packing rows in this order keeps most
 * linked rooms on adjacent row/column positions.
 */
function buildTraversalOrder(plan: SemanticFloorPlan) {
  const adjacency = new Map<string, string[]>(
    plan.rooms.map((room) => [room.id, []]),
  );
  for (const link of plan.links) {
    adjacency.get(link.from)?.push(link.to);
    adjacency.get(link.to)?.push(link.from);
  }
  const order = new Map<string, number>();
  const visit = (roomId: string) => {
    if (order.has(roomId)) return;
    order.set(roomId, order.size);
    for (const next of adjacency.get(roomId) ?? []) visit(next);
  };
  visit(plan.entrance_room);
  for (const room of plan.rooms) visit(room.id);
  return order;
}

function buildRows(plan: SemanticFloorPlan) {
  const zoneOrder: RoomZone[] = ["front", "core", "service", "private"];
  const entrance = plan.rooms.find((room) => room.id === plan.entrance_room)!;
  const linksBetweenZones = new Map<string, number>();
  const zoneOf = new Map(plan.rooms.map((room) => [room.id, room.zone]));
  for (const link of plan.links) {
    const fromZone = zoneOf.get(link.from)!;
    const toZone = zoneOf.get(link.to)!;
    if (fromZone === toZone) continue;
    const key = [fromZone, toZone].sort().join("\u0000");
    linksBetweenZones.set(key, (linksBetweenZones.get(key) ?? 0) + 1);
  }
  const zoneLinkCount = (a: RoomZone, b: RoomZone) =>
    linksBetweenZones.get([a, b].sort().join("\u0000")) ?? 0;
  const orderedZones: RoomZone[] = [entrance.zone];
  const presentZones = new Set(plan.rooms.map((room) => room.zone));
  const remainingZones = new Set(
    zoneOrder.filter(
      (zone) => zone !== entrance.zone && presentZones.has(zone),
    ),
  );
  while (remainingZones.size > 0) {
    const previousZone = orderedZones[orderedZones.length - 1];
    const nextZone = [...remainingZones].sort((a, b) => {
      // Prefer the zone most tightly linked to the band just placed, then
      // to any band already placed, then the canonical zone order.
      const score = (zone: RoomZone) =>
        zoneLinkCount(previousZone, zone) * 100 +
        orderedZones.reduce(
          (total, placed) => total + zoneLinkCount(placed, zone) * 10,
          0,
        );
      return (
        score(b) - score(a) ||
        zoneOrder.indexOf(a) - zoneOrder.indexOf(b)
      );
    })[0];
    orderedZones.push(nextZone);
    remainingZones.delete(nextZone);
  }
  const traversalOrder = buildTraversalOrder(plan);
  const orderOf = (room: SemanticRoom) =>
    traversalOrder.get(room.id) ?? Number.MAX_SAFE_INTEGER;
  const rows: LayoutRow[] = [];

  for (const zone of orderedZones) {
    const remaining = plan.rooms
      .filter((room) => room.zone === zone)
      .sort(
        (a, b) =>
          orderOf(a) - orderOf(b) ||
          b.area_m2 - a.area_m2 ||
          compareStrings(a.id, b.id),
      );
    const pending = [...remaining];

    while (pending.length > 0) {
      const first = pending.shift()!;
      const firstSize: RoomSize = {
        room: first,
        candidateHeights: roomHeightOptions(first, plan.grid_unit_m),
      };
      const rowSizes = [firstSize];
      let possibleHeights = new Set(firstSize.candidateHeights.keys());

      for (let index = 0; index < pending.length; ) {
        const room = pending[index];
        const candidateHeights = roomHeightOptions(room, plan.grid_unit_m);
        const sharedHeights = new Set(
          [...possibleHeights].filter((height) => candidateHeights.has(height)),
        );
        if (sharedHeights.size === 0) {
          index += 1;
          continue;
        }
        rowSizes.push({ room, candidateHeights });
        possibleHeights = sharedHeights;
        pending.splice(index, 1);
      }

      const heightSteps = chooseHeightStep(
        rowSizes,
        possibleHeights,
        plan.grid_unit_m,
      );
      const orderedRooms = [...rowSizes].sort(
        (a, b) => orderOf(a.room) - orderOf(b.room),
      );
      rows.push({
        zone,
        heightSteps,
        rooms: orderedRooms.map((item) => ({
          room: item.room,
          widthSteps: item.candidateHeights.get(heightSteps)!,
        })),
      });
    }
  }
  return rows;
}

function rowWidthSteps(row: LayoutRow) {
  return row.rooms.reduce((total, item) => total + item.widthSteps, 0);
}

function alignmentScoreWithPreviousRow(
  row: LayoutRow,
  offsetSteps: number,
  previousRow: PlacedRow,
  links: SemanticLink[],
  grid: number,
) {
  const minimumDoorSteps = Math.ceil(
    (MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2) / grid - 1e-9,
  );
  const previousRooms = new Map(
    previousRow.rooms.map((item) => [item.room.id, item]),
  );
  let score = 0;
  let xSteps = offsetSteps;
  for (const item of row.rooms) {
    const endSteps = xSteps + item.widthSteps;
    for (const link of links) {
      const otherId =
        link.from === item.room.id
          ? link.to
          : link.to === item.room.id
            ? link.from
            : null;
      if (!otherId) continue;
      const other = previousRooms.get(otherId);
      if (!other) continue;
      const overlap = Math.max(
        0,
        Math.min(endSteps, other.xSteps + other.widthSteps) -
          Math.max(xSteps, other.xSteps),
      );
      if (overlap <= 0) continue;
      // Prefer satisfying every cross-band link over one very wide overlap:
      // each link that can fit a door earns a bonus, then overlap is capped.
      score += Math.min(overlap, minimumDoorSteps * 2);
      if (overlap >= minimumDoorSteps) score += 1000;
    }
    xSteps = endSteps;
  }
  return score;
}

type PlacedRowRoom = {
  room: SemanticRoom;
  xSteps: number;
  widthSteps: number;
};

type PlacedRow = {
  ySteps: number;
  heightSteps: number;
  rooms: PlacedRowRoom[];
};

function buildRoomRectangles(plan: SemanticFloorPlan): SolvedRoom[] {
  const rows = buildRows(plan);
  const grid = plan.grid_unit_m;
  const widestRowSteps = rows.reduce(
    (widest, row) => Math.max(widest, rowWidthSteps(row)),
    0,
  );
  const placedRows: PlacedRow[] = [];
  const rooms: SolvedRoom[] = [];
  let ySteps = 0;

  for (const row of rows) {
    let offsetSteps = 0;
    if (placedRows.length > 0) {
      const previousRow = placedRows[placedRows.length - 1];
      // Try every alignment so linked rooms in the previous band overlap.
      // The overlap term dominates; the offset term keeps the plan compact
      // when several alignments score equally.
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let candidate = 0; candidate <= widestRowSteps; candidate += 1) {
        const alignment = alignmentScoreWithPreviousRow(
          row,
          candidate,
          previousRow,
          plan.links,
          grid,
        );
        const score = alignment * 1000 - candidate;
        if (score > bestScore) {
          bestScore = score;
          offsetSteps = candidate;
        }
      }
    }

    const height = row.heightSteps * grid;
    const placedRooms: PlacedRowRoom[] = [];
    let xSteps = offsetSteps;
    for (const item of row.rooms) {
      const width = item.widthSteps * grid;
      rooms.push({
        id: item.room.id,
        type: item.room.type,
        zone: item.room.zone,
        area_m2: item.room.area_m2,
        x_m: roundGridSteps(xSteps * grid),
        y_m: roundGridSteps(ySteps * grid),
        width_m: roundGridSteps(width),
        height_m: roundGridSteps(height),
      });
      placedRooms.push({
        room: item.room,
        xSteps,
        widthSteps: item.widthSteps,
      });
      xSteps += item.widthSteps;
    }
    placedRows.push({
      ySteps,
      heightSteps: row.heightSteps,
      rooms: placedRooms,
    });
    ySteps += row.heightSteps;
  }

  return rooms;
}

function roomEdges(rooms: SolvedRoom[]): RoomEdge[] {
  return rooms.flatMap((room) => [
    {
      roomId: room.id,
      axis: "horizontal" as const,
      coordinate: room.y_m,
      start: room.x_m,
      end: room.x_m + room.width_m,
    },
    {
      roomId: room.id,
      axis: "horizontal" as const,
      coordinate: room.y_m + room.height_m,
      start: room.x_m,
      end: room.x_m + room.width_m,
    },
    {
      roomId: room.id,
      axis: "vertical" as const,
      coordinate: room.x_m,
      start: room.y_m,
      end: room.y_m + room.height_m,
    },
    {
      roomId: room.id,
      axis: "vertical" as const,
      coordinate: room.x_m + room.width_m,
      start: room.y_m,
      end: room.y_m + room.height_m,
    },
  ]);
}

function buildWallSegments(rooms: SolvedRoom[]) {
  const groups = new Map<string, RoomEdge[]>();
  for (const edge of roomEdges(rooms)) {
    const key = `${edge.axis}:${edge.coordinate.toFixed(6)}`;
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }

  const segments: WallSegment[] = [];
  for (const edges of groups.values()) {
    const { axis, coordinate } = edges[0];
    const breakpoints = [...new Set(edges.flatMap(({ start, end }) => [start, end]))]
      .sort((a, b) => a - b);
    for (let index = 0; index < breakpoints.length - 1; index += 1) {
      const start = breakpoints[index];
      const end = breakpoints[index + 1];
      if (end - start < 1e-6) continue;
      const midpoint = (start + end) / 2;
      const roomIds = [
        ...new Set(
          edges
            .filter((edge) => midpoint > edge.start - 1e-7 && midpoint < edge.end + 1e-7)
            .map((edge) => edge.roomId),
        ),
      ];
      if (roomIds.length === 0) continue;

      const wallIndex = segments.length + 1;
      const wall: Wall =
        axis === "horizontal"
          ? {
              id: `ai-wall-${wallIndex}`,
              x1: meterToFeet(start),
              y1: meterToFeet(coordinate),
              x2: meterToFeet(end),
              y2: meterToFeet(coordinate),
              thickness: DEFAULTS.wallThickness,
              height: DEFAULTS.wallHeight,
            }
          : {
              id: `ai-wall-${wallIndex}`,
              x1: meterToFeet(coordinate),
              y1: meterToFeet(start),
              x2: meterToFeet(coordinate),
              y2: meterToFeet(end),
              thickness: DEFAULTS.wallThickness,
              height: DEFAULTS.wallHeight,
            };
      segments.push({ axis, coordinate, start, end, roomIds, wall });
    }
  }
  return segments;
}

function sharedSegments(
  segments: WallSegment[],
  firstRoom: string,
  secondRoom: string,
) {
  return segments
    .filter(
      (segment) =>
        segment.roomIds.includes(firstRoom) &&
        segment.roomIds.includes(secondRoom),
    )
    .sort((a, b) => b.end - b.start - (a.end - a.start));
}

function openingCenterMeters(segment: WallSegment) {
  return (segment.end - segment.start) / 2;
}

function toOpening(
  segment: WallSegment,
  type: Opening["type"],
  widthMeters: number,
  id: string,
  centerMeters = openingCenterMeters(segment),
): Opening {
  const lengthFeet =
    (segment.end - segment.start) * METERS_TO_FEET;
  const centerFeet = centerMeters * METERS_TO_FEET;
  return {
    id,
    wallId: segment.wall.id,
    type,
    positionOnWall: Math.max(
      0,
      Math.min(1, centerFeet / lengthFeet),
    ),
    width: meterToFeet(widthMeters),
  };
}

function placeWidth(
  requestedWidth: number,
  segment: WallSegment,
  warnings: string[],
  label: string,
) {
  const available = segment.end - segment.start - OPENING_END_CLEARANCE_M * 2;
  const width = Math.min(requestedWidth, available);
  if (width < MIN_OPENING_WIDTH_M) {
    warnings.push(`${label} could not fit on its shared/exterior wall.`);
    return null;
  }
  if (width < requestedWidth - 1e-6) {
    warnings.push(
      `${label} was narrowed to ${width.toFixed(2)} m to fit the available wall.`,
    );
  }
  return width;
}

function openingOverlaps(
  openings: Opening[],
  segment: WallSegment,
  centerMeters: number,
  widthMeters: number,
) {
  const lengthFeet = (segment.end - segment.start) * METERS_TO_FEET;
  const centerFeet = centerMeters * METERS_TO_FEET;
  const widthFeet = widthMeters * METERS_TO_FEET;
  return openings.some((opening) => {
    if (opening.wallId !== segment.wall.id) return false;
    const otherCenter = opening.positionOnWall * lengthFeet;
    // The round-trip through positionOnWall introduces floating-point noise;
    // subtract a tiny epsilon so openings placed at the exact minimum spacing
    // are still accepted.
    return (
      Math.abs(otherCenter - centerFeet) <
      (opening.width + widthFeet) / 2 +
        OPENING_SPACING_M * METERS_TO_FEET -
        1e-6
    );
  });
}

function placeWindows(
  plan: SemanticFloorPlan,
  rooms: SolvedRoom[],
  segments: WallSegment[],
  entranceWallId: string,
  openings: Opening[],
  warnings: string[],
) {
  for (const room of rooms) {
    const requested = plan.rooms.find((item) => item.id === room.id)!.windows;
    if (requested === 0) continue;
    const roomExterior = segments.filter(
      (segment) => segment.roomIds.length === 1 && segment.roomIds[0] === room.id,
    );
    const fitsWindow = (segment: WallSegment) =>
      segment.end - segment.start >=
      MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2;
    const preferred = roomExterior
      .filter((segment) => segment.wall.id !== entranceWallId)
      .filter(fitsWindow);
    const candidates = (preferred.length > 0
      ? preferred
      : roomExterior.filter(fitsWindow))
      .sort((a, b) => b.end - b.start - (a.end - a.start));
    const allocations = new Map<string, number>();

    for (let index = 0; index < requested; index += 1) {
      const candidate = candidates
        .filter((segment) => {
          const count = allocations.get(segment.wall.id) ?? 0;
          const length = segment.end - segment.start;
          const capacity = Math.max(
            1,
            Math.floor(
              (length + OPENING_SPACING_M) /
                (WINDOW_WIDTH_M + OPENING_SPACING_M),
            ),
          );
          return count < capacity;
        })
        .sort((a, b) => {
          const aCount = allocations.get(a.wall.id) ?? 0;
          const bCount = allocations.get(b.wall.id) ?? 0;
          return (
            (b.end - b.start) / (bCount + 1) -
              (a.end - a.start) / (aCount + 1) ||
            compareStrings(a.wall.id, b.wall.id)
          );
        })[0];
      if (!candidate) {
        warnings.push(
          `Room "${room.id}" requested ${requested} window(s), but only ${index} could fit on exterior walls.`,
        );
        break;
      }
      allocations.set(
        candidate.wall.id,
        (allocations.get(candidate.wall.id) ?? 0) + 1,
      );
    }

    for (const segment of candidates) {
      const count = allocations.get(segment.wall.id) ?? 0;
      const length = segment.end - segment.start;
      for (let index = 0; index < count; index += 1) {
        const center = (length * (index + 1)) / (count + 1);
        const maxEvenWidth =
          count === 1
            ? length - OPENING_END_CLEARANCE_M * 2
            : Math.min(
                (2 * length) / (count + 1) - OPENING_END_CLEARANCE_M * 2,
                length / (count + 1) - OPENING_SPACING_M,
              );
        const width = Math.min(WINDOW_WIDTH_M, maxEvenWidth);
        if (width < MIN_OPENING_WIDTH_M || openingOverlaps(openings, segment, center, width)) {
          warnings.push(
            `A requested window for room "${room.id}" could not fit without overlapping another opening.`,
          );
          continue;
        }
        openings.push(
          toOpening(
            segment,
            "window",
            width,
            `ai-window-${openings.filter((opening) => opening.type === "window").length + 1}`,
            center,
          ),
        );
        if (width < WINDOW_WIDTH_M - 1e-6) {
          warnings.push(
            `A window for room "${room.id}" was narrowed to ${width.toFixed(2)} m.`,
          );
        }
      }
    }
  }
}

export function solveFloorPlanLayout(plan: SemanticFloorPlan): SolvedFloorPlan {
  const rooms = buildRoomRectangles(plan);
  const segments = buildWallSegments(rooms);
  const warnings: string[] = [];
  const openings: Opening[] = [];
  const entranceCandidates = segments
    .filter(
      (segment) =>
        segment.roomIds.length === 1 &&
        segment.roomIds[0] === plan.entrance_room &&
        segment.end - segment.start >= MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2,
    )
    .sort((a, b) => {
      const aAtFront = a.axis === "horizontal" && Math.abs(a.coordinate) < 1e-6;
      const bAtFront = b.axis === "horizontal" && Math.abs(b.coordinate) < 1e-6;
      return Number(bAtFront) - Number(aAtFront) || b.end - b.start - (a.end - a.start);
    });
  const entranceSegment = entranceCandidates[0];
  let entranceWallId = "";
  if (entranceSegment) {
    const width =
      placeWidth(DOOR_WIDTH_M, entranceSegment, warnings, "The entrance door") ??
      Math.min(DOOR_WIDTH_M, entranceSegment.end - entranceSegment.start);
    entranceWallId = entranceSegment.wall.id;
    openings.push(
      toOpening(entranceSegment, "door", width, "ai-entrance-door"),
    );
  } else {
    warnings.push(
      `Room "${plan.entrance_room}" has no exterior wall segment wide enough for the main entrance door.`,
    );
  }

  for (const link of plan.links) {
    const candidate = sharedSegments(segments, link.from, link.to).find(
      (segment) =>
        segment.end - segment.start >=
        MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2,
    );
    if (!candidate) {
      warnings.push(
        `Linked rooms "${link.from}" and "${link.to}" do not share a wall segment wide enough for an opening.`,
      );
      continue;
    }
    const requestedWidth =
      link.connection === "door" ? DOOR_WIDTH_M : OPENING_WIDTH_M;
    const width =
      placeWidth(
        requestedWidth,
        candidate,
        warnings,
        `The ${link.connection} opening between "${link.from}" and "${link.to}"`,
      ) ?? MIN_OPENING_WIDTH_M;
    if (openingOverlaps(openings, candidate, openingCenterMeters(candidate), width)) {
      warnings.push(
        `The opening between "${link.from}" and "${link.to}" was omitted because it overlaps another opening.`,
      );
      continue;
    }
    // The current scene model supports door and window openings; open/arch
    // connections use a wider door-type wall cutout for renderer compatibility.
    openings.push(
      toOpening(
        candidate,
        "door",
        width,
        `ai-link-${openings.length + 1}`,
      ),
    );
  }

  placeWindows(plan, rooms, segments, entranceWallId, openings, warnings);
  for (const warning of warnings) {
    console.warn(`[Floor plan] ${warning}`);
  }
  return {
    rooms,
    walls: segments.map((segment) => segment.wall),
    openings,
    warnings,
  };
}

export function validateSemanticFloorPlan(value: unknown): SemanticFloorPlan {
  const fail = (message: string): never => {
    const error = new Error(`Invalid semantic floor plan: ${message}.`);
    console.error("[Floor plan validation]", error);
    throw error;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const allowedKeys = ["grid_unit_m", "entrance_room", "rooms", "links"];
  if (Object.keys(raw).some((key) => !allowedKeys.includes(key))) {
    return fail("unexpected top-level properties");
  }
  if (
    typeof raw.grid_unit_m !== "number" ||
    !Number.isFinite(raw.grid_unit_m) ||
    raw.grid_unit_m < 0.1 ||
    raw.grid_unit_m > 2
  ) {
    return fail("grid_unit_m must be between 0.1 and 2 meters");
  }
  if (
    typeof raw.entrance_room !== "string" ||
    !raw.entrance_room.trim() ||
    raw.entrance_room !== raw.entrance_room.trim()
  ) {
    return fail("entrance_room must be a non-empty room id");
  }
  if (!Array.isArray(raw.rooms) || raw.rooms.length === 0 || raw.rooms.length > 32) {
    return fail("rooms must contain between 1 and 32 entries");
  }

  const ids = new Set<string>();
  const rooms = raw.rooms.map((entry, index): SemanticRoom => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return fail(`room ${index + 1} must be an object`);
    }
    const room = entry as Record<string, unknown>;
    const roomKeys = ["id", "type", "area_m2", "zone", "windows"];
    if (Object.keys(room).some((key) => !roomKeys.includes(key))) {
      return fail(`room ${index + 1} has unexpected properties`);
    }
    if (
      typeof room.id !== "string" ||
      !room.id.trim() ||
      room.id !== room.id.trim() ||
      typeof room.type !== "string" ||
      !room.type.trim()
    ) {
      return fail(`room ${index + 1} needs non-empty id and type values`);
    }
    if (ids.has(room.id)) return fail(`room id "${room.id}" is duplicated`);
    ids.add(room.id);
    if (
      typeof room.area_m2 !== "number" ||
      !Number.isFinite(room.area_m2) ||
      room.area_m2 <= 0 ||
      room.area_m2 > 1000
    ) {
      return fail(`room "${room.id}" area_m2 must be positive and at most 1000`);
    }
    if (
      room.zone !== "front" &&
      room.zone !== "core" &&
      room.zone !== "private" &&
      room.zone !== "service"
    ) {
      return fail(`room "${room.id}" has an unsupported zone`);
    }
    if (
      typeof room.windows !== "number" ||
      !Number.isInteger(room.windows) ||
      room.windows < 0 ||
      room.windows > 12
    ) {
      return fail(`room "${room.id}" windows must be a non-negative integer`);
    }
    return {
      id: room.id,
      type: room.type,
      area_m2: room.area_m2,
      zone: room.zone,
      windows: room.windows,
    };
  });

  if (!ids.has(raw.entrance_room)) {
    return fail(`entrance_room "${raw.entrance_room}" does not exist`);
  }
  if (!Array.isArray(raw.links) || raw.links.length > 128) {
    return fail("links must be an array with at most 128 entries");
  }
  const linkKeys = new Set<string>();
  const links: SemanticLink[] = [];
  raw.links.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return fail(`link ${index + 1} must be an object`);
    }
    const link = entry as Record<string, unknown>;
    const linkKeysAllowed = ["from", "to", "connection"];
    const extraKeys = Object.keys(link).filter(
      (key) => !linkKeysAllowed.includes(key),
    );
    if (extraKeys.length > 0) {
      return fail(
        `link ${index + 1} has unexpected field(s): ${extraKeys.join(", ")}. Allowed fields: from, to, connection`,
      );
    }
    if (typeof link.from !== "string" || typeof link.to !== "string") {
      return fail(`link ${index + 1} must have string "from" and "to" room ids`);
    }
    const unknownIds = [...new Set([link.from, link.to])].filter(
      (id) => !ids.has(id),
    );
    if (unknownIds.length > 0) {
      return fail(
        `link ${index + 1} (${link.from} -> ${link.to}) references an unknown room id: ${unknownIds.join(", ")}. Known room ids: ${[...ids].join(", ")}`,
      );
    }
    if (link.from === link.to) return fail(`link ${index + 1} connects a room to itself`);
    if (
      link.connection !== "door" &&
      link.connection !== "open" &&
      link.connection !== "arch"
    ) {
      return fail(
        `link ${index + 1} has unsupported connection ${JSON.stringify(link.connection)}; expected door, open, or arch`,
      );
    }
    const key = [link.from, link.to].sort().join("\u0000");
    if (linkKeys.has(key)) {
      console.warn(
        `[Floor plan validation] Dropped duplicate link ${index + 1} between "${link.from}" and "${link.to}".`,
      );
      return;
    }
    linkKeys.add(key);
    links.push({
      from: link.from,
      to: link.to,
      connection: link.connection,
    });
  });

  const connected = new Set<string>([rooms[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (connected.has(link.from) && !connected.has(link.to)) {
        connected.add(link.to);
        changed = true;
      } else if (connected.has(link.to) && !connected.has(link.from)) {
        connected.add(link.from);
        changed = true;
      }
    }
  }
  if (connected.size !== rooms.length) {
    const disconnected = rooms
      .filter((room) => !connected.has(room.id))
      .map((room) => room.id);
    return fail(
      `room-link graph is disconnected; unreachable rooms: ${disconnected.join(", ")}`,
    );
  }

  return {
    grid_unit_m: raw.grid_unit_m,
    entrance_room: raw.entrance_room,
    rooms,
    links,
  };
}
