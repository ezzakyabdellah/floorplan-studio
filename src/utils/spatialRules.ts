import { DEFAULTS, type Opening, type Vec2, type Wall } from "../types/floorplan";
import { distance, distanceToSegment } from "./geometry";

export type ComplianceRule = "egress" | "connectivity";
export type ComplianceStatus = "pass" | "warning" | "fail";

export type ComplianceCheck = {
  id: string;
  rule: ComplianceRule;
  title: string;
  status: ComplianceStatus;
  detail: string;
  relatedId?: string;
};

export type ComplianceReport = {
  checks: ComplianceCheck[];
  passCount: number;
  failCount: number;
  warningCount: number;
  allPassing: boolean;
};

const CONNECT_TOLERANCE = 0.25;

function wallLabel(walls: Wall[], wallId: string) {
  const index = walls.findIndex((wall) => wall.id === wallId);
  return index >= 0 ? `Wall ${index + 1}` : "Wall";
}

function endpointsConnected(
  wall: Wall,
  endpoint: Vec2,
  walls: Wall[],
): boolean {
  for (const other of walls) {
    if (other.id === wall.id) continue;

    if (
      distance(endpoint, { x: other.x1, y: other.y1 }) <= CONNECT_TOLERANCE ||
      distance(endpoint, { x: other.x2, y: other.y2 }) <= CONNECT_TOLERANCE
    ) {
      return true;
    }

    if (distanceToSegment(endpoint, other) <= CONNECT_TOLERANCE) {
      return true;
    }
  }

  return false;
}

function evaluateEgress(
  openings: Opening[],
  walls: Wall[],
): ComplianceCheck[] {
  const doors = openings.filter((opening) => opening.type === "door");
  const minimumInches = DEFAULTS.minDoorWidthInches;

  if (doors.length === 0) {
    return [
      {
        id: "egress-none",
        rule: "egress",
        title: "Doorway egress",
        status: "warning",
        detail: "No doors are present in the plan, so egress cannot be verified.",
      },
    ];
  }

  const failures = doors.filter((door) => door.width * 12 < minimumInches);

  if (failures.length === 0) {
    return [
      {
        id: "egress-pass",
        rule: "egress",
        title: "Doorway egress",
        status: "pass",
        detail: `${doors.length} doorway${doors.length === 1 ? "" : "s"} meet the ${minimumInches} in minimum clear width.`,
      },
    ];
  }

  return failures.map((door) => {
    const inches = door.width * 12;
    return {
      id: `egress-${door.id}`,
      rule: "egress" as const,
      title: "Doorway egress",
      status: "fail" as const,
      detail: `${wallLabel(walls, door.wallId)} has a ${inches.toFixed(1)} in door. Minimum clear width is ${minimumInches} in.`,
      relatedId: door.id,
    };
  });
}

function evaluateConnectivity(walls: Wall[]): ComplianceCheck[] {
  if (walls.length === 0) {
    return [
      {
        id: "connectivity-none",
        rule: "connectivity",
        title: "Wall connectivity",
        status: "warning",
        detail: "The plan has no walls yet. Draw a wall to begin.",
      },
    ];
  }

  const isolated = walls.filter((wall) => {
    const startConnected = endpointsConnected(
      wall,
      { x: wall.x1, y: wall.y1 },
      walls,
    );
    const endConnected = endpointsConnected(
      wall,
      { x: wall.x2, y: wall.y2 },
      walls,
    );
    return !startConnected && !endConnected;
  });

  if (isolated.length === 0) {
    return [
      {
        id: "connectivity-pass",
        rule: "connectivity",
        title: "Wall connectivity",
        status: "pass",
        detail: `${walls.length} wall${walls.length === 1 ? "" : "s"} form a connected structure.`,
      },
    ];
  }

  return isolated.map((wall) => ({
    id: `connectivity-${wall.id}`,
    rule: "connectivity" as const,
    title: "Isolated wall",
    status: "fail" as const,
    detail: `${wallLabel(walls, wall.id)} (${wall.x1.toFixed(1)}, ${wall.y1.toFixed(1)}) to (${wall.x2.toFixed(1)}, ${wall.y2.toFixed(1)}) is not connected to another wall.`,
    relatedId: wall.id,
  }));
}

export function runComplianceChecks(
  walls: Wall[],
  openings: Opening[],
): ComplianceReport {
  const checks = [
    ...evaluateEgress(openings, walls),
    ...evaluateConnectivity(walls),
  ];

  const passCount = checks.filter((check) => check.status === "pass").length;
  const failCount = checks.filter((check) => check.status === "fail").length;
  const warningCount = checks.filter(
    (check) => check.status === "warning",
  ).length;

  return {
    checks,
    passCount,
    failCount,
    warningCount,
    allPassing: failCount === 0 && warningCount === 0,
  };
}
