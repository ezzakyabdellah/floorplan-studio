import { calculateStairGeometry } from "./stairCalculations";
import { calculateLadderGeometry } from "./ladderCalculations";
import { projectUnitsToFeet } from "./units";
import type { ProjectState } from "./types";
import { getSceneBounds } from "../utils/geometry";
import type { Wall } from "../types/floorplan";

export type Point3 = { x: number; y: number; z: number };

export type StairFlight3D = {
  id: string;
  start: Point3;
  direction: { x: number; z: number };
  run: number;
  rise: number;
  width: number;
  riserCount: number;
  treadCount: number;
};

export type StairLanding3D = {
  center: Point3;
  length: number;
  width: number;
};

export type SpiralTread3D = {
  innerRadius: number;
  outerRadius: number;
  startAngle: number;
  endAngle: number;
  elevation: number;
};

export type Stair3DLayout = {
  flights: StairFlight3D[];
  landings: StairLanding3D[];
  spiralTreads: SpiralTread3D[];
  walkPath: Point3[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  totalRise: number;
  width: number;
  style: ProjectState["stairParams"]["style"];
};

export function estimateStairBoundsFromSketch(
  walls: Wall[],
): { runFeet: number; widthFeet: number } {
  if (walls.length === 0) {
    throw new RangeError("The sketch did not produce any wall segments.");
  }
  const bounds = getSceneBounds(walls);
  const longSpanFeet = Math.max(bounds.width, bounds.height);
  const shortSpanFeet = Math.min(bounds.width, bounds.height);
  if (
    !Number.isFinite(longSpanFeet) ||
    !Number.isFinite(shortSpanFeet) ||
    shortSpanFeet <= 0
  ) {
    throw new RangeError("The sketch has no measurable footprint.");
  }
  return {
    runFeet: longSpanFeet,
    widthFeet: shortSpanFeet,
  };
}

export type Beam3D = {
  start: Point3;
  end: Point3;
  radius: number;
  color: string;
};

export type Ladder3DLayout = {
  rails: Beam3D[];
  rungs: Beam3D[];
  walkPath: Point3[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  workingHeight: number;
  baseSetback: number;
  requiredLength: number;
  roofExtension: number;
};

function toFeet(value: number, project: ProjectState) {
  return projectUnitsToFeet(value, project.units);
}

function splitFlightCounts(stepCount: number, treadCount: number) {
  const firstRisers = Math.ceil(stepCount / 2);
  const firstTreads = Math.ceil(treadCount / 2);
  return [
    { risers: firstRisers, treads: firstTreads },
    { risers: stepCount - firstRisers, treads: treadCount - firstTreads },
  ] as const;
}

export function buildStair3DLayout(project: ProjectState): Stair3DLayout {
  const { stairParams, units } = project;
  const geometry = calculateStairGeometry(stairParams, units);
  const totalRise = toFeet(stairParams.totalRise, project);
  const width = toFeet(stairParams.width, project);
  const run = toFeet(geometry.totalWalkingRun, project);
  const flights: StairFlight3D[] = [];
  const landings: StairLanding3D[] = [];
  const spiralTreads: SpiralTread3D[] = [];

  if (stairParams.style === "spiral") {
    const radius = toFeet(stairParams.spiralRadius, project);
    const innerRadius = Math.max(radius - width / 2, width * 0.08);
    const outerRadius = radius + width / 2;
    const treadCount = Math.max(1, geometry.treadCount);
    const anglePerTread =
      (Math.PI * 2 * stairParams.spiralTurns) / treadCount;
    spiralTreads.push(
      ...Array.from({ length: treadCount }, (_, index) => ({
        innerRadius,
        outerRadius,
        startAngle: -Math.PI / 2 + index * anglePerTread,
        endAngle: -Math.PI / 2 + (index + 1) * anglePerTread,
        elevation: totalRise * ((index + 1) / geometry.stepCount),
      })),
    );
    const sampleCount = Math.max(
      48,
      Math.ceil(treadCount * 8 * stairParams.spiralTurns),
    );
    const walkPath = Array.from({ length: sampleCount + 1 }, (_, index) => {
      const progress = index / sampleCount;
      const angle =
        -Math.PI / 2 +
        progress * Math.PI * 2 * stairParams.spiralTurns;
      return {
        x: radius * Math.cos(angle),
        y: totalRise * progress,
        z: radius * Math.sin(angle),
      };
    });
    return {
      flights,
      landings,
      spiralTreads,
      walkPath,
      bounds: {
        minX: -outerRadius,
        maxX: outerRadius,
        minZ: -outerRadius,
        maxZ: outerRadius,
      },
      totalRise,
      width,
      style: stairParams.style,
    };
  }

  if (stairParams.style === "straight") {
    const startX = -run / 2;
    const startZ = -width / 2;
    flights.push({
      id: "flight-1",
      start: { x: startX, y: 0, z: 0 },
      direction: { x: 1, z: 0 },
      run,
      rise: totalRise,
      width,
      riserCount: geometry.stepCount,
      treadCount: geometry.treadCount,
    });
    return {
      flights,
      landings,
      spiralTreads,
      walkPath: [
        { x: startX, y: 0, z: 0 },
        { x: startX + run, y: totalRise, z: 0 },
      ],
      bounds: {
        minX: startX,
        maxX: startX + run,
        minZ: startZ,
        maxZ: startZ + width,
      },
      totalRise,
      width,
      style: stairParams.style,
    };
  }

  const counts = splitFlightCounts(geometry.stepCount, geometry.treadCount);
  const firstRun = run * (counts[0].treads / geometry.treadCount);
  const secondRun = run * (counts[1].treads / geometry.treadCount);
  const firstRise = totalRise * (counts[0].risers / geometry.stepCount);
  const secondRise = totalRise - firstRise;
  const landingLength = toFeet(stairParams.landingLength, project);

  if (stairParams.style === "l-shaped") {
    const firstStartX = -firstRun / 2;
    const firstEndX = firstStartX + firstRun;
    const landingCenterX = firstEndX + landingLength / 2;
    flights.push(
      {
        id: "flight-1",
        start: { x: firstStartX, y: 0, z: 0 },
        direction: { x: 1, z: 0 },
        run: firstRun,
        rise: firstRise,
        width,
        riserCount: counts[0].risers,
        treadCount: counts[0].treads,
      },
      {
        id: "flight-2",
        start: { x: landingCenterX, y: firstRise, z: width / 2 },
        direction: { x: 0, z: 1 },
        run: secondRun,
        rise: secondRise,
        width,
        riserCount: counts[1].risers,
        treadCount: counts[1].treads,
      },
    );
    landings.push({
      center: { x: landingCenterX, y: firstRise, z: 0 },
      length: landingLength,
      width,
    });
    return {
      flights,
      landings,
      spiralTreads,
      walkPath: [
        { x: firstStartX, y: 0, z: 0 },
        { x: firstEndX, y: firstRise, z: 0 },
        { x: landingCenterX, y: firstRise, z: 0 },
        { x: landingCenterX, y: firstRise, z: width / 2 },
        { x: landingCenterX, y: totalRise, z: width / 2 + secondRun },
      ],
      bounds: {
        minX: firstStartX,
        maxX: firstEndX + landingLength,
        minZ: -width / 2,
        maxZ: width / 2 + secondRun,
      },
      totalRise,
      width,
      style: stairParams.style,
    };
  }

  const gap = width * 0.12;
  const landingStartX = -landingLength / 2;
  const landingEndX = landingLength / 2;
  const firstZ = -(width + gap) / 2;
  const secondZ = (width + gap) / 2;
  const firstStartX = landingStartX - firstRun;
  const secondEndX = landingEndX - secondRun;
  flights.push(
    {
      id: "flight-1",
      start: { x: firstStartX, y: 0, z: firstZ },
      direction: { x: 1, z: 0 },
      run: firstRun,
      rise: firstRise,
      width,
      riserCount: counts[0].risers,
      treadCount: counts[0].treads,
    },
    {
      id: "flight-2",
      start: { x: landingEndX, y: firstRise, z: secondZ },
      direction: { x: -1, z: 0 },
      run: secondRun,
      rise: secondRise,
      width,
      riserCount: counts[1].risers,
      treadCount: counts[1].treads,
    },
  );
  landings.push({
    center: { x: 0, y: firstRise, z: 0 },
    length: landingLength,
    width: width * 2 + gap,
  });
  return {
    flights,
    landings,
    spiralTreads,
    walkPath: [
      { x: firstStartX, y: 0, z: firstZ },
      { x: landingStartX, y: firstRise, z: firstZ },
      { x: 0, y: firstRise, z: 0 },
      { x: landingEndX, y: firstRise, z: secondZ },
      { x: secondEndX, y: totalRise, z: secondZ },
    ],
    bounds: {
      minX: firstStartX,
      maxX: landingEndX,
      minZ: -(width * 2 + gap) / 2,
      maxZ: (width * 2 + gap) / 2,
    },
    totalRise,
    width,
    style: stairParams.style,
  };
}

export function buildLadder3DLayout(project: ProjectState): Ladder3DLayout {
  const { ladderParams, units } = project;
  const workingHeight = toFeet(ladderParams.workingHeight, project);
  const calculated = calculateLadderGeometry(
    ladderParams.workingHeight,
    units,
    ladderParams.ladderType,
  );
  const baseSetback = toFeet(calculated.baseSetback, project);
  const roofExtension = toFeet(calculated.roofExtension, project);
  const halfWidth = 0.75;
  const rails: Beam3D[] = [];
  const rungs: Beam3D[] = [];
  const walkPath: Point3[] = [];

  if (ladderParams.ladderType === "step") {
    const spread = Math.max(0.75, workingHeight * 0.12);
    for (const z of [-halfWidth, halfWidth]) {
      rails.push(
        {
          start: { x: -spread, y: 0, z },
          end: { x: 0, y: workingHeight, z },
          radius: 0.065,
          color: "#b87333",
        },
        {
          start: { x: spread, y: 0, z },
          end: { x: 0, y: workingHeight, z },
          radius: 0.065,
          color: "#b87333",
        },
      );
    }
    const rungCount = Math.max(2, Math.ceil(workingHeight));
    for (let index = 1; index <= rungCount; index += 1) {
      const t = index / (rungCount + 1);
      const y = workingHeight * t;
      const halfSpan = spread * (1 - t);
      rungs.push({
        start: { x: -halfSpan, y, z: 0 },
        end: { x: halfSpan, y, z: 0 },
        radius: 0.045,
        color: "#d19a67",
      });
    }
    walkPath.push(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: workingHeight, z: 0 },
    );
    return {
      rails,
      rungs,
      walkPath,
      bounds: {
        minX: -spread,
        maxX: spread,
        minZ: -halfWidth,
        maxZ: halfWidth,
      },
      workingHeight,
      baseSetback: 0,
      requiredLength: toFeet(calculated.requiredLength, project),
      roofExtension,
    };
  }

  const contactPoint = { x: 0, y: workingHeight, z: 0 };
  const endPoint = {
    x:
      (workingHeight > 0 ? (baseSetback * roofExtension) / workingHeight : 0),
    y: workingHeight + roofExtension,
    z: 0,
  };
  for (const z of [-halfWidth, halfWidth]) {
    rails.push({
      start: { x: -baseSetback, y: 0, z },
      end: endPoint,
      radius: 0.065,
      color: "#b87333",
    });
  }
  const rungCount = Math.max(2, Math.ceil(workingHeight));
  for (let index = 1; index <= rungCount; index += 1) {
    const t = index / (rungCount + 1);
    const y = workingHeight * t;
    const x = -baseSetback * (1 - t);
    rungs.push({
      start: { x, y, z: -halfWidth },
      end: { x, y, z: halfWidth },
      radius: 0.045,
      color: "#d19a67",
    });
  }
  walkPath.push(
    { x: -baseSetback, y: 0, z: 0 },
    contactPoint,
  );
  return {
    rails,
    rungs,
    walkPath,
    bounds: {
      minX: -baseSetback,
      maxX: endPoint.x,
      minZ: -halfWidth,
      maxZ: halfWidth,
    },
    workingHeight,
    baseSetback,
    requiredLength: toFeet(calculated.requiredLength, project),
    roofExtension,
  };
}

export type HeadroomProfile = {
  known: boolean;
  ceilingY: number | null;
  minimumClearance: number | null;
  belowCode: boolean;
  samples: Array<{
    point: Point3;
    clearance: number | null;
    belowCode: boolean;
  }>;
};

/** Assumes the measured minimum clearance is at the upper landing. */
export function calculateHeadroomProfile(
  project: ProjectState,
  layout = buildStair3DLayout(project),
  sampleCount = 32,
): HeadroomProfile {
  const measured = project.stairParams.headroomClearance;
  const eyeHeight = 5.5;
  const minimum = 80 / 12;
  const known = measured !== null;
  const minimumClearance = known ? toFeet(measured, project) : null;
  const ceilingY =
    minimumClearance === null
      ? null
      : layout.totalRise + eyeHeight + minimumClearance;
  const samples: HeadroomProfile["samples"] = [];
  const path = layout.walkPath;
  const divisions = Math.max(1, sampleCount);
  for (let index = 0; index <= divisions; index += 1) {
    const t = index / divisions;
    const pathPosition = t * (path.length - 1);
    const segmentIndex = Math.min(path.length - 2, Math.floor(pathPosition));
    const segmentT = path.length <= 1 ? 0 : pathPosition - segmentIndex;
    const start = path[segmentIndex] ?? path[0];
    const end = path[segmentIndex + 1] ?? start;
    const point = {
      x: start.x + (end.x - start.x) * segmentT,
      y: start.y + (end.y - start.y) * segmentT,
      z: start.z + (end.z - start.z) * segmentT,
    };
    const clearance =
      minimumClearance === null
        ? null
        : minimumClearance + Math.max(0, layout.totalRise - point.y);
    samples.push({
      point,
      clearance,
      belowCode: clearance !== null && clearance < minimum,
    });
  }
  return {
    known,
    ceilingY,
    minimumClearance,
    belowCode:
      minimumClearance !== null && minimumClearance < minimum,
    samples,
  };
}
