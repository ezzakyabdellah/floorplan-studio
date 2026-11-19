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

function roomHeightOptions(room: SemanticRoom, grid: number) {
  const minSteps = Math.max(1, Math.ceil(MIN_ROOM_DIMENSION_M / grid));
  const maxSteps = Math.max(
    minSteps,
    Math.ceil(Math.sqrt(Math.max(room.area_m2, 1)) / grid) + minSteps * 2,
  );
  const candidates = new Map<number, number>();
  for (let heightSteps = minSteps; heightSteps <= maxSteps; heightSteps += 1) {
    const height = heightSteps * grid;
    const areaWidth = room.area_m2 / height;
    const widthSteps = Math.max(
      minSteps,
      heightSteps,
      Math.ceil(areaWidth / grid - 1e-8),
    );
    if (widthSteps <= heightSteps * 2) {
      candidates.set(heightSteps, widthSteps);
    }
  }
  if (candidates.size === 0) {
    const heightSteps = Math.max(
      minSteps,
      Math.ceil(Math.sqrt(Math.max(room.area_m2, 1) / 2) / grid),
    );
    candidates.set(heightSteps, Math.max(heightSteps, Math.ceil(heightSteps * 1.5)));
  }
  return candidates;
}

function chooseHeightStep(
  roomSizes: RoomSize[],
  possibleHeights: Set<number>,
) {
  return [...possibleHeights].sort((a, b) => {
    const score = (heightSteps: number) =>
      roomSizes.reduce((total, item) => {
        const widthSteps = item.candidateHeights.get(heightSteps) ?? heightSteps;
        return total + Math.abs(Math.log(widthSteps / heightSteps));
      }, 0);
    return score(a) - score(b) || a - b;
  })[0];
}

function arrangeRowRooms(
  rooms: SemanticRoom[],
  links: SemanticLink[],
  anchorRoom: string,
) {
  const remaining = [...rooms];
  const ordered: SemanticRoom[] = [];
  const entranceIndex = remaining.findIndex((room) => room.id === anchorRoom);
  if (entranceIndex >= 0) ordered.push(...remaining.splice(entranceIndex, 1));
  if (ordered.length === 0 && remaining.length > 0) {
    const highestDegree = remaining
      .map((room, index) => ({
        index,
        degree: links.filter(
          (link) => link.from === room.id || link.to === room.id,
        ).length,
      }))
      .sort((a, b) => b.degree - a.degree || a.index - b.index)[0];
    ordered.push(...remaining.splice(highestDegree.index, 1));
  }
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    const nextIndex = remaining.findIndex((room) =>
      links.some(
        (link) =>
          (link.from === last.id && link.to === room.id) ||
          (link.to === last.id && link.from === room.id),
      ),
    );
    ordered.push(...remaining.splice(nextIndex >= 0 ? nextIndex : 0, 1));
  }
  return ordered;
}

function buildRows(plan: SemanticFloorPlan) {
  const zoneOrder: RoomZone[] = ["front", "core", "service", "private"];
  const entrance = plan.rooms.find((room) => room.id === plan.entrance_room)!;
  const orderedZones = [
    entrance.zone,
    ...zoneOrder.filter((zone) => zone !== entrance.zone),
  ];
  const rows: LayoutRow[] = [];

  for (const zone of orderedZones) {
    const remaining = plan.rooms
      .filter((room) => room.zone === zone)
      .sort((a, b) => b.area_m2 - a.area_m2 || compareStrings(a.id, b.id));
    const zoneRooms = arrangeRowRooms(
      remaining,
      plan.links,
      plan.entrance_room,
    );
    let pending = [...zoneRooms];

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

      const heightSteps = chooseHeightStep(rowSizes, possibleHeights);
      const orderedRooms = arrangeRowRooms(
        rowSizes.map((item) => item.room),
        plan.links,
        plan.entrance_room,
      );
      rows.push({
        zone,
        heightSteps,
        rooms: orderedRooms.map((room) => {
          const item = rowSizes.find((candidate) => candidate.room.id === room.id)!;
          return {
            room,
            widthSteps: item.candidateHeights.get(heightSteps)!,
          };
        }),
      });
    }
  }
  let previousRoomId: string | null = null;
  return rows.map((row) => {
    const linkedAnchor =
      previousRoomId === null
        ? plan.entrance_room
        : row.rooms.find((item) =>
            plan.links.some(
              (link) =>
                (link.from === previousRoomId && link.to === item.room.id) ||
                (link.to === previousRoomId && link.from === item.room.id),
            ),
          )?.room.id ?? plan.entrance_room;
    const orderedRooms = arrangeRowRooms(
      row.rooms.map((item) => item.room),
      plan.links,
      linkedAnchor,
    );
    previousRoomId = orderedRooms[0]?.id ?? null;
    return {
      ...row,
      rooms: orderedRooms.map((room) => row.rooms.find((item) => item.room.id === room.id)!),
    };
  });
}

function buildRoomRectangles(plan: SemanticFloorPlan): SolvedRoom[] {
  const rows = buildRows(plan);
  let y = 0;
  const rooms: SolvedRoom[] = [];
  for (const row of rows) {
    let x = 0;
    const height = row.heightSteps * plan.grid_unit_m;
    for (const item of row.rooms) {
      const width = item.widthSteps * plan.grid_unit_m;
      rooms.push({
        id: item.room.id,
        type: item.room.type,
        zone: item.room.zone,
        area_m2: item.room.area_m2,
        x_m: roundGridSteps(x),
        y_m: roundGridSteps(y),
        width_m: roundGridSteps(width),
        height_m: roundGridSteps(height),
      });
      x += width;
    }
    y += height;
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
    return (
      Math.abs(otherCenter - centerFeet) <
      (opening.width + widthFeet) / 2 + OPENING_SPACING_M * METERS_TO_FEET
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
  const links = raw.links.map((entry, index): SemanticLink => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return fail(`link ${index + 1} must be an object`);
    }
    const link = entry as Record<string, unknown>;
    const linkKeysAllowed = ["from", "to", "connection"];
    if (Object.keys(link).some((key) => !linkKeysAllowed.includes(key))) {
      return fail(`link ${index + 1} has unexpected properties`);
    }
    if (
      typeof link.from !== "string" ||
      typeof link.to !== "string" ||
      !ids.has(link.from) ||
      !ids.has(link.to)
    ) {
      return fail(`link ${index + 1} references an unknown room id`);
    }
    if (link.from === link.to) return fail(`link ${index + 1} connects a room to itself`);
    if (
      link.connection !== "door" &&
      link.connection !== "open" &&
      link.connection !== "arch"
    ) {
      return fail(`link ${index + 1} has an unsupported connection`);
    }
    const key = [link.from, link.to].sort().join("\u0000");
    if (linkKeys.has(key)) return fail(`link ${index + 1} duplicates a room connection`);
    linkKeys.add(key);
    return {
      from: link.from,
      to: link.to,
      connection: link.connection,
    };
  });

  return {
    grid_unit_m: raw.grid_unit_m,
    entrance_room: raw.entrance_room,
    rooms,
    links,
  };
}
