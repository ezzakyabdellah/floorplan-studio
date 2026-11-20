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

type WallSegment = {
  axis: "horizontal" | "vertical";
  coordinate: number;
  start: number;
  end: number;
  roomIds: string[];
  wall: Wall;
};

type LayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Envelope = {
  width: number;
  height: number;
};

type LayoutItem = {
  room: SemanticRoom;
  area: number;
};

type SplitCandidate = {
  left: LayoutRect;
  right: LayoutRect;
  splitIndex: number;
  cost: number;
};

type ScoredLayout = {
  order: SemanticRoom[];
  envelope: Envelope;
  rects: Map<string, LayoutRect>;
  satisfiedLinks: number;
  satisfiedWeight: number;
  minCompliant: boolean;
  windowCompliant: boolean;
  aspectCompliant: boolean;
  score: number;
};

const METERS_TO_FEET = 1 / 0.3048;
const FEET_TO_METERS = 0.3048;
const EPSILON = 1e-6;
const MIN_ROOM_DIMENSION_M = 1;
const MIN_LAYOUT_AREA_M2 = MIN_ROOM_DIMENSION_M * MIN_ROOM_DIMENSION_M;
const MIN_OPENING_WIDTH_M = 0.6;
const DOOR_WIDTH_M = 0.9;
const OPENING_WIDTH_M = 1.5;
const WINDOW_WIDTH_M = 1.2;
const OPENING_END_CLEARANCE_M = 0.05;
const OPENING_SPACING_M = 0.25;
const MIN_SHARED_WALL_M =
  MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2;

const LINK_BONUS = 5_000_000;
const MISSING_LINK_PENALTY = 250_000;
const ASPECT_HARD_PENALTY = 120_000;
const MIN_DIMENSION_PENALTY = 1_500_000;
const WINDOW_REQUEST_PENALTY = 150_000;
const WINDOW_CAPACITY_PENALTY = 120_000;
const AREA_ERROR_WEIGHT = 40_000;
const ENTRANCE_FRONT_PENALTY = 2_000_000;
const ENTRANCE_SIDE_PENALTY = 60_000;

const CIRCULATION_ROOM = /hall|corridor|landing|stair|passage|foyer|entry|entrance|vestibule/i;
const ZONE_ORDER: RoomZone[] = ["front", "core", "service", "private"];

function compareStrings(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function meterToFeet(value: number) {
  return Number((value * METERS_TO_FEET).toFixed(6));
}

function roundMeters(value: number) {
  return Number(value.toFixed(6));
}

function isCirculationRoom(room: SemanticRoom) {
  return CIRCULATION_ROOM.test(`${room.id} ${room.type}`);
}

function layoutAreaOf(room: SemanticRoom) {
  return Math.max(room.area_m2, MIN_LAYOUT_AREA_M2);
}

function zoneRank(room: SemanticRoom) {
  return ZONE_ORDER.indexOf(room.zone);
}

function sharedEdgeLength(a: LayoutRect, b: LayoutRect) {
  const verticalTouch =
    Math.abs(a.x + a.width - b.x) < EPSILON ||
    Math.abs(b.x + b.width - a.x) < EPSILON;
  const horizontalTouch =
    Math.abs(a.y + a.height - b.y) < EPSILON ||
    Math.abs(b.y + b.height - a.y) < EPSILON;
  const verticalOverlap =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const horizontalOverlap =
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  if (verticalTouch) return Math.max(0, verticalOverlap);
  if (horizontalTouch) return Math.max(0, horizontalOverlap);
  return 0;
}

function touchesEnvelope(rect: LayoutRect, envelope: Envelope) {
  return (
    Math.abs(rect.x) < EPSILON ||
    Math.abs(rect.y) < EPSILON ||
    Math.abs(rect.x + rect.width - envelope.width) < EPSILON ||
    Math.abs(rect.y + rect.height - envelope.height) < EPSILON
  );
}

/**
 * Usable exterior length for windows, measured against the building envelope.
 */
function exteriorWindowLength(rect: LayoutRect, envelope: Envelope) {
  let length = 0;
  if (Math.abs(rect.x) < EPSILON) length += rect.height;
  if (Math.abs(rect.x + rect.width - envelope.width) < EPSILON) {
    length += rect.height;
  }
  if (Math.abs(rect.y) < EPSILON) length += rect.width;
  if (Math.abs(rect.y + rect.height - envelope.height) < EPSILON) {
    length += rect.width;
  }
  return length;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed: number) {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function buildAdjacency(plan: SemanticFloorPlan) {
  const adjacency = new Map<string, string[]>();
  for (const room of plan.rooms) adjacency.set(room.id, []);
  for (const link of plan.links) {
    adjacency.get(link.from)?.push(link.to);
    adjacency.get(link.to)?.push(link.from);
  }
  return adjacency;
}

/**
 * Orders rooms by walking the circulation graph from the entrance. Keeping the
 * entrance first anchors it in the top-left tile so the main door always has
 * an exterior wall.
 */
function buildSeedOrders(plan: SemanticFloorPlan): SemanticRoom[][] {
  const byId = new Map(plan.rooms.map((room) => [room.id, room]));
  const adjacency = buildAdjacency(plan);
  const sorters: Array<(a: string, b: string) => number> = [
    (a, b) =>
      (byId.get(b)?.area_m2 ?? 0) - (byId.get(a)?.area_m2 ?? 0) ||
      compareStrings(a, b),
    (a, b) => {
      const roomA = byId.get(a);
      const roomB = byId.get(b);
      if (!roomA || !roomB) return compareStrings(a, b);
      return (
        zoneRank(roomA) - zoneRank(roomB) ||
        roomB.area_m2 - roomA.area_m2 ||
        compareStrings(a, b)
      );
    },
    (a, b) => compareStrings(a, b),
  ];

  const orders: SemanticRoom[][] = [];
  const seen = new Set<string>();
  const add = (ids: string[]) => {
    const key = ids.join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    orders.push(ids.map((id) => byId.get(id)!).filter(Boolean));
  };

  for (const sorter of sorters) {
    const visited = new Set<string>([plan.entrance_room]);
    const queue = [plan.entrance_room];
    const breadthFirst: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      breadthFirst.push(id);
      const next = [...(adjacency.get(id) ?? [])]
        .filter((neighbour) => !visited.has(neighbour))
        .sort(sorter);
      for (const neighbour of next) {
        visited.add(neighbour);
        queue.push(neighbour);
      }
    }
    for (const room of plan.rooms) {
      if (!visited.has(room.id)) breadthFirst.push(room.id);
    }
    add(breadthFirst);

    const visitedDepthFirst = new Set<string>();
    const depthFirst: string[] = [];
    const visit = (id: string) => {
      if (visitedDepthFirst.has(id)) return;
      visitedDepthFirst.add(id);
      depthFirst.push(id);
      const next = [...(adjacency.get(id) ?? [])]
        .filter((neighbour) => !visitedDepthFirst.has(neighbour))
        .sort(sorter);
      for (const neighbour of next) visit(neighbour);
    };
    visit(plan.entrance_room);
    for (const room of plan.rooms) visit(room.id);
    add(depthFirst);
  }

  return orders;
}

function buildRandomOrders(
  plan: SemanticFloorPlan,
  count: number,
  random: () => number,
  base: SemanticRoom[],
): SemanticRoom[][] {
  if (plan.rooms.length <= 1) return [];
  const orders: SemanticRoom[][] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    const order = [...base];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      if (swapIndex === 0) continue;
      [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
    }
    orders.push(order);
  }
  return orders;
}

function makeEnvelope(
  plan: SemanticFloorPlan,
  aspect: number,
  grid: number,
): Envelope {
  const total = plan.rooms.reduce((sum, room) => sum + layoutAreaOf(room), 0);
  const targetWidth = Math.sqrt(total * aspect);
  let best: { width: number; height: number; cost: number } | null = null;

  for (let delta = -2; delta <= 2; delta += 1) {
    const width = Math.max(
      grid * 2,
      Math.max(1, Math.round(targetWidth / grid) + delta) * grid,
    );
    const height = Math.max(
      grid * 2,
      Math.ceil((total / width) / grid) * grid,
    );
    const excess = width * height - total;
    const ratio = width / height;
    const cost = (excess / Math.max(total, EPSILON)) * 10 +
      Math.abs(ratio - aspect) * 0.5;
    if (!best || cost < best.cost) best = { width, height, cost };
  }

  return {
    width: roundMeters(best!.width),
    height: roundMeters(best!.height),
  };
}

function regionCost(rect: LayoutRect) {
  const short = Math.max(EPSILON, Math.min(rect.width, rect.height));
  const ratio = Math.max(rect.width, rect.height) / short;
  return Math.max(0, ratio - 2.2) ** 2 * 5 + (ratio - 1.2) ** 2 * 0.3;
}

function clampSplit(
  value: number,
  minimum: number,
  maximum: number,
  grid: number,
) {
  const snapped = Number((Math.round(value / grid) * grid).toFixed(6));
  return Math.min(maximum, Math.max(minimum, snapped));
}

function placeRange(
  items: LayoutItem[],
  prefix: number[],
  start: number,
  end: number,
  rect: LayoutRect,
  grid: number,
  out: Map<string, LayoutRect>,
  random: () => number,
  jitter: number,
) {
  if (end - start === 1) {
    out.set(items[start].room.id, { ...rect });
    return;
  }

  const groupArea = prefix[end] - prefix[start];
  const candidates: SplitCandidate[] = [];

  for (const axis of ["x", "y"] as const) {
    if (axis === "x" && rect.width < grid * 2) continue;
    if (axis === "y" && rect.height < grid * 2) continue;
    for (let splitIndex = start + 1; splitIndex < end; splitIndex += 1) {
      const fraction = (prefix[splitIndex] - prefix[start]) / groupArea;
      let left: LayoutRect;
      let right: LayoutRect;
      if (axis === "x") {
        const split = clampSplit(
          rect.x + rect.width * fraction,
          rect.x + grid,
          rect.x + rect.width - grid,
          grid,
        );
        if (split <= rect.x + EPSILON || split >= rect.x + rect.width - EPSILON) {
          continue;
        }
        left = { ...rect, width: split - rect.x };
        right = { ...rect, x: split, width: rect.x + rect.width - split };
      } else {
        const split = clampSplit(
          rect.y + rect.height * fraction,
          rect.y + grid,
          rect.y + rect.height - grid,
          grid,
        );
        if (split <= rect.y + EPSILON || split >= rect.y + rect.height - EPSILON) {
          continue;
        }
        left = { ...rect, height: split - rect.y };
        right = { ...rect, y: split, height: rect.y + rect.height - split };
      }
      candidates.push({
        left,
        right,
        splitIndex,
        cost:
          regionCost(left) +
          regionCost(right) +
          Math.abs(fraction - 0.5) * 0.0001,
      });
    }
  }

  let best: SplitCandidate | null = null;
  if (candidates.length > 0) {
    if (jitter > 0 && candidates.length > 1 && random() < jitter) {
      candidates.sort((a, b) => a.cost - b.cost);
      best = candidates[Math.floor(random() * Math.min(4, candidates.length))];
    } else {
      for (const candidate of candidates) {
        if (!best || candidate.cost < best.cost) best = candidate;
      }
    }
  }

  if (!best) {
    const splitIndex = start + Math.max(1, Math.floor((end - start) / 2));
    const fraction = (prefix[splitIndex] - prefix[start]) / groupArea;
    if (rect.width >= rect.height && rect.width >= grid * 2) {
      const split = clampSplit(
        rect.x + rect.width * fraction,
        rect.x + grid,
        rect.x + rect.width - grid,
        grid,
      );
      best = {
        left: { ...rect, width: split - rect.x },
        right: { ...rect, x: split, width: rect.x + rect.width - split },
        splitIndex,
        cost: 0,
      };
    } else {
      const split = clampSplit(
        rect.y + rect.height * fraction,
        rect.y + grid,
        rect.y + rect.height - grid,
        grid,
      );
      best = {
        left: { ...rect, height: split - rect.y },
        right: { ...rect, y: split, height: rect.y + rect.height - split },
        splitIndex,
        cost: 0,
      };
    }
  }

  placeRange(
    items,
    prefix,
    start,
    best.splitIndex,
    best.left,
    grid,
    out,
    random,
    jitter,
  );
  placeRange(
    items,
    prefix,
    best.splitIndex,
    end,
    best.right,
    grid,
    out,
    random,
    jitter,
  );
}

function layoutOrder(
  order: SemanticRoom[],
  envelope: Envelope,
  grid: number,
  random: () => number,
  jitter: number,
): Map<string, LayoutRect> {
  const items: LayoutItem[] = order.map((room) => ({
    room,
    area: layoutAreaOf(room),
  }));
  const targetArea = items.reduce((sum, item) => sum + item.area, 0);
  const scale = (envelope.width * envelope.height) / Math.max(targetArea, EPSILON);
  for (const item of items) item.area *= scale;

  const prefix = [0];
  for (let index = 0; index < items.length; index += 1) {
    prefix.push(prefix[index] + items[index].area);
  }

  const rects = new Map<string, LayoutRect>();
  placeRange(
    items,
    prefix,
    0,
    items.length,
    { x: 0, y: 0, width: envelope.width, height: envelope.height },
    grid,
    rects,
    random,
    jitter,
  );
  return rects;
}

function linkWeight(
  link: SemanticLink,
  byId: Map<string, SemanticRoom>,
  entranceRoom: string,
) {
  const from = byId.get(link.from);
  const to = byId.get(link.to);
  if (!from || !to) return 1;
  let weight = 1;
  if (link.from === entranceRoom || link.to === entranceRoom) weight += 10;
  if (
    (from && from.id !== entranceRoom && isCirculationRoom(from)) ||
    (to && to.id !== entranceRoom && isCirculationRoom(to))
  ) {
    weight += 2;
  }
  return weight;
}

function scoreLayout(
  plan: SemanticFloorPlan,
  rects: Map<string, LayoutRect>,
  envelope: Envelope,
) {
  let satisfiedLinks = 0;
  let satisfiedWeight = 0;
  let score = 0;
  const byId = new Map(plan.rooms.map((room) => [room.id, room]));

  for (const link of plan.links) {
    const from = rects.get(link.from);
    const to = rects.get(link.to);
    const overlap = from && to ? sharedEdgeLength(from, to) : 0;
    if (overlap >= MIN_SHARED_WALL_M - EPSILON) {
      satisfiedLinks += 1;
      satisfiedWeight += linkWeight(link, byId, plan.entrance_room);
      score += LINK_BONUS + Math.min(overlap, 3) * 50_000;
    } else {
      score -= MISSING_LINK_PENALTY;
    }
  }

  let minCompliant = true;
  let windowCompliant = true;
  let aspectCompliant = true;
  for (const room of plan.rooms) {
    const rect = rects.get(room.id);
    if (!rect) {
      minCompliant = false;
      windowCompliant = false;
      aspectCompliant = false;
      score -= LINK_BONUS;
      continue;
    }
    const short = Math.max(EPSILON, Math.min(rect.width, rect.height));
    const ratio = Math.max(rect.width, rect.height) / short;
    const circulation = isCirculationRoom(room);
    const maxRatio = circulation ? 6 : 2.5;
    const targetRatio = circulation ? 2.2 : 1.2;
    const minimumDimension = circulation ? 1.1 : MIN_ROOM_DIMENSION_M;

    if (ratio > maxRatio) {
      score -= (ratio - maxRatio) ** 2 * ASPECT_HARD_PENALTY;
    }
    score -= (ratio - targetRatio) ** 2 * 500;
    if (short < minimumDimension - EPSILON) {
      score -= (minimumDimension - short) ** 2 * MIN_DIMENSION_PENALTY;
    }
    if (short < MIN_ROOM_DIMENSION_M - EPSILON) {
      minCompliant = false;
    }
    if (ratio > 2 + EPSILON) {
      aspectCompliant = false;
    }

    const solvedArea = rect.width * rect.height;
    const areaError =
      Math.abs(solvedArea - room.area_m2) /
      Math.max(room.area_m2, EPSILON);
    score -= areaError * AREA_ERROR_WEIGHT;

    if (room.windows > 0 && !touchesEnvelope(rect, envelope)) {
      windowCompliant = false;
      score -= WINDOW_REQUEST_PENALTY;
    }
    if (room.windows > 0) {
      const available = exteriorWindowLength(rect, envelope);
      if (available < MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2) {
        windowCompliant = false;
      }
      const required =
        room.windows * (WINDOW_WIDTH_M + OPENING_SPACING_M);
      if (available < required) {
        score -= (required - available) * WINDOW_CAPACITY_PENALTY;
      }
    }
  }

  const entrance = rects.get(plan.entrance_room);
  if (!entrance) {
    score -= ENTRANCE_FRONT_PENALTY;
  } else {
    if (entrance.y > EPSILON) score -= ENTRANCE_FRONT_PENALTY;
    if (entrance.x > EPSILON) score -= ENTRANCE_SIDE_PENALTY;
  }

  return {
    satisfiedLinks,
    satisfiedWeight,
    minCompliant,
    windowCompliant,
    aspectCompliant,
    score,
  };
}

function evaluateLayout(
  plan: SemanticFloorPlan,
  order: SemanticRoom[],
  aspect: number,
  grid: number,
  random: () => number,
  jitter = 0,
): ScoredLayout {
  const envelope = makeEnvelope(plan, aspect, grid);
  const rects = layoutOrder(order, envelope, grid, random, jitter);
  return {
    order,
    envelope,
    rects,
    ...scoreLayout(plan, rects, envelope),
  };
}

function isBetterLayout(a: ScoredLayout, b: ScoredLayout) {
  if (a.minCompliant !== b.minCompliant) return a.minCompliant;
  if (a.windowCompliant !== b.windowCompliant) return a.windowCompliant;
  if (a.satisfiedWeight !== b.satisfiedWeight) {
    return a.satisfiedWeight > b.satisfiedWeight;
  }
  if (a.satisfiedLinks !== b.satisfiedLinks) {
    return a.satisfiedLinks > b.satisfiedLinks;
  }
  if (a.aspectCompliant !== b.aspectCompliant) return a.aspectCompliant;
  return a.score > b.score;
}

function findBestLayout(plan: SemanticFloorPlan): ScoredLayout {
  const grid = plan.grid_unit_m;
  const seedOrders = buildSeedOrders(plan);
  const random = createRandom(hashString(JSON.stringify(plan)));
  const orders = [
    ...seedOrders,
    ...buildRandomOrders(
      plan,
      plan.rooms.length <= 12 ? 160 : 48,
      random,
      seedOrders[0] ?? plan.rooms,
    ),
  ];
  const aspects = [
    0.6, 0.7, 0.8, 0.85, 0.9, 1, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7,
  ];

  let best: ScoredLayout | null = null;
  for (const order of orders) {
    for (const aspect of aspects) {
      const candidate = evaluateLayout(plan, order, aspect, grid, random);
      if (!best || isBetterLayout(candidate, best)) best = candidate;
      for (let variant = 0; variant < 3; variant += 1) {
        const jittered = evaluateLayout(
          plan,
          order,
          aspect,
          grid,
          random,
          0.4,
        );
        if (isBetterLayout(jittered, best)) best = jittered;
      }
    }
  }
  if (!best) {
    best = evaluateLayout(plan, plan.rooms, 1, grid, random);
  }

  const localAspects = [...new Set([best.envelope.width / best.envelope.height, 1, 0.85, 1.15])];
  const tried = new Set<string>();
  for (let pass = 0; pass < 3; pass += 1) {
    let improved = false;
    const order = best.order;
    for (let first = 1; first < order.length - 1; first += 1) {
      for (let second = first + 1; second < order.length; second += 1) {
        const swapped = [...order];
        [swapped[first], swapped[second]] = [swapped[second], swapped[first]];
        const key = swapped.map((room) => room.id).join("\u0000");
        if (tried.has(key)) continue;
        tried.add(key);
        for (const aspect of localAspects) {
          const candidate = evaluateLayout(
            plan,
            swapped,
            aspect,
            grid,
            random,
          );
          if (isBetterLayout(candidate, best)) {
            best = candidate;
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }

  return best;
}

function buildRoomRectangles(plan: SemanticFloorPlan): SolvedRoom[] {
  const layout = findBestLayout(plan);
  return plan.rooms.map((room) => {
    const rect = layout.rects.get(room.id)!;
    return {
      id: room.id,
      type: room.type,
      zone: room.zone,
      area_m2: room.area_m2,
      x_m: roundMeters(rect.x),
      y_m: roundMeters(rect.y),
      width_m: roundMeters(rect.width),
      height_m: roundMeters(rect.height),
    };
  });
}

function roomEdges(rooms: SolvedRoom[]) {
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
  const groups = new Map<string, ReturnType<typeof roomEdges>>();
  for (const edge of roomEdges(rooms)) {
    const key = `${edge.axis}:${edge.coordinate.toFixed(6)}`;
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }

  const segments: WallSegment[] = [];
  for (const edges of groups.values()) {
    const { axis, coordinate } = edges[0];
    const breakpoints = [
      ...new Set(edges.flatMap(({ start, end }) => [start, end])),
    ].sort((a, b) => a - b);
    for (let index = 0; index < breakpoints.length - 1; index += 1) {
      const start = breakpoints[index];
      const end = breakpoints[index + 1];
      if (end - start < EPSILON) continue;
      const midpoint = (start + end) / 2;
      const roomIds = [
        ...new Set(
          edges
            .filter(
              (edge) =>
                midpoint > edge.start - 1e-7 &&
                midpoint < edge.end + 1e-7,
            )
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
  const lengthFeet = (segment.end - segment.start) * METERS_TO_FEET;
  const centerFeet = centerMeters * METERS_TO_FEET;
  return {
    id,
    wallId: segment.wall.id,
    type,
    positionOnWall: Math.max(0, Math.min(1, centerFeet / lengthFeet)),
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
  if (width < requestedWidth - EPSILON) {
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
      (opening.width + widthFeet) / 2 +
        OPENING_SPACING_M * METERS_TO_FEET -
        EPSILON
    );
  });
}

function doorReachableRooms(
  entranceRoomId: string,
  segments: WallSegment[],
  openings: Opening[],
) {
  const roomsByWall = new Map(
    segments.map((segment) => [segment.wall.id, segment.roomIds]),
  );
  const graph = new Map<string, Set<string>>();
  for (const segment of segments) {
    for (const roomId of segment.roomIds) {
      if (!graph.has(roomId)) graph.set(roomId, new Set());
    }
  }
  for (const opening of openings) {
    if (opening.type !== "door") continue;
    const roomIds = roomsByWall.get(opening.wallId) ?? [];
    if (roomIds.length !== 2) continue;
    graph.get(roomIds[0])?.add(roomIds[1]);
    graph.get(roomIds[1])?.add(roomIds[0]);
  }

  const reachable = new Set([entranceRoomId]);
  const queue = [entranceRoomId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const neighbour of graph.get(id) ?? []) {
      if (reachable.has(neighbour)) continue;
      reachable.add(neighbour);
      queue.push(neighbour);
    }
  }
  return reachable;
}

/**
 * A compact tiling can still leave a room without a door when the requested
 * link graph cannot be realized. Rather than shipping a sealed room, connect it
 * to an adjacent reachable room and record a warning.
 */
function ensureReachability(
  plan: SemanticFloorPlan,
  segments: WallSegment[],
  openings: Opening[],
  warnings: string[],
) {
  const roomById = new Map(plan.rooms.map((room) => [room.id, room]));
  const failed = new Set<string>();

  for (let guard = 0; guard <= plan.rooms.length * 2; guard += 1) {
    const reachable = doorReachableRooms(
      plan.entrance_room,
      segments,
      openings,
    );
    const missingRooms = plan.rooms.filter(
      (room) => !reachable.has(room.id) && !failed.has(room.id),
    );
    if (missingRooms.length === 0) return;

    let progressed = false;
    for (const missing of missingRooms) {
      const candidates = segments
        .filter(
          (segment) =>
            segment.roomIds.includes(missing.id) &&
            segment.roomIds.some((roomId) => reachable.has(roomId)) &&
            segment.end - segment.start >= MIN_SHARED_WALL_M,
        )
        .sort((a, b) => {
          const otherA = a.roomIds.find((id) => id !== missing.id) ?? "";
          const otherB = b.roomIds.find((id) => id !== missing.id) ?? "";
          const circulationA = isCirculationRoom(roomById.get(otherA)!);
          const circulationB = isCirculationRoom(roomById.get(otherB)!);
          return (
            Number(circulationB) - Number(circulationA) ||
            b.end - b.start - (a.end - a.start) ||
            compareStrings(otherA, otherB)
          );
        });

      let placed = false;
      for (const segment of candidates) {
        const otherId =
          segment.roomIds.find((roomId) => roomId !== missing.id) ?? "";
        const width = placeWidth(
          DOOR_WIDTH_M,
          segment,
          [],
          `The access door for "${missing.id}"`,
        );
        if (width === null) continue;
        for (const fraction of [0.5, 0.3, 0.7]) {
          const center = (segment.end - segment.start) * fraction;
          if (openingOverlaps(openings, segment, center, width)) continue;
          openings.push(
            toOpening(
              segment,
              "door",
              width,
              `ai-access-${openings.length + 1}`,
              center,
            ),
          );
          warnings.push(
            `Room "${missing.id}" had no usable door and was connected to "${otherId}".`,
          );
          placed = true;
          progressed = true;
          break;
        }
        if (placed) break;
      }
      if (placed) break;
    }

    if (!progressed) {
      for (const missing of missingRooms) {
        failed.add(missing.id);
        warnings.push(
          `Room "${missing.id}" could not be connected to the circulation.`,
        );
      }
      return;
    }
  }
}

function windowBlockedIntervals(openings: Opening[], segment: WallSegment) {
  const length = segment.end - segment.start;
  return openings
    .filter((opening) => opening.wallId === segment.wall.id)
    .map((opening) => {
      const center = opening.positionOnWall * length;
      const half = (opening.width * FEET_TO_METERS) / 2;
      return [
        center - half - OPENING_SPACING_M,
        center + half + OPENING_SPACING_M,
      ] as [number, number];
    });
}

function tryPlaceWindow(
  openings: Opening[],
  segment: WallSegment,
  id: string,
) {
  const length = segment.end - segment.start;
  const blocked = windowBlockedIntervals(openings, segment);
  const widths = [WINDOW_WIDTH_M, 1.1, 1, 0.9, 0.8, 0.7, 0.6];
  for (const requestedWidth of widths) {
    const width = Math.min(
      requestedWidth,
      length - OPENING_END_CLEARANCE_M * 2,
    );
    if (width < MIN_OPENING_WIDTH_M - EPSILON) continue;
    const maxStart = length - width - OPENING_END_CLEARANCE_M;
    for (
      let start = OPENING_END_CLEARANCE_M;
      start <= maxStart + EPSILON;
      start += 0.1
    ) {
      const end = start + width;
      const overlaps = blocked.some(
        ([blockedStart, blockedEnd]) =>
          start < blockedEnd - EPSILON && end > blockedStart + EPSILON,
      );
      if (overlaps) continue;
      const center = start + width / 2;
      return {
        opening: toOpening(segment, "window", width, id, center),
        width,
      };
    }
  }
  return null;
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
      (segment) =>
        segment.roomIds.length === 1 && segment.roomIds[0] === room.id,
    );
    const fitsWindow = (segment: WallSegment) =>
      segment.end - segment.start >=
      MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2;
    const candidates = roomExterior
      .filter(fitsWindow)
      .sort(
        (a, b) =>
          Number(a.wall.id === entranceWallId) -
            Number(b.wall.id === entranceWallId) ||
          b.end - b.start - (a.end - a.start) ||
          compareStrings(a.wall.id, b.wall.id),
      );

    let placed = 0;
    for (let index = 0; index < requested; index += 1) {
      const id = `ai-window-${openings.filter((opening) => opening.type === "window").length + 1}`;
      let result: ReturnType<typeof tryPlaceWindow> = null;
      for (const segment of candidates) {
        result = tryPlaceWindow(openings, segment, id);
        if (result) break;
      }
      if (!result) {
        warnings.push(
          `Room "${room.id}" requested ${requested} window(s), but only ${placed} could fit on exterior walls.`,
        );
        break;
      }
      openings.push(result.opening);
      placed += 1;
      if (result.width < WINDOW_WIDTH_M * 0.75) {
        warnings.push(
          `A window for room "${room.id}" was narrowed to ${result.width.toFixed(2)} m.`,
        );
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
        segment.end - segment.start >=
          MIN_OPENING_WIDTH_M + OPENING_END_CLEARANCE_M * 2,
    )
    .sort((a, b) => {
      const aAtFront =
        a.axis === "horizontal" && Math.abs(a.coordinate) < EPSILON;
      const bAtFront =
        b.axis === "horizontal" && Math.abs(b.coordinate) < EPSILON;
      return (
        Number(bAtFront) - Number(aAtFront) ||
        b.end - b.start - (a.end - a.start)
      );
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
    if (
      openingOverlaps(
        openings,
        candidate,
        openingCenterMeters(candidate),
        width,
      )
    ) {
      warnings.push(
        `The opening between "${link.from}" and "${link.to}" was omitted because it overlaps another opening.`,
      );
      continue;
    }
    openings.push(
      toOpening(
        candidate,
        "door",
        width,
        `ai-link-${openings.length + 1}`,
      ),
    );
  }

  ensureReachability(plan, segments, openings, warnings);
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
