import type { EngineeringUnits, LengthUnit } from "./types";

const INCHES_PER_FOOT = 12;
const MM_PER_INCH = 25.4;

const LENGTH_UNITS: readonly LengthUnit[] = ["in", "mm", "cm", "m"];

export function isLengthUnit(value: unknown): value is LengthUnit {
  return typeof value === "string" && LENGTH_UNITS.includes(value as LengthUnit);
}

/**
 * Resolves the unit shown in the UI. Imperial projects always display inches;
 * metric projects use millimetres unless the user picks centimetres or metres.
 */
export function resolveLengthUnit(
  units: EngineeringUnits,
  displayUnit?: LengthUnit | null,
): LengthUnit {
  if (units === "imperial") return "in";
  return displayUnit === "cm" || displayUnit === "m" ? displayUnit : "mm";
}

export function lengthUnitLabel(
  units: EngineeringUnits,
  displayUnit?: LengthUnit | null,
): string {
  return resolveLengthUnit(units, displayUnit);
}

export function lengthUnitName(
  units: EngineeringUnits,
  displayUnit?: LengthUnit | null,
): string {
  switch (resolveLengthUnit(units, displayUnit)) {
    case "in":
      return "inches";
    case "cm":
      return "centimetres";
    case "m":
      return "metres";
    default:
      return "millimetres";
  }
}

/** Converts a stored length (in or mm) to the selected display unit. */
export function displayLength(
  value: number,
  units: EngineeringUnits,
  displayUnit?: LengthUnit | null,
): number {
  if (units === "imperial") return value;
  const unit = resolveLengthUnit(units, displayUnit);
  if (unit === "cm") return value / 10;
  if (unit === "m") return value / 1000;
  return value;
}

/** Converts a displayed length back to the project's stored unit. */
export function projectLengthFromDisplay(
  value: number,
  units: EngineeringUnits,
  displayUnit?: LengthUnit | null,
): number {
  if (units === "imperial") return roundLength(value, units);
  const unit = resolveLengthUnit(units, displayUnit);
  const millimetres =
    unit === "cm" ? value * 10 : unit === "m" ? value * 1000 : value;
  return roundLength(millimetres, units);
}

/** Natural increment for a displayed length input in the selected unit. */
export function displayLengthStep(
  units: EngineeringUnits,
  displayUnit?: LengthUnit | null,
): number {
  switch (resolveLengthUnit(units, displayUnit)) {
    case "in":
      return 1 / 16;
    case "cm":
      return 0.1;
    case "m":
      return 0.001;
    default:
      return 1;
  }
}

export function lengthResolution(units: EngineeringUnits): number {
  return units === "imperial" ? 1 / 16 : 1;
}

/** Round lengths to the precision the project can represent: 1/16 in or 1 mm. */
export function roundLength(value: number, units: EngineeringUnits): number {
  const resolution = lengthResolution(units);
  const rounded = Math.round((value + Number.EPSILON) / resolution) * resolution;
  return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(6));
}

export function ceilLength(value: number, units: EngineeringUnits): number {
  const resolution = lengthResolution(units);
  return Number((Math.ceil((value - Number.EPSILON) / resolution) * resolution).toFixed(6));
}

export function convertLength(
  value: number,
  from: EngineeringUnits,
  to: EngineeringUnits,
): number {
  if (from === to) return roundLength(value, to);
  return roundLength(
    from === "imperial" ? value * MM_PER_INCH : value / MM_PER_INCH,
    to,
  );
}

export function inchesToProjectUnits(
  inches: number,
  units: EngineeringUnits,
): number {
  return roundLength(units === "imperial" ? inches : inches * MM_PER_INCH, units);
}

export function projectUnitsToInches(
  value: number,
  units: EngineeringUnits,
): number {
  return units === "imperial" ? value : value / MM_PER_INCH;
}

export function projectUnitsToFeet(
  value: number,
  units: EngineeringUnits,
): number {
  return projectUnitsToInches(value, units) / INCHES_PER_FOOT;
}

export function feetToProjectUnits(
  feet: number,
  units: EngineeringUnits,
): number {
  return inchesToProjectUnits(feet * INCHES_PER_FOOT, units);
}

/** Formats a stored length using the project's display unit preference. */
export function formatLength(
  value: number,
  units: EngineeringUnits,
  displayUnit?: LengthUnit | null,
): string {
  const unit = resolveLengthUnit(units, displayUnit);
  if (unit === "in") {
    const sixteenths = Math.round(Math.abs(value) * 16);
    const whole = Math.floor(sixteenths / 16);
    let numerator = sixteenths % 16;
    let denominator = 16;
    while (numerator > 0 && numerator % 2 === 0) {
      numerator /= 2;
      denominator /= 2;
    }
    const sign = value < 0 ? "-" : "";
    const fraction = numerator > 0 ? `${numerator}/${denominator}` : "";
    const dimension =
      whole > 0 && fraction
        ? `${whole} ${fraction}`
        : whole > 0
          ? String(whole)
          : fraction || "0";
    return `${sign}${dimension} in`;
  }

  const scaled = displayLength(value, units, unit);
  const decimals = unit === "m" ? 3 : unit === "cm" ? 1 : 0;
  const sign = scaled < 0 ? "-" : "";
  const fixed = Math.abs(scaled).toFixed(decimals);
  const dimension = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  return `${sign}${dimension || "0"} ${unit}`;
}
