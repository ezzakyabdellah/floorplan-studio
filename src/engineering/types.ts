export type EngineeringUnits = "imperial" | "metric";

/**
 * Unit used to display and accept lengths in the UI. Stored dimensions always
 * stay in inches (imperial) or millimetres (metric); metric lengths can be
 * presented in millimetres, centimetres, or metres.
 */
export type LengthUnit = "in" | "mm" | "cm" | "m";
export type ProjectType = "staircase" | "ladder";
export type StairStyle = "straight" | "l-shaped" | "u-shaped" | "spiral";
export type LadderType = "extension" | "single" | "step";
export type SurfaceType = "concrete" | "wood" | "soil" | "other";

/** Linear dimensions use inches in imperial projects and millimetres in metric projects. */
export type StairParameters = {
  style: StairStyle;
  totalRise: number;
  totalRun: number;
  width: number;
  landingLength: number;
  spiralRadius: number;
  spiralTurns: number;
  railingRunOverride: number | null;
  treadThickness: number;
  riserThickness: number;
  nosing: number;
  headroomCeilingHeight: number;
  /** Directly measured minimum clearance; it cannot be derived from ceiling height alone. */
  headroomClearance: number | null;
  balusterSpacingMax: number;
  balusterThickness: number;
};

export type LadderParameters = {
  workingHeight: number;
  ladderType: LadderType;
  surfaceType: SurfaceType;
};

export type CalculatedMetrics = {
  stepCount: number;
  treadCount: number;
  unitRise: number;
  unitRun: number;
  totalWalkingRun: number;
  stringerLength: number;
  pitchAngleDegrees: number;
  plumbCutAngleDegrees: number;
  levelCutAngleDegrees: number;
  headroomClearance: number | null;
  ladderBaseSetback: number;
  ladderAngleDegrees: number;
  ladderRequiredLength: number;
  ladderRoofExtension: number;
  ladderOverlap: number | null;
  ladderSectionCount: number;
  balusterCount: number;
  balusterClearGap: number;
  balusterRailRun: number;
  codeCompliant: boolean;
};

export type ProjectState = {
  projectType: ProjectType;
  units: EngineeringUnits;
  /** Display-only preference; stored lengths remain in `units`. */
  displayUnit: LengthUnit;
  stairParams: StairParameters;
  ladderParams: LadderParameters;
  calculatedMetrics: CalculatedMetrics;
};

export type ProjectParametersPatch = {
  projectType?: ProjectType;
  units?: EngineeringUnits;
  displayUnit?: LengthUnit;
  stairParams?: Partial<StairParameters>;
  ladderParams?: Partial<LadderParameters>;
};

export type AuditFinding = {
  id: string;
  status: "pass" | "warning" | "fail";
  title: string;
  detail: string;
  citation: string;
};

export type AuditReport = {
  findings: AuditFinding[];
  passCount: number;
  warningCount: number;
  failCount: number;
  allPassing: boolean;
  disclaimer: string;
};
