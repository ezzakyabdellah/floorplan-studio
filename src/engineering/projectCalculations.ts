import {
  calculateBalusterSpacing,
  calculateRailingRun,
} from "./railingCalculations";
import { calculateLadderGeometry } from "./ladderCalculations";
import { calculateStairGeometry } from "./stairCalculations";
import { maximumGuardOpening } from "./railingCalculations";
import type { CalculatedMetrics, ProjectState } from "./types";

export function calculateProjectMetrics(
  project: Pick<ProjectState, "projectType" | "units" | "stairParams" | "ladderParams">,
  codeCompliant = false,
): CalculatedMetrics {
  const stairs = calculateStairGeometry(project.stairParams, project.units);
  const ladder = calculateLadderGeometry(
    project.ladderParams.workingHeight,
    project.units,
    project.ladderParams.ladderType,
  );
  const balusterRailRun = calculateRailingRun(
    project.stairParams,
    project.units,
  );
  const balusters = calculateBalusterSpacing(
    balusterRailRun,
    Math.min(
      project.stairParams.balusterSpacingMax,
      maximumGuardOpening(project.units),
    ),
    project.stairParams.balusterThickness,
    project.units,
  );

  return {
    ...stairs,
    headroomClearance: project.stairParams.headroomClearance,
    ladderBaseSetback: ladder.baseSetback,
    ladderAngleDegrees: ladder.ladderAngleDegrees,
    ladderRequiredLength: ladder.requiredLength,
    ladderRoofExtension: ladder.roofExtension,
    ladderOverlap: ladder.minimumOverlap,
    ladderSectionCount: ladder.sectionCount,
    balusterCount: balusters.balusterCount,
    balusterClearGap: balusters.clearGap,
    balusterRailRun,
    codeCompliant,
  };
}
