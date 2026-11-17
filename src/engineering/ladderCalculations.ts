import { ceilLength, feetToProjectUnits, inchesToProjectUnits, projectUnitsToFeet, roundLength } from "./units";
import type { EngineeringUnits, LadderParameters } from "./types";

const SETBACK_RATIO = 4;
const ROOF_EXTENSION_INCHES = 36;

export type LadderGeometry = {
  baseSetback: number;
  ladderAngleDegrees: number;
  requiredLength: number;
  roofExtension: number;
  minimumOverlap: number | null;
  sectionCount: number;
};

function minimumExtensionOverlap(requiredLength: number, units: EngineeringUnits) {
  const lengthFeet = projectUnitsToFeet(requiredLength, units);
  // ANSI A14.2 overlap guidance. For lengths beyond the published table, defer
  // to the ladder manufacturer's instructions rather than extrapolating.
  if (lengthFeet <= 36) return feetToProjectUnits(3, units);
  if (lengthFeet <= 48) return feetToProjectUnits(4, units);
  if (lengthFeet <= 60) return feetToProjectUnits(5, units);
  return null;
}

export function calculateLadderGeometry(
  workingHeight: number,
  units: EngineeringUnits,
  ladderType: LadderParameters["ladderType"] = "extension",
): LadderGeometry {
  if (!Number.isFinite(workingHeight) || workingHeight <= 0) {
    throw new RangeError("Working height must be a finite number greater than zero.");
  }

  // Round outward so fractional precision never makes the recommended setback
  // shorter than the 1:4 calculation.
  const baseSetback =
    ladderType === "step"
      ? 0
      : ceilLength(workingHeight / SETBACK_RATIO, units);
  const ladderAngleDegrees =
    (Math.atan2(workingHeight, baseSetback) * 180) / Math.PI;
  const roofExtension =
    ladderType !== "step"
      ? inchesToProjectUnits(ROOF_EXTENSION_INCHES, units)
      : 0;
  const requiredLength = roundLength(
    Math.hypot(workingHeight + roofExtension, baseSetback),
    units,
  );
  const minimumOverlap =
    ladderType === "extension"
      ? minimumExtensionOverlap(requiredLength, units)
      : null;

  return {
    baseSetback,
    ladderAngleDegrees: Number(ladderAngleDegrees.toFixed(2)),
    requiredLength,
    roofExtension,
    minimumOverlap,
    sectionCount: ladderType === "extension" ? 2 : 1,
  };
}

export function defaultLadderParameters(
  units: EngineeringUnits = "imperial",
): LadderParameters {
  return {
    workingHeight: inchesToProjectUnits(144, units),
    ladderType: "extension",
    surfaceType: "concrete",
  };
}
