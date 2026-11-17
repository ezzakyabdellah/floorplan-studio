import { inchesToProjectUnits, projectUnitsToInches, roundLength } from "./units";
import type {
  EngineeringUnits,
  StairParameters,
  StairStyle,
} from "./types";

const MAX_RISER_INCHES = 7.75;

export type StairGeometry = {
  stepCount: number;
  treadCount: number;
  unitRise: number;
  unitRiseExact: number;
  unitRun: number;
  unitRunExact: number;
  totalWalkingRun: number;
  stringerLength: number;
  pitchAngleDegrees: number;
  plumbCutAngleDegrees: number;
  levelCutAngleDegrees: number;
};

function requirePositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero.`);
  }
}

/** Calculates aggregate stair geometry; spiral runs use the centerline arc length. */
export function calculateStairGeometry(
  params: Pick<StairParameters, "totalRise" | "totalRun"> &
    Partial<
      Pick<StairParameters, "style" | "spiralRadius" | "spiralTurns">
    >,
  units: EngineeringUnits,
): StairGeometry {
  requirePositive("Total rise", params.totalRise);
  const style: StairStyle = params.style ?? "straight";
  const totalWalkingRun =
    style === "spiral"
      ? 2 *
        Math.PI *
        (params.spiralRadius ?? Number.NaN) *
        (params.spiralTurns ?? 1)
      : params.totalRun;
  requirePositive(
    style === "spiral" ? "Spiral walking-line run" : "Total run",
    totalWalkingRun,
  );

  const totalRiseInches = projectUnitsToInches(params.totalRise, units);
  // The smallest whole riser count that doesn't exceed the cited common-code
  // maximum; the building-code audit still checks the exact calculated rise.
  const stepCount = Math.max(
    1,
    Math.ceil(totalRiseInches / MAX_RISER_INCHES - Number.EPSILON),
  );
  const treadCount = Math.max(1, stepCount - 1);
  const unitRise = roundLength(params.totalRise / stepCount, units);
  const unitRun = roundLength(totalWalkingRun / treadCount, units);
  const stringerLength = roundLength(
    Math.hypot(params.totalRise, totalWalkingRun),
    units,
  );
  const pitchAngleDegrees =
    (Math.atan2(params.totalRise, totalWalkingRun) * 180) / Math.PI;

  return {
    stepCount,
    treadCount,
    unitRise,
    unitRiseExact: params.totalRise / stepCount,
    unitRun,
    unitRunExact: totalWalkingRun / treadCount,
    totalWalkingRun,
    stringerLength,
    pitchAngleDegrees: Number(pitchAngleDegrees.toFixed(2)),
    plumbCutAngleDegrees: Number(pitchAngleDegrees.toFixed(2)),
    levelCutAngleDegrees: Number((90 - pitchAngleDegrees).toFixed(2)),
  };
}

export function defaultStairParameters(
  units: EngineeringUnits = "imperial",
): StairParameters {
  const length = (inches: number) => inchesToProjectUnits(inches, units);
  return {
    style: "straight",
    totalRise: length(108),
    totalRun: length(132),
    width: length(36),
    landingLength: length(36),
    spiralRadius: length(36),
    spiralTurns: 1,
    railingRunOverride: null,
    treadThickness: length(1.5),
    riserThickness: length(0.75),
    nosing: length(1),
    headroomCeilingHeight: length(96),
    headroomClearance: length(80),
    balusterSpacingMax: units === "imperial" ? 4 : 100,
    balusterThickness: length(1.5),
  };
}
