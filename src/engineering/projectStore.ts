import { create } from "zustand";
import { runBuildingCodeAudit } from "./buildingCodeAudit";
import { calculateProjectMetrics } from "./projectCalculations";
import { defaultLadderParameters } from "./ladderCalculations";
import { defaultStairParameters } from "./stairCalculations";
import { convertLength, roundLength } from "./units";
import type {
  AuditReport,
  CalculatedMetrics,
  EngineeringUnits,
  LadderParameters,
  ProjectParametersPatch,
  ProjectState,
  StairParameters,
} from "./types";

const STAIR_LENGTH_FIELDS = [
  "totalRise",
  "totalRun",
  "width",
  "landingLength",
  "spiralRadius",
  "treadThickness",
  "riserThickness",
  "nosing",
  "headroomCeilingHeight",
  "headroomClearance",
  "balusterSpacingMax",
  "balusterThickness",
] as const;
function convertStairParameters(
  params: StairParameters,
  from: EngineeringUnits,
  to: EngineeringUnits,
): StairParameters {
  const converted = { ...params };
  for (const field of STAIR_LENGTH_FIELDS) {
    const value = params[field];
    if (typeof value === "number") {
      converted[field] = convertLength(value, from, to);
    }
  }
  // Keep the guard-opening default at the conservative 4 in / 100 mm in either unit system.
  converted.balusterSpacingMax =
    to === "imperial" ? 4 : 100;
  return converted;
}

function convertLadderParameters(
  params: LadderParameters,
  from: EngineeringUnits,
  to: EngineeringUnits,
): LadderParameters {
  return {
    ...params,
    workingHeight: convertLength(params.workingHeight, from, to),
  };
}

function normalizeStairPatch(
  current: StairParameters,
  patch: Partial<StairParameters>,
  units: EngineeringUnits,
): StairParameters {
  const next = { ...current, ...patch };
  for (const field of STAIR_LENGTH_FIELDS) {
    const value = next[field];
    if (field === "headroomClearance" && value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError(`${field} must be a finite number.`);
    }
    if (
      (field !== "headroomClearance" && value <= 0) ||
      (field === "headroomClearance" && value < 0)
    ) {
      throw new RangeError(`${field} must be greater than zero.`);
    }
    if (value > (units === "imperial" ? 100_000 : 2_540_000)) {
      throw new RangeError(`${field} is outside the supported range.`);
    }
    next[field] = roundLength(value, units);
  }
  if (!["straight", "l-shaped", "u-shaped", "spiral"].includes(next.style)) {
    throw new RangeError("Unknown staircase style.");
  }
  if (!Number.isFinite(next.spiralTurns) || next.spiralTurns <= 0 || next.spiralTurns > 4) {
    throw new RangeError("Spiral turns must be greater than zero and no more than four.");
  }
  next.spiralTurns = Number(next.spiralTurns.toFixed(3));
  if (
    (next.style === "l-shaped" || next.style === "u-shaped") &&
    next.landingLength < next.width
  ) {
    if (patch.landingLength !== undefined) {
      throw new RangeError("Landing length must be at least the stair width.");
    }
    next.landingLength = next.width;
  }
  if (next.style === "spiral" && next.spiralRadius <= next.width / 2) {
    throw new RangeError("Spiral radius must exceed half the stair width.");
  }
  return next;
}

function normalizeLadderPatch(
  current: LadderParameters,
  patch: Partial<LadderParameters>,
  units: EngineeringUnits,
): LadderParameters {
  const next = { ...current, ...patch };
  if (!Number.isFinite(next.workingHeight) || next.workingHeight <= 0) {
    throw new RangeError("Working height must be greater than zero.");
  }
  next.workingHeight = roundLength(next.workingHeight, units);
  if (!["extension", "single", "step"].includes(next.ladderType)) {
    throw new RangeError("Unknown ladder type.");
  }
  if (!["concrete", "wood", "soil", "other"].includes(next.surfaceType)) {
    throw new RangeError("Unknown ladder surface.");
  }
  return next;
}

function withMetrics(project: Omit<ProjectState, "calculatedMetrics">): ProjectState {
  const provisional = {
    ...project,
    calculatedMetrics: {} as CalculatedMetrics,
  };
  const report = runBuildingCodeAudit(provisional);
  return {
    ...provisional,
    calculatedMetrics: calculateProjectMetrics(
      provisional,
      report.failCount === 0 && report.warningCount === 0,
    ),
  };
}

export function createDefaultProjectState(
  units: EngineeringUnits = "imperial",
): ProjectState {
  return withMetrics({
    projectType: "staircase",
    units,
    stairParams: defaultStairParameters(units),
    ladderParams: defaultLadderParameters(units),
  });
}

export type ProjectStore = ProjectState & {
  updateDesignParameters: (
    patch: ProjectParametersPatch,
  ) => { applied: boolean; error?: string };
  auditBuildingCode: () => AuditReport;
  setUnits: (units: EngineeringUnits) => void;
  resetProject: () => void;
};

export const useProjectStore = create<ProjectStore>((set, get) => ({
  ...createDefaultProjectState(),
  updateDesignParameters: (patch) => {
    try {
      const current = get();
      const units = patch.units ?? current.units;
      const baseStairParams =
        units === current.units
          ? current.stairParams
          : convertStairParameters(current.stairParams, current.units, units);
      const baseLadderParams =
        units === current.units
          ? current.ladderParams
          : convertLadderParameters(current.ladderParams, current.units, units);
      const next = withMetrics({
        projectType: patch.projectType ?? current.projectType,
        units,
        stairParams: normalizeStairPatch(
          baseStairParams,
          patch.stairParams ?? {},
          units,
        ),
        ladderParams: normalizeLadderPatch(
          baseLadderParams,
          patch.ladderParams ?? {},
          units,
        ),
      });
      set(next);
      return { applied: true };
    } catch (error) {
      return {
        applied: false,
        error: error instanceof Error ? error.message : "Invalid project update.",
      };
    }
  },
  auditBuildingCode: () => runBuildingCodeAudit(get()),
  setUnits: (units) => {
    get().updateDesignParameters({ units });
  },
  resetProject: () => set(createDefaultProjectState()),
}));
