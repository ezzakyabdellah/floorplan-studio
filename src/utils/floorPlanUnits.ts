import type { FloorPlanUnit } from "../types/floorplan";

/** How many display units make up one foot. */
const UNITS_PER_FOOT: Record<FloorPlanUnit, number> = {
  ft: 1,
  in: 12,
  mm: 304.8,
  cm: 30.48,
  m: 0.3048,
};

export const FLOOR_PLAN_UNIT_OPTIONS: Array<{
  value: FloorPlanUnit;
  label: string;
}> = [
  { value: "ft", label: "Feet · ft" },
  { value: "in", label: "Inches · in" },
  { value: "mm", label: "Metric · mm" },
  { value: "cm", label: "Metric · cm" },
  { value: "m", label: "Metric · m" },
];

export function isFloorPlanUnit(value: unknown): value is FloorPlanUnit {
  return (
    value === "ft" ||
    value === "in" ||
    value === "mm" ||
    value === "cm" ||
    value === "m"
  );
}

export function unitsPerFoot(unit: FloorPlanUnit): number {
  return UNITS_PER_FOOT[unit];
}

export function feetToDisplayLength(value: number, unit: FloorPlanUnit): number {
  return value * UNITS_PER_FOOT[unit];
}

export function displayLengthToFeet(value: number, unit: FloorPlanUnit): number {
  return value / UNITS_PER_FOOT[unit];
}

export function floorPlanUnitLabel(unit: FloorPlanUnit): string {
  return unit;
}

/** Natural spinner increment for each display unit. */
export function floorPlanInputStep(unit: FloorPlanUnit): number {
  switch (unit) {
    case "in":
      return 1;
    case "mm":
      return 10;
    case "cm":
      return 1;
    case "m":
      return 0.01;
    default:
      return 0.1;
  }
}

function decimalsFor(unit: FloorPlanUnit): number {
  switch (unit) {
    case "mm":
      return 0;
    case "in":
    case "cm":
      return 1;
    case "m":
      return 3;
    default:
      return 2;
  }
}

function trimTrailingZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** A number formatted in the selected unit, without a unit suffix. */
export function formatFeetNumber(value: number, unit: FloorPlanUnit): string {
  const scaled = feetToDisplayLength(value, unit);
  const sign = scaled < 0 ? "-" : "";
  const fixed = Math.abs(scaled).toFixed(decimalsFor(unit));
  const text = trimTrailingZeros(fixed) || "0";
  return `${sign}${text}`;
}

/** A plan length formatted in the selected unit, including the unit label. */
export function formatFeetLength(value: number, unit: FloorPlanUnit): string {
  return `${formatFeetNumber(value, unit)} ${unit}`;
}

const GRID_STEPS: Record<FloorPlanUnit, number[]> = {
  ft: [1, 2, 5, 10, 20, 50, 100],
  in: [1, 2, 6, 12, 24, 60, 120, 240, 600, 1200],
  mm: [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000],
  cm: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
  m: [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100],
};

/**
 * Picks a readable grid interval (in display units) so grid lines stay at
 * least `minPixels` apart at the current zoom.
 */
export function gridStepFor(
  unit: FloorPlanUnit,
  pixelsPerUnit: number,
  minPixels = 10,
): number {
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) {
    return GRID_STEPS[unit][0];
  }
  const minimum = minPixels / pixelsPerUnit;
  const steps = GRID_STEPS[unit];
  for (const step of steps) {
    if (step >= minimum) return step;
  }
  return steps[steps.length - 1];
}
