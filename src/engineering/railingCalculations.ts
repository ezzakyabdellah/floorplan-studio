import { roundLength } from "./units";
import type { EngineeringUnits } from "./types";

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
