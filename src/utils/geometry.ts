import type { Opening, Vec2, Wall } from "../types/floorplan";

export type WallInterval = {
  opening: Opening;
  start: number;
  end: number;
};

export type SceneBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

export function wallLength(wall: Wall) {
  return Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
}

export function wallAngle(wall: Wall) {
  return Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
}

export function pointAlongWall(wall: Wall, t: number): Vec2 {
  return {
    x: wall.x1 + (wall.x2 - wall.x1) * t,
    y: wall.y1 + (wall.y2 - wall.y1) * t,
  };
}

export function pointAtDistance(wall: Wall, distance: number): Vec2 {
  const length = wallLength(wall);
  if (length === 0) return { x: wall.x1, y: wall.y1 };
  const t = distance / length;
  return pointAlongWall(wall, t);
}

export function distance(a: Vec2, b: Vec2) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(point: Vec2, wall: Wall) {
  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, { x: wall.x1, y: wall.y1 });
  let t = ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return distance(point, { x: wall.x1 + dx * t, y: wall.y1 + dy * t });
}

export function projectPointOnWall(point: Vec2, wall: Wall) {
  const dx = wall.x2 - wall.x1;
  const dy = wall.y2 - wall.y1;
  const lengthSq = dx * dx + dy * dy;
  const raw =
    lengthSq === 0
      ? 0
      : ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / lengthSq;
  const t = Math.max(0, Math.min(1, raw));
  return {
    t,
    distance: distanceToSegment(point, wall),
    point: { x: wall.x1 + dx * t, y: wall.y1 + dy * t },
  };
}

export function getWallIntervals(
  wall: Wall,
  openings: Opening[],
  includeZeroWidth = false,
): WallInterval[] {
  const length = wallLength(wall);
  if (length <= 0) return [];

  const intervals = openings
    .filter((opening) => opening.wallId === wall.id)
    .map((opening) => {
      const half = opening.width / 2;
      const center = Math.max(0, Math.min(1, opening.positionOnWall)) * length;
      return {
        opening,
        start: Math.max(0, center - half),
        end: Math.min(length, center + half),
      };
    })
    .filter((interval) => includeZeroWidth || interval.end - interval.start > 0.01)
    .sort((a, b) => a.start - b.start);

  return intervals;
}

export function getSolidIntervals(wall: Wall, openings: Opening[]) {
  const length = wallLength(wall);
  const intervals = getWallIntervals(wall, openings);
  const solids: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  for (const interval of intervals) {
    if (interval.start > cursor + 0.01) {
      solids.push({ start: cursor, end: interval.start });
    }
    cursor = Math.max(cursor, interval.end);
  }

  if (cursor < length - 0.01) {
    solids.push({ start: cursor, end: length });
  }

  return solids;
}

export function getSceneBounds(walls: Wall[]): SceneBounds {
  if (walls.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 20,
      maxY: 15,
      width: 20,
      height: 15,
      centerX: 10,
      centerY: 7.5,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const wall of walls) {
    minX = Math.min(minX, wall.x1, wall.x2);
    minY = Math.min(minY, wall.y1, wall.y2);
    maxX = Math.max(maxX, wall.x1, wall.x2);
    maxY = Math.max(maxY, wall.y1, wall.y2);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

export function snapPoint(
  point: Vec2,
  walls: Wall[],
  increment = 0.5,
  endpointTolerance = 0.8,
): Vec2 {
  let best: Vec2 | null = null;
  let bestDistance = endpointTolerance;

  for (const wall of walls) {
    for (const endpoint of [
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    ]) {
      const d = distance(point, endpoint);
      if (d < bestDistance) {
        best = endpoint;
        bestDistance = d;
      }
    }
  }

  if (best) return { ...best };

  return {
    x: Math.round(point.x / increment) * increment,
    y: Math.round(point.y / increment) * increment,
  };
}

export function formatFeet(value: number, precision = 1) {
  return `${value.toFixed(precision)} ft`;
}

export function feetToInches(value: number) {
  return value * 12;
}
