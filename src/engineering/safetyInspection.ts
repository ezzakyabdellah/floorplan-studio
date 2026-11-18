import { buildShopSheetPdf, type SheetCommand } from "./shopSheet";
import type { ProjectState } from "./types";

export type InspectionAnswer = "unchecked" | "pass" | "fail" | "na";

export type InspectionItem = {
  id: string;
  label: string;
  citation: string;
  answer: InspectionAnswer;
  note: string;
};

export type InspectionRecord = {
  id: string;
  projectName: string;
  projectType: ProjectState["projectType"];
  inspector: string;
  inspectedAt: string;
  items: InspectionItem[];
  overall: "pass" | "fail" | "incomplete";
};

const ladderChecks: Array<[string, string, string]> = [
  ["rails", "Side rails, rungs/steps, feet, locks, and hardware have no visible damage or excessive wear.", "OSHA 29 CFR 1910.23(b)(7), (b)(9)-(10); manufacturer instructions"],
  ["rungs", "Rungs and steps are clean, sound, uniformly spaced, and free of slippery material.", "OSHA 29 CFR 1910.23(b)(1), (b)(9); manufacturer instructions"],
  ["labels", "Duty-rating labels and inspection markings are legible; ladder is used only as designed.", "OSHA 29 CFR 1910.23(b)(8)-(10); manufacturer instructions"],
  ["surface", "Base is on a stable, level surface; ladder is secured or stabilized where displacement is possible.", "OSHA 29 CFR 1910.23(c)(4), (c)(7), (c)(9)"],
  ["setup", "Leaning ladder placement, support, and extension overlap follow the ladder manufacturer's instructions and employer procedure.", "OSHA 29 CFR 1910.23(c)(4), (c)(10); manufacturer instructions"],
  ["access", "Portable ladder rails extend at least 3 ft above an upper landing when used for access.", "OSHA 29 CFR 1910.23(c)(11)"],
  ["area", "Area is clear of electrical hazards, traffic, doors, and other conditions that could cause injury or displacement.", "OSHA 29 CFR 1910.23(c)(7); site hazard assessment"],
  ["load", "Planned load, including the user and carried materials, does not exceed the ladder's maximum intended load.", "OSHA 29 CFR 1910.23(c)(3); ladder duty-rating label"],
];

const stairChecks: Array<[string, string, string]> = [
  ["treads", "Treads and risers are secure, uniform between landings, and free of damage or trip hazards.", "OSHA 29 CFR 1910.25(b)(3); site inspection"],
  ["handrail", "Required handrails and guards are secure, continuous where required, and free of sharp or loose parts.", "OSHA 29 CFR 1910.25(b)(1); 1910.28; 1910.29"],
  ["surface", "Walking surfaces are clean, dry, adequately lit, and unobstructed.", "OSHA 29 CFR 1910.22; 1910.25"],
  ["openings", "Stair openings, landings, and edges have required protection; access is not obstructed.", "OSHA 29 CFR 1910.28; 1910.29"],
  ["structure", "No visible movement, loose connections, cracked members, or deterioration is observed.", "Visual pre-use check; refer defects to a qualified person"],
  ["clearance", "Headroom is unobstructed; check the applicable standard for stair type and site.", "OSHA 29 CFR 1910.25(b)(2); for spiral stairs, 1910.25(d)(3)"],
];

export function createInspectionChecklist(
  project: ProjectState,
): InspectionItem[] {
  const rows = project.projectType === "ladder" ? ladderChecks : stairChecks;
  return rows.map(([id, label, citation]) => ({
    id,
    label,
    citation,
    answer: "unchecked",
    note: "",
  }));
}

export function inspectionOutcome(
  items: InspectionItem[],
): InspectionRecord["overall"] {
  if (items.some((item) => item.answer === "fail")) return "fail";
  if (
    items.some((item) => item.answer === "unchecked") ||
    !items.some((item) => item.answer === "pass")
  ) {
    return "incomplete";
  }
  return "pass";
}

export function makeInspectionRecord(input: {
  projectName: string;
  project: ProjectState;
  inspector: string;
  items: InspectionItem[];
  inspectedAt?: string;
}): InspectionRecord {
  const items = structuredClone(input.items);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `inspection-${Date.now()}`,
    projectName: input.projectName,
    projectType: input.project.projectType,
    inspector: input.inspector.trim() || "Not specified",
    inspectedAt: input.inspectedAt ?? new Date().toISOString(),
    items,
    overall: inspectionOutcome(items),
  };
}

export function buildInspectionReportPdf(record: InspectionRecord): Uint8Array {
  const commands: SheetCommand[] = [
    { kind: "rect", x: 0, y: 0, width: 850, height: 1100, stroke: "#ffffff", fill: "#ffffff", lineWidth: 0 },
    { kind: "text", x: 44, y: 56, text: "PRE-USE SAFETY INSPECTION", size: 23, color: "#17212b", weight: "bold" },
    { kind: "text", x: 44, y: 86, text: `Project: ${record.projectName}`, size: 12 },
    { kind: "text", x: 44, y: 108, text: `Type: ${record.projectType} | Inspector: ${record.inspector}`, size: 11 },
    { kind: "text", x: 44, y: 130, text: `Inspected: ${new Date(record.inspectedAt).toLocaleString()} | Result: ${record.overall.toUpperCase()}`, size: 11, weight: "bold" },
    { kind: "line", x1: 44, y1: 145, x2: 806, y2: 145, color: "#64748b", width: 1 },
  ];
  let y = 174;
  for (const item of record.items) {
    const answer = item.answer.toUpperCase();
    const color =
      item.answer === "pass" ? "#047857" :
        item.answer === "fail" ? "#be123c" :
          item.answer === "na" ? "#475569" : "#a16207";
    commands.push(
      { kind: "text", x: 44, y, text: `[${answer}] ${item.label}`, size: 11, color, weight: "bold" },
      { kind: "text", x: 58, y: y + 17, text: item.citation, size: 8, color: "#475569" },
    );
    if (item.note.trim()) {
      commands.push({
        kind: "text",
        x: 58,
        y: y + 32,
        text: `Note: ${item.note.trim().slice(0, 150)}`,
        size: 9,
        color: "#334155",
      });
    }
    y += item.note.trim() ? 58 : 42;
  }
  commands.push(
    { kind: "line", x1: 44, y1: 1030, x2: 806, y2: 1030, color: "#cbd5e1", width: 1 },
    { kind: "text", x: 44, y: 1046, text: "Checklist aid only. Follow current OSHA standards, site procedures, and manufacturer instructions.", size: 8, color: "#475569" },
    { kind: "text", x: 44, y: 1062, text: "Remove unsafe equipment from service and refer defects to a qualified person.", size: 8, color: "#475569" },
  );
  return buildShopSheetPdf({ width: 850, height: 1100, commands });
}
