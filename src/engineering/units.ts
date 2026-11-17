import type { EngineeringUnits } from "./types";

const INCHES_PER_FOOT = 12;
const MM_PER_INCH = 25.4;

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

export function formatLength(value: number, units: EngineeringUnits): string {
  if (units === "metric") return `${Math.round(value)} mm`;
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
