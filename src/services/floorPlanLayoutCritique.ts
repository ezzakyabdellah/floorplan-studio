import type {
  SemanticFloorPlan,
  SemanticLink,
  SolvedFloorPlan,
  SolvedRoom,
} from "./floorPlanLayoutSolver";

export type LayoutDiagnostic = {
  code:
    | "room-overlap"
    | "disconnected-geometry"
    | "missing-shared-wall"
    | "link-without-opening"
    | "unreachable-room"
    | "no-exterior-wall"
    | "missing-entrance-exterior"
    | "not-compact"
    | "room-area-drift"
    | "area-drift";
  message: string;
  roomIds: string[];
  link?: { from: string; to: string };
};

const EPSILON = 1e-6;
const FEET_TO_METERS = 0.3048;
const AREA_DRIFT_TOLERANCE = 0.2;
const ROOM_AREA_DRIFT_TOLERANCE = 0.25;
const ROOM_AREA_ABSOLUTE_TOLERANCE = 1;
const MIN_COMPACT_FILL = 0.78;
const NON_HABITABLE_ROOM =
  /bath|toilet|closet|wardrobe|storage|utility|laundry|hall|corridor|pantry/i;

function overlapLength(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function roomsShareWall(a: SolvedRoom, b: SolvedRoom) {
  const verticalTouch =
    Math.abs(a.x_m + a.width_m - b.x_m) < EPSILON ||
    Math.abs(b.x_m + b.width_m - a.x_m) < EPSILON;
  const horizontalTouch =
    Math.abs(a.y_m + a.height_m - b.y_m) < EPSILON ||
    Math.abs(b.y_m + b.height_m - a.y_m) < EPSILON;
  const verticalOverlap = overlapLength(
    a.y_m,
    a.y_m + a.height_m,
    b.y_m,
    b.y_m + b.height_m,
  );
  const horizontalOverlap = overlapLength(
    a.x_m,
    a.x_m + a.width_m,
    b.x_m,
    b.x_m + b.width_m,
  );
  return (verticalTouch && verticalOverlap > EPSILON) ||
    (horizontalTouch && horizontalOverlap > EPSILON);
}

function overlaps(a: SolvedRoom, b: SolvedRoom) {
  return (
    overlapLength(
      a.x_m,
      a.x_m + a.width_m,
      b.x_m,
      b.x_m + b.width_m,
    ) > EPSILON &&
    overlapLength(
      a.y_m,
      a.y_m + a.height_m,
      b.y_m,
      b.y_m + b.height_m,
    ) > EPSILON
  );
}

function coveredLength(intervals: Array<[number, number]>) {
  const sorted = intervals
    .filter(([start, end]) => end - start > EPSILON)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const [nextStart, nextEnd] of sorted) {
    if (start === null || end === null) {
      start = nextStart;
      end = nextEnd;
    } else if (nextStart <= end + EPSILON) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  if (start !== null && end !== null) total += end - start;
  return total;
}

function hasExteriorWall(room: SolvedRoom, rooms: SolvedRoom[]) {
  const left = rooms
    .filter(
      (other) =>
        other.id !== room.id &&
        Math.abs(other.x_m + other.width_m - room.x_m) < EPSILON,
    )
    .map((other) => [
      Math.max(room.y_m, other.y_m),
      Math.min(room.y_m + room.height_m, other.y_m + other.height_m),
    ] as [number, number]);
  const right = rooms
    .filter(
      (other) =>
        other.id !== room.id &&
        Math.abs(room.x_m + room.width_m - other.x_m) < EPSILON,
    )
    .map((other) => [
      Math.max(room.y_m, other.y_m),
      Math.min(room.y_m + room.height_m, other.y_m + other.height_m),
    ] as [number, number]);
  const bottom = rooms
    .filter(
      (other) =>
        other.id !== room.id &&
        Math.abs(other.y_m + other.height_m - room.y_m) < EPSILON,
    )
    .map((other) => [
      Math.max(room.x_m, other.x_m),
      Math.min(room.x_m + room.width_m, other.x_m + other.width_m),
    ] as [number, number]);
  const top = rooms
    .filter(
      (other) =>
        other.id !== room.id &&
        Math.abs(room.y_m + room.height_m - other.y_m) < EPSILON,
    )
    .map((other) => [
      Math.max(room.x_m, other.x_m),
      Math.min(room.x_m + room.width_m, other.x_m + other.width_m),
    ] as [number, number]);

  return (
    coveredLength(left) < room.height_m - EPSILON ||
    coveredLength(right) < room.height_m - EPSILON ||
    coveredLength(bottom) < room.width_m - EPSILON ||
    coveredLength(top) < room.width_m - EPSILON
  );
}

function geometryIsConnected(rooms: SolvedRoom[]) {
  if (rooms.length <= 1) return true;
  const reached = new Set([rooms[0].id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const room of rooms) {
      if (reached.has(room.id)) continue;
      if (
        rooms.some(
          (candidate) =>
            reached.has(candidate.id) && roomsShareWall(room, candidate),
        )
      ) {
        reached.add(room.id);
        changed = true;
      }
    }
  }
  return reached.size === rooms.length;
}

function wallRoomIds(wall: SolvedFloorPlan["walls"][number], rooms: SolvedRoom[]) {
  const x1 = wall.x1 * FEET_TO_METERS;
  const y1 = wall.y1 * FEET_TO_METERS;
  const x2 = wall.x2 * FEET_TO_METERS;
  const y2 = wall.y2 * FEET_TO_METERS;
  const horizontal = Math.abs(y1 - y2) < EPSILON;
  const ids = new Set<string>();

  for (const room of rooms) {
    if (horizontal) {
      const onEdge =
        Math.abs(room.y_m - y1) < EPSILON ||
        Math.abs(room.y_m + room.height_m - y1) < EPSILON;
      const overlap =
        overlapLength(room.x_m, room.x_m + room.width_m, x1, x2);
      if (onEdge && overlap > EPSILON) ids.add(room.id);
    } else {
      const onEdge =
        Math.abs(room.x_m - x1) < EPSILON ||
        Math.abs(room.x_m + room.width_m - x1) < EPSILON;
      const overlap =
        overlapLength(room.y_m, room.y_m + room.height_m, y1, y2);
      if (onEdge && overlap > EPSILON) ids.add(room.id);
    }
  }
  return [...ids];
}

function doorPairs(solved: SolvedFloorPlan) {
  const byWall = new Map(
    solved.walls.map((wall) => [wall.id, wallRoomIds(wall, solved.rooms)]),
  );
  const pairs: Array<[string, string]> = [];
  for (const opening of solved.openings) {
    if (opening.type !== "door") continue;
    const roomIds = byWall.get(opening.wallId) ?? [];
    if (roomIds.length === 2) pairs.push([roomIds[0], roomIds[1]]);
  }
  return pairs;
}

function reachableRoomIds(solved: SolvedFloorPlan, entranceRoom: string) {
  const pairs = doorPairs(solved);
  const graph = new Map<string, Set<string>>();
  for (const room of solved.rooms) graph.set(room.id, new Set());
  for (const [a, b] of pairs) {
    graph.get(a)?.add(b);
    graph.get(b)?.add(a);
  }

  const reached = new Set([entranceRoom]);
  const queue = [entranceRoom];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const neighbour of graph.get(id) ?? []) {
      if (reached.has(neighbour)) continue;
      reached.add(neighbour);
      queue.push(neighbour);
    }
  }
  return reached;
}

function linkHasOpening(
  link: SemanticLink,
  solved: SolvedFloorPlan,
) {
  const byWall = new Map(
    solved.walls.map((wall) => [wall.id, wallRoomIds(wall, solved.rooms)]),
  );
  return solved.openings.some((opening) => {
    if (opening.type !== "door") return false;
    const roomIds = byWall.get(opening.wallId) ?? [];
    return (
      roomIds.includes(link.from) &&
      roomIds.includes(link.to) &&
      roomIds.length === 2
    );
  });
}

function boundingBox(rooms: SolvedRoom[]) {
  const minX = Math.min(...rooms.map((room) => room.x_m));
  const minY = Math.min(...rooms.map((room) => room.y_m));
  const maxX = Math.max(...rooms.map((room) => room.x_m + room.width_m));
  const maxY = Math.max(...rooms.map((room) => room.y_m + room.height_m));
  return { width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

export function critiqueFloorPlanLayout(
  plan: SemanticFloorPlan,
  solved: SolvedFloorPlan,
): LayoutDiagnostic[] {
  const diagnostics: LayoutDiagnostic[] = [];
  const roomById = new Map(solved.rooms.map((room) => [room.id, room]));

  for (let first = 0; first < solved.rooms.length; first += 1) {
    for (let second = first + 1; second < solved.rooms.length; second += 1) {
      const a = solved.rooms[first];
      const b = solved.rooms[second];
      if (overlaps(a, b)) {
        diagnostics.push({
          code: "room-overlap",
          message: `Rooms "${a.id}" and "${b.id}" overlap.`,
          roomIds: [a.id, b.id],
        });
      }
    }
  }

  if (!geometryIsConnected(solved.rooms)) {
    diagnostics.push({
      code: "disconnected-geometry",
      message: "The solved rooms form more than one connected island.",
      roomIds: solved.rooms.map((room) => room.id),
    });
  }

  for (const link of plan.links) {
    const from = roomById.get(link.from);
    const to = roomById.get(link.to);
    if (!from || !to || !roomsShareWall(from, to)) {
      diagnostics.push({
        code: "missing-shared-wall",
        message: `Linked rooms "${link.from}" and "${link.to}" do not share a wall.`,
        roomIds: [link.from, link.to],
        link: { from: link.from, to: link.to },
      });
      continue;
    }
    if (!linkHasOpening(link, solved)) {
      diagnostics.push({
        code: "link-without-opening",
        message: `Linked rooms "${link.from}" and "${link.to}" share a wall but have no door.`,
        roomIds: [link.from, link.to],
        link: { from: link.from, to: link.to },
      });
    }
  }

  const reachable = reachableRoomIds(solved, plan.entrance_room);
  for (const room of plan.rooms) {
    if (!reachable.has(room.id)) {
      diagnostics.push({
        code: "unreachable-room",
        message: `Room "${room.id}" has no door path from the entrance.`,
        roomIds: [room.id],
      });
    }
  }

  for (const room of plan.rooms) {
    const rectangle = roomById.get(room.id);
    if (
      rectangle &&
      room.windows > 0 &&
      !NON_HABITABLE_ROOM.test(`${room.id} ${room.type}`) &&
      !hasExteriorWall(rectangle, solved.rooms)
    ) {
      diagnostics.push({
        code: "no-exterior-wall",
        message: `Room "${room.id}" requests ${room.windows} window(s) but has no exterior wall.`,
        roomIds: [room.id],
      });
    }
  }

  const entrance = roomById.get(plan.entrance_room);
  if (entrance && !hasExteriorWall(entrance, solved.rooms)) {
    diagnostics.push({
      code: "missing-entrance-exterior",
      message: `Entrance room "${plan.entrance_room}" has no exterior wall.`,
      roomIds: [plan.entrance_room],
    });
  }

  if (solved.rooms.length > 0) {
    const box = boundingBox(solved.rooms);
    const boxArea = box.width * box.height;
    const roomArea = solved.rooms.reduce(
      (total, room) => total + room.width_m * room.height_m,
      0,
    );
    const fill = boxArea > 0 ? roomArea / boxArea : 1;
    if (fill < MIN_COMPACT_FILL) {
      diagnostics.push({
        code: "not-compact",
        message:
          `Rooms fill ${(fill * 100).toFixed(0)}% of the ${box.width.toFixed(1)} × ` +
          `${box.height.toFixed(1)} m footprint; the plan has disconnected notches ` +
          `or wasted space.`,
        roomIds: solved.rooms.map((room) => room.id),
      });
    }
  }

  for (const room of plan.rooms) {
    const rectangle = roomById.get(room.id);
    if (!rectangle || room.area_m2 <= 0) continue;
    const solvedArea = rectangle.width_m * rectangle.height_m;
    const drift = Math.abs(solvedArea - room.area_m2) / room.area_m2;
    if (
      drift > ROOM_AREA_DRIFT_TOLERANCE &&
      Math.abs(solvedArea - room.area_m2) > ROOM_AREA_ABSOLUTE_TOLERANCE
    ) {
      diagnostics.push({
        code: "room-area-drift",
        message:
          `Room "${room.id}" solved at ${solvedArea.toFixed(2)} m² but targets ` +
          `${room.area_m2.toFixed(2)} m² (${(drift * 100).toFixed(0)}% drift).`,
        roomIds: [room.id],
      });
    }
  }

  const targetArea = plan.rooms.reduce((total, room) => total + room.area_m2, 0);
  const solvedArea = solved.rooms.reduce(
    (total, room) => total + room.width_m * room.height_m,
    0,
  );
  const drift = targetArea > 0 ? Math.abs(solvedArea - targetArea) / targetArea : 0;
  if (drift > AREA_DRIFT_TOLERANCE) {
    diagnostics.push({
      code: "area-drift",
      message:
        `Solved area ${solvedArea.toFixed(1)} m² differs from target area ` +
        `${targetArea.toFixed(1)} m² by ${(drift * 100).toFixed(0)}% ` +
        `(maximum ${(AREA_DRIFT_TOLERANCE * 100).toFixed(0)}%).`,
      roomIds: plan.rooms.map((room) => room.id),
    });
  }

  return diagnostics;
}
