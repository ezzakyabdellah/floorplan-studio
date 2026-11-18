import { calculateStairGeometry } from "./stairCalculations";
import { inchesToProjectUnits, roundLength } from "./units";
import type { ProjectState } from "./types";

export type MaterialLine = {
  id: string;
  item: string;
  material: string;
  quantity: number;
  unit: "pcs" | "each" | "set";
  cutLength: number | null;
  stockProfile: string | null;
  detail: string;
};

function stairStringerLengths(project: ProjectState): number[] {
  const geometry = calculateStairGeometry(
    project.stairParams,
    project.units,
  );
  if (
    project.stairParams.style !== "l-shaped" &&
    project.stairParams.style !== "u-shaped"
  ) {
    return [geometry.stringerLength, geometry.stringerLength];
  }

  const firstRisers = Math.ceil(geometry.stepCount / 2);
  const firstTreads = Math.ceil(geometry.treadCount / 2);
  const secondTreads = geometry.treadCount - firstTreads;
  const firstRun =
    (geometry.totalWalkingRun * firstTreads) / geometry.treadCount;
  const secondRun =
    (geometry.totalWalkingRun * secondTreads) / geometry.treadCount;
  const firstRise =
    (project.stairParams.totalRise * firstRisers) / geometry.stepCount;
  const secondRise = project.stairParams.totalRise - firstRise;
  const firstLength = roundLength(
    Math.hypot(firstRun, firstRise),
    project.units,
  );
  const secondLength = roundLength(
    Math.hypot(secondRun, secondRise),
    project.units,
  );
  return [firstLength, firstLength, secondLength, secondLength];
}

/** Quantities and cut references are deterministic estimates, not an engineered takeoff. */
export function buildMaterialManifest(project: ProjectState): MaterialLine[] {
  if (project.projectType === "ladder") {
    return [
      {
        id: "ladder-assembly",
        item: "Rated portable ladder",
        material: "Commercial ladder",
        quantity: 1,
        unit: "each",
        cutLength: null,
        stockProfile: null,
        detail: `Select a ladder rated for the ${project.ladderParams.surfaceType} surface and at least ${project.calculatedMetrics.ladderRequiredLength} project units of calculated reach.`,
      },
      {
        id: "ladder-inspection-tags",
        item: "Inspection / identification tags",
        material: "Safety supplies",
        quantity: 1,
        unit: "set",
        cutLength: null,
        stockProfile: null,
        detail: "Use the ladder manufacturer's approved labels and inspection records.",
      },
    ];
  }

  const { stairParams, calculatedMetrics, units } = project;
  const lines: MaterialLine[] = stairStringerLengths(project).map(
    (cutLength, index) => ({
      id: `stringer-${index + 1}`,
      item: `${stairParams.style} stair stringer`,
      material: "Structural lumber; species/grade by design",
      quantity: 1,
      unit: "pcs",
      cutLength,
      stockProfile: "2x12",
      detail:
        "Cut length is the geometric stringer line only; add end bearing/cut allowance and verify stock size.",
    }),
  );

  lines.push(
    {
      id: "treads",
      item: "Tread blanks",
      material: "Tread stock; species/grade by design",
      quantity: calculatedMetrics.treadCount,
      unit: "pcs",
      cutLength: stairParams.width,
      stockProfile: "2x10",
      detail: `Stock thickness ${stairParams.treadThickness} ${units}; confirm overhang and finish dimensions onsite.`,
    },
    {
      id: "risers",
      item: "Riser blanks",
      material: "Riser stock",
      quantity: calculatedMetrics.stepCount,
      unit: "pcs",
      cutLength: stairParams.width,
      stockProfile: "1x8",
      detail: "Trim to field-measured riser face height after tread finish is selected.",
    },
    {
      id: "balusters",
      item: "Balusters",
      material: "Guard components",
      quantity: calculatedMetrics.balusterCount,
      unit: "pcs",
      cutLength: null,
      stockProfile: null,
      detail: `One railing run at ${calculatedMetrics.balusterClearGap} ${units} calculated clear gap; guard height is not specified, cut to approved detail.`,
    },
    {
      id: "handrail",
      item: "Handrail",
      material: "Handrail stock",
      quantity: 1,
      unit: "pcs",
      cutLength: calculatedMetrics.balusterRailRun,
      stockProfile: "2x4",
      detail:
        "Verify graspable profile, returns, brackets, and splice locations against adopted code.",
    },
    {
      id: "tread-fasteners",
      item: "Tread structural screws",
      material: "Corrosion-resistant structural fasteners",
      quantity: calculatedMetrics.treadCount * 4,
      unit: "each",
      cutLength: null,
      stockProfile: null,
      detail:
        "Planning allowance of four screws per tread; confirm fastener schedule with the approved design.",
    },
  );

  if (stairParams.style === "l-shaped" || stairParams.style === "u-shaped") {
    lines.push({
      id: "landing-frames",
      item: "Landing frame members",
      material: "Structural lumber; species/grade by design",
      quantity: 4,
      unit: "pcs",
      cutLength: stairParams.landingLength,
      stockProfile: "2x10",
      detail: "Landing framing estimate; verify joist direction, bearing, and connections.",
    });
  }
  if (stairParams.style === "spiral") {
    lines.push({
      id: "spiral-center-post",
      item: "Spiral stair center post",
      material: "Structural steel/wood post by design",
      quantity: 1,
      unit: "pcs",
      cutLength: stairParams.totalRise,
      stockProfile: null,
      detail:
        "Illustrative length; verify base plate, top connection, section, and material capacity.",
    });
  }
  return lines;
}

export function materialManifestCsv(lines: MaterialLine[]): string {
  const rows = [
    [
      "Item",
      "Material",
      "Quantity",
      "Unit",
      "Cut length",
      "Stock profile",
      "Notes",
    ],
    ...lines.map((line) => [
      line.item,
      line.material,
      String(line.quantity),
      line.unit,
      line.cutLength === null ? "" : String(line.cutLength),
      line.stockProfile ?? "",
      line.detail,
    ]),
  ];
  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

export function materialCutDemands(lines: MaterialLine[]) {
  return lines.filter(
    (line): line is MaterialLine & { cutLength: number; stockProfile: string } =>
      line.cutLength !== null && line.stockProfile !== null,
  );
}

export function defaultSawKerf(units: ProjectState["units"]) {
  return inchesToProjectUnits(0.125, units);
}
