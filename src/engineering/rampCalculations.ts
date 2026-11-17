export type RampSlope = {
  degrees: number;
  risePer12Run: number;
  gradePercent: number;
  adaCompliant: boolean;
  adaMaximumRatio: "1:12";
  citation: string;
};

const ADA_MAX_RISE_PER_RUN = 1 / 12;

function assertFiniteNonNegative(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
}

export function rampSlopeFromDegrees(degrees: number): RampSlope {
  assertFiniteNonNegative("Angle", degrees);
  if (degrees >= 90) throw new RangeError("Ramp angle must be less than 90°.");
  return slopeFromRatio(Math.tan((degrees * Math.PI) / 180));
}

export function rampSlopeFromRatio(rise: number, run: number): RampSlope {
  assertFiniteNonNegative("Rise", rise);
  if (!Number.isFinite(run) || run <= 0) {
    throw new RangeError("Run must be greater than zero.");
  }
  return slopeFromRatio(rise / run);
}

export function rampSlopeFromGrade(gradePercent: number): RampSlope {
  assertFiniteNonNegative("Grade", gradePercent);
  return slopeFromRatio(gradePercent / 100);
}

function slopeFromRatio(ratio: number): RampSlope {
  return {
    degrees: Number(((Math.atan(ratio) * 180) / Math.PI).toFixed(2)),
    risePer12Run: Number((ratio * 12).toFixed(3)),
    gradePercent: Number((ratio * 100).toFixed(3)),
    adaCompliant: ratio <= ADA_MAX_RISE_PER_RUN + Number.EPSILON,
    adaMaximumRatio: "1:12",
    citation: "2010 ADA Standards for Accessible Design §405.2",
  };
}
