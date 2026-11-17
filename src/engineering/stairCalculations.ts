import { inchesToProjectUnits, projectUnitsToInches, roundLength } from "./units";
import type { EngineeringUnits, StairParameters } from "./types";

const MAX_RISER_INCHES = 7.75;

export type StairGeometry = {
  stepCount: number;
  treadCount: number;
  unitRise: number;
  unitRiseExact: number;
  unitRun: number;
  unitRunExact: number;
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

/**
 * Calculates a straight flight from its aggregate rise and run.
 * L/U/spiral projects use the supplied aggregate run at this stage; individual
 * flights, landings, and spiral radii require additional geometry inputs.
 */
export function calculateStairGeometry(
  params: Pick<StairParameters, "totalRise" | "totalRun">,
  units: EngineeringUnits,
): StairGeometry {
  requirePositive("Total rise", params.totalRise);
  requirePositive("Total run", params.totalRun);

  const totalRiseInches = projectUnitsToInches(params.totalRise, units);
  // The smallest whole riser count that doesn't exceed the cited common-code
  // maximum; the building-code audit still checks the exact calculated rise.
  const stepCount = Math.max(
    1,
    Math.ceil(totalRiseInches / MAX_RISER_INCHES - Number.EPSILON),
  );
  const treadCount = Math.max(1, stepCount - 1);
  const unitRise = roundLength(params.totalRise / stepCount, units);
  const unitRun = roundLength(params.totalRun / treadCount, units);
  const stringerLength = roundLength(
    Math.hypot(params.totalRise, params.totalRun),
    units,
  );
  const pitchAngleDegrees =
    (Math.atan2(params.totalRise, params.totalRun) * 180) / Math.PI;

  return {
    stepCount,
    treadCount,
    unitRise,
    unitRiseExact: params.totalRise / stepCount,
    unitRun,
    unitRunExact: params.totalRun / treadCount,
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
    treadThickness: length(1.5),
    riserThickness: length(0.75),
    nosing: length(1),
    headroomCeilingHeight: length(96),
    headroomClearance: length(80),
    balusterSpacingMax: units === "imperial" ? 4 : 100,
    balusterThickness: length(1.5),
  };
}
