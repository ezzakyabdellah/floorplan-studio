import {
  calculateBalusterSpacing,
  calculateRailingRun,
} from "./railingCalculations";
import { calculateLadderGeometry } from "./ladderCalculations";
import { calculateStairGeometry } from "./stairCalculations";
import { formatLength, inchesToProjectUnits } from "./units";
import { maximumGuardOpening } from "./railingCalculations";
import type {
  AuditFinding,
  AuditReport,
  EngineeringUnits,
  ProjectState,
} from "./types";

export const BUILDING_CODE_DISCLAIMER =
  "Code checks are informational only. Confirm the currently adopted code, local amendments, manufacturer instructions, and site conditions with your local building official or a qualified professional.";

function finding(
  id: string,
  status: AuditFinding["status"],
  title: string,
  detail: string,
  citation: string,
): AuditFinding {
  return { id, status, title, detail, citation };
}

function auditStaircase(project: ProjectState): AuditFinding[] {
  const { units, stairParams } = project;
  const format = (value: number) => formatLength(value, units, project.displayUnit);
  const metrics = calculateStairGeometry(stairParams, units);
  const minRiser = inchesToProjectUnits(4, units);
  const maxRiser = inchesToProjectUnits(7.75, units);
  const minTread = inchesToProjectUnits(10, units);
  const minimumHeadroom = inchesToProjectUnits(80, units);
  const maxOpening = maximumGuardOpening(units);
  const railingRun = calculateRailingRun(stairParams, units);
  const balusters = calculateBalusterSpacing(
    railingRun,
    Math.min(stairParams.balusterSpacingMax, maxOpening),
    stairParams.balusterThickness,
    units,
  );
  const findings = [
    finding(
      "stair-riser",
      metrics.unitRiseExact >= minRiser && metrics.unitRiseExact <= maxRiser
        ? "pass"
        : "fail",
      "Stair riser height",
      `${metrics.stepCount} equal risers at ${format(metrics.unitRise)}; allowed range is ${format(minRiser)}–${format(maxRiser)}.`,
      "IRC R311.7.5.1 (2021): riser height is 4 in minimum and 7¾ in maximum; verify adopted edition.",
    ),
    finding(
      "stair-tread",
      metrics.unitRunExact >= minTread ? "pass" : "fail",
      "Stair tread depth",
      `${metrics.treadCount} equal runs at ${format(metrics.unitRun)}; the cited minimum is ${format(minTread)}.`,
      "IRC R311.7.5.2 (2021): minimum tread depth 10 in, measured nosing-to-nosing; verify adopted edition.",
    ),
    finding(
      "baluster-opening",
      balusters.clearGapExact <= maxOpening ? "pass" : "fail",
      "Guard opening spacing",
      `${balusters.balusterCount} balusters produce a ${format(balusters.clearGap)} clear gap (maximum ${format(maxOpening)}).`,
      `IRC R312.1.3 (2021): guard openings generally must not allow passage of a 4 in sphere; the stair-side triangular opening exception differs. Verify adopted edition.`,
    ),
  ];

  if (stairParams.headroomClearance === null) {
    findings.push(
      finding(
        "stair-headroom",
        "warning",
        "Headroom not measured",
        "Ceiling height alone does not establish clearance over the stair. Enter a site-measured minimum headroom to check it.",
        "IRC R311.7.2 (2021): 6 ft 8 in minimum headroom; verify measurement method and adopted edition.",
      ),
    );
  } else {
    findings.push(
      finding(
        "stair-headroom",
        stairParams.headroomClearance >= minimumHeadroom ? "pass" : "fail",
        "Stair headroom",
        `${format(stairParams.headroomClearance)} measured; minimum is ${format(minimumHeadroom)}.`,
        "IRC R311.7.2 (2021): 6 ft 8 in minimum headroom; verify measurement method and adopted edition.",
      ),
    );
  }

  if (stairParams.style === "spiral") {
    findings.push(
      finding(
        "stair-layout-scope",
        "warning",
        "Spiral stair layout advisory",
        "The audit uses a circular walking-line development. Verify tapered tread depth at the walkline, inner clear width, headroom, handrail, and local spiral-stair provisions.",
        "IRC R311.7.10 (2021): spiral stairway requirements; verify adopted edition and all dimensional provisions.",
      ),
    );
  }
  return findings;
}

function auditLadder(project: ProjectState): AuditFinding[] {
  const { units, ladderParams } = project;
  const format = (value: number) => formatLength(value, units, project.displayUnit);
  const metrics = calculateLadderGeometry(
    ladderParams.workingHeight,
    units,
    ladderParams.ladderType,
  );
  const targetAngle = 75.5;
  const findings: AuditFinding[] = [
    ...(ladderParams.ladderType === "step"
      ? [
          finding(
            "ladder-setback",
            "pass",
            "Self-supporting ladder setup",
            "The 1:4 leaning-ladder setback does not apply to a self-supporting step ladder. Fully open and lock spreaders on a stable surface per its label.",
            "OSHA 29 CFR 1926.1053: use portable ladders in accordance with their design and manufacturer's instructions.",
          ),
        ]
      : [
          finding(
            "ladder-setback",
            Math.abs(metrics.ladderAngleDegrees - targetAngle) <= 2
              ? "pass"
              : "warning",
            "Ladder setup angle",
            `The 4:1 setback gives a ${metrics.ladderAngleDegrees}° angle (OSHA guidance target approximately ${targetAngle}°).`,
            "OSHA 29 CFR 1926.1053(b)(5)(i): non-self-supporting ladders are positioned so the horizontal distance is about one-quarter of the working length.",
          ),
        ]),
    finding(
      "ladder-roof-extension",
      ladderParams.ladderType === "step" ||
        metrics.roofExtension >= inchesToProjectUnits(36, units)
        ? "pass"
        : "fail",
      "Access landing extension",
      ladderParams.ladderType !== "step"
        ? `Allow ${format(metrics.roofExtension)} above the upper landing.`
        : "The 3 ft extension rule applies to portable ladders used to access an upper landing; this project is not an extension ladder.",
      "OSHA 29 CFR 1926.1053(b)(6): side rails extend at least 3 ft above an upper landing, unless an equivalent secure handhold is provided.",
    ),
  ];

  if (ladderParams.ladderType === "extension") {
    findings.push(
      finding(
        "ladder-overlap",
        metrics.minimumOverlap === null ? "warning" : "pass",
        "Extension ladder overlap",
        metrics.minimumOverlap === null
          ? "Required length exceeds the overlap table range; follow the ladder manufacturer's instructions."
          : `Minimum overlap guidance for this length is ${format(metrics.minimumOverlap)}. Confirm with the ladder label and manufacturer.`,
        "ANSI A14.2 overlap guidance (edition-specific); follow the ladder manufacturer's instructions.",
      ),
    );
  }
  return findings;
}

export function runBuildingCodeAudit(project: ProjectState): AuditReport {
  const findings =
    project.projectType === "staircase"
      ? auditStaircase(project)
      : auditLadder(project);
  const passCount = findings.filter((item) => item.status === "pass").length;
  const warningCount = findings.filter(
    (item) => item.status === "warning",
  ).length;
  const failCount = findings.filter((item) => item.status === "fail").length;

  return {
    findings,
    passCount,
    warningCount,
    failCount,
    allPassing: failCount === 0 && warningCount === 0,
    disclaimer: BUILDING_CODE_DISCLAIMER,
  };
}

export function maxRiserHeight(units: EngineeringUnits) {
  return inchesToProjectUnits(7.75, units);
}
