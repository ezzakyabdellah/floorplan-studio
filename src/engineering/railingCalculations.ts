import { roundLength } from "./units";
import { calculateStairGeometry } from "./stairCalculations";
import type { EngineeringUnits, StairParameters } from "./types";

export type BalusterLayout = {
  balusterCount: number;
  clearGap: number;
  clearGapExact: number;
  centreToCentre: number;
  maxAllowedGap: number;
};

export function maximumGuardOpening(units: EngineeringUnits): number {
  return units === "imperial" ? 4 : 100;
}

/** One rail path through the stair profile, including its intermediate landing. */
export function calculateRailingRun(
  params: StairParameters,
  units: EngineeringUnits,
): number {
  if (params.railingRunOverride !== null) {
    return roundLength(params.railingRunOverride, units);
  }

  const geometry = calculateStairGeometry(params, units);
  if (
    (params.style !== "l-shaped" && params.style !== "u-shaped") ||
    geometry.treadCount < 2
  ) {
    return geometry.stringerLength;
  }

  const firstRisers = Math.ceil(geometry.stepCount / 2);
  const secondRisers = geometry.stepCount - firstRisers;
  const firstTreads = Math.ceil(geometry.treadCount / 2);
  const secondTreads = geometry.treadCount - firstTreads;
  const firstRun =
    (geometry.totalWalkingRun * firstTreads) / geometry.treadCount;
  const secondRun =
    (geometry.totalWalkingRun * secondTreads) / geometry.treadCount;
  const firstRise =
    (params.totalRise * firstRisers) / geometry.stepCount;
  const secondRise =
    (params.totalRise * secondRisers) / geometry.stepCount;
  return roundLength(
    Math.hypot(firstRun, firstRise) +
      Math.hypot(secondRun, secondRise) +
      params.landingLength,
    units,
  );
}

/** Treats runLength as the measured rail length, including its end posts. */
export function calculateBalusterSpacing(
  runLength: number,
  requestedMaxGap: number,
  balusterWidth: number,
  units: EngineeringUnits,
): BalusterLayout {
  if (!Number.isFinite(runLength) || runLength <= 0) {
    throw new RangeError("Railing run must be greater than zero.");
  }
  if (!Number.isFinite(requestedMaxGap) || requestedMaxGap <= 0) {
    throw new RangeError("Maximum opening must be greater than zero.");
  }
  if (!Number.isFinite(balusterWidth) || balusterWidth <= 0) {
    throw new RangeError("Baluster width must be greater than zero.");
  }

  const maxAllowedGap = Math.min(
    requestedMaxGap,
    maximumGuardOpening(units),
  );
  let balusterCount = 0;
  while (
    (runLength - balusterCount * balusterWidth) / (balusterCount + 1) >
    maxAllowedGap
  ) {
    balusterCount += 1;
    if (balusterCount > 100_000) {
      throw new RangeError("Railing run is too large to lay out safely.");
    }
  }

  const clearGap =
    (runLength - balusterCount * balusterWidth) / (balusterCount + 1);
  const centreToCentre = clearGap + balusterWidth;

  return {
    balusterCount,
    clearGap: roundLength(clearGap, units),
    clearGapExact: clearGap,
    centreToCentre: roundLength(centreToCentre, units),
    maxAllowedGap,
  };
}
