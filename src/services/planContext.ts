import type { Opening, Wall } from "../types/floorplan";
import { wallLength } from "../utils/geometry";
import { runComplianceChecks } from "../utils/spatialRules";

export function buildPlanContext(walls: Wall[], openings: Opening[]) {
  const wallLines = walls.slice(0, 120).map((wall, index) => {
    return `W${index + 1}: (${wall.x1.toFixed(1)}, ${wall.y1.toFixed(1)}) -> (${wall.x2.toFixed(1)}, ${wall.y2.toFixed(1)}), length ${wallLength(wall).toFixed(1)} ft, thickness ${wall.thickness.toFixed(2)} ft, height ${wall.height.toFixed(1)} ft`;
  });

  const openingLines = openings.slice(0, 80).map((opening, index) => {
    const wallIndex = walls.findIndex((wall) => wall.id === opening.wallId);
    return `O${index + 1}: ${opening.type} on W${wallIndex + 1}, clear width ${(opening.width * 12).toFixed(1)} in, position ${(opening.positionOnWall * 100).toFixed(0)}% along the wall`;
  });

  const report = runComplianceChecks(walls, openings);
  const checkLines = report.checks.map(
    (check) =>
      `- [${check.status.toUpperCase()}] ${check.title}: ${check.detail}`,
  );

  return [
    `Scene summary: ${walls.length} walls, ${openings.length} openings. Units are feet.`,
    "Deterministic rule engine results:",
    checkLines.length > 0 ? checkLines.join("\n") : "- No checks available.",
    "Wall geometry:",
    wallLines.length > 0 ? wallLines.join("\n") : "- No walls in the plan.",
    "Openings:",
    openingLines.length > 0
      ? openingLines.join("\n")
      : "- No doors or windows in the plan.",
  ].join("\n");
}

export function buildSystemPrompt() {
  return [
    "You are an expert architectural code and spatial-compliance inspector embedded in a desktop floor-plan editor.",
    "Analyze the supplied plan geometry and deterministic rule results.",
    "Reference relevant concerns such as egress width, ADA accessibility, circulation, wall connectivity, room proportions, and door swing space.",
    "Be concise, practical, and specific. Use short bullet points with a severity label such as INFO, WARNING, or CRITICAL.",
    "Do not invent measurements that are not present in the supplied scene data.",
  ].join(" ");
}
