import type {
  SemanticFloorPlan,
  SolvedFloorPlan,
  SolvedRoom,
} from "./floorPlanLayoutSolver";

export type LayoutDiagnostic = {
  code:
    | "room-overlap"
    | "disconnected-geometry"
    | "missing-shared-wall"
    | "no-exterior-wall"
    | "missing-entrance-exterior"
    | "area-drift";
  message: string;
  roomIds: string[];
  link?: { from: string; to: string };
};

const EPSILON = 1e-6;
const AREA_DRIFT_TOLERANCE = 0.2;
const NON_HABITABLE_ROOM = /bath|toilet|closet|wardrobe|storage|utility|laundry|hall|corridor|pantry/i;

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
