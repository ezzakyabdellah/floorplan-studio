import {
  defaultSawKerf,
  materialCutDemands,
  type MaterialLine,
} from "./billOfMaterials";
import { feetToProjectUnits, formatLength } from "./units";
import type { ProjectState } from "./types";

export type CutPattern = {
  stockLength: number;
  cuts: Array<{ label: string; length: number }>;
  kerfWaste: number;
  offcut: number;
};

export type CutGroup = {
  id: string;
  material: string;
  stockProfile: string;
  patterns: CutPattern[];
  stockUsed: number;
  cutLengthUsed: number;
  offcutWaste: number;
  wastePercent: number;
};

export type CutOptimization = {
  kerf: number;
  groups: CutGroup[];
  totalStock: number;
  totalCut: number;
  totalWaste: number;
  totalWastePercent: number;
  assumptions: string[];
};

type StockBin = {
  stockLength: number;
  cuts: Array<{ label: string; length: number }>;
  usedWithKerf: number;
};

function stockLengthsForProject(project: ProjectState) {
  return [8, 10, 12, 16].map((feet) =>
    feetToProjectUnits(feet, project.units),
  );
}

function optimizeMaterialGroup(
  id: string,
  lines: MaterialLine[],
  stockLengths: number[],
  kerf: number,
): CutGroup {
  const first = lines[0];
  const demands = lines
    .flatMap((line) => {
      if (
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 0 ||
        line.quantity > 100_000
      ) {
        throw new RangeError(
          `Cut quantity for "${line.item}" is outside the supported range (0–100,000).`,
        );
      }
      return Array.from({ length: line.quantity }, (_, index) => ({
        label:
          line.quantity > 1
            ? `${line.item} ${index + 1}`
            : line.item,
        length: line.cutLength as number,
      }));
    })
    .sort((a, b) => b.length - a.length);

  const bins: StockBin[] = [];
  for (const demand of demands) {
    const required = demand.length + kerf;
    const candidates = bins
      .map((bin, index) => ({
        index,
        remaining: bin.stockLength - bin.usedWithKerf,
      }))
      .filter((candidate) => candidate.remaining >= required)
      .sort(
        (a, b) =>
          (a.remaining - required) - (b.remaining - required),
      );

    let bin: StockBin;
    if (candidates.length > 0) {
      bin = bins[candidates[0].index];
    } else {
      const stockLength =
        stockLengths.find((length) => length >= required) ?? required;
      bin = { stockLength, cuts: [], usedWithKerf: 0 };
      bins.push(bin);
    }
    bin.cuts.push(demand);
    bin.usedWithKerf += required;
  }

  const patterns = bins.map((bin) => {
    const cutLength = bin.cuts.reduce((sum, cut) => sum + cut.length, 0);
    const kerfWaste = bin.cuts.length * kerf;
    return {
      stockLength: bin.stockLength,
      cuts: bin.cuts,
      kerfWaste,
      offcut: Math.max(0, bin.stockLength - cutLength - kerfWaste),
    };
  });
  const stockUsed = patterns.reduce((sum, pattern) => sum + pattern.stockLength, 0);
  const cutLengthUsed = patterns.reduce(
    (sum, pattern) =>
      sum + pattern.cuts.reduce((cutSum, cut) => cutSum + cut.length, 0),
    0,
  );
  const offcutWaste = patterns.reduce(
    (sum, pattern) => sum + pattern.offcut + pattern.kerfWaste,
    0,
  );

  return {
    id,
    material: first.material,
    stockProfile: first.stockProfile ?? "unclassified",
    patterns,
    stockUsed,
    cutLengthUsed,
    offcutWaste,
    wastePercent: stockUsed > 0 ? (offcutWaste / stockUsed) * 100 : 0,
  };
}

export function optimizeCutList(
  project: ProjectState,
  lines: MaterialLine[],
): CutOptimization {
  const kerf = defaultSawKerf(project.units);
  const stockLengths = stockLengthsForProject(project);
  const demands = materialCutDemands(lines);
  const grouped = new Map<string, MaterialLine[]>();
  for (const demand of demands) {
    const groupId = `${demand.stockProfile}:${demand.material}`;
    const group = grouped.get(groupId) ?? [];
    group.push(demand);
    grouped.set(groupId, group);
  }
  const groups = [...grouped.entries()].map(([id, group]) =>
    optimizeMaterialGroup(id, group, stockLengths, kerf),
  );
  const totalStock = groups.reduce((sum, group) => sum + group.stockUsed, 0);
  const totalCut = groups.reduce((sum, group) => sum + group.cutLengthUsed, 0);
  const totalWaste = groups.reduce((sum, group) => sum + group.offcutWaste, 0);
  return {
    kerf,
    groups,
    totalStock,
    totalCut,
    totalWaste,
    totalWastePercent: totalStock > 0 ? (totalWaste / totalStock) * 100 : 0,
    assumptions: [
      "Deterministic best-fit decreasing; separate stock profiles are not mixed.",
      `Saw kerf allowance: ${formatLength(kerf, project.units)} per cut.`,
      "Stringer blank lengths are geometric references; verify end-cut, bearing, and manufacturer allowances before ordering.",
      "Standard stock lengths are 8, 10, 12, and 16 ft; oversized cuts are listed as custom stock.",
    ],
  };
}

export function cutOptimizationCsv(
  result: CutOptimization,
  units: ProjectState["units"],
): string {
  const rows = [
    ["Stock profile", "Material", "Stock bar", "Stock length", "Part", "Cut length", "Offcut", "Kerf"],
  ];
  for (const group of result.groups) {
    for (const [index, pattern] of group.patterns.entries()) {
      for (const cut of pattern.cuts) {
        rows.push([
          group.stockProfile,
          group.material,
          String(index + 1),
          formatLength(pattern.stockLength, units),
          cut.label,
          formatLength(cut.length, units),
          formatLength(pattern.offcut, units),
          formatLength(result.kerf, units),
        ]);
      }
    }
  }
  return rows
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}
