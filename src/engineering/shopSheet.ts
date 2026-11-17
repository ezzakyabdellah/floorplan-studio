import { calculateLadderGeometry } from "./ladderCalculations";
import { calculateStairGeometry } from "./stairCalculations";
import { formatLength } from "./units";
import type { ProjectState } from "./types";

export type SheetCommand =
  | {
      kind: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color?: string;
      width?: number;
      dash?: string;
    }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      stroke?: string;
      fill?: string;
      lineWidth?: number;
    }
  | {
      kind: "polyline";
      points: Array<[number, number]>;
      color?: string;
      width?: number;
      fill?: string;
    }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      size?: number;
      color?: string;
      weight?: "normal" | "bold";
      anchor?: "start" | "middle" | "end";
    };

export type ShopSheetDocument = {
  width: number;
  height: number;
  commands: SheetCommand[];
};

export type WorkshopNotes = {
  assemblyNotes: string[];
  cuttingInstructions: string[];
};

const INK = "#17212b";
const MUTED = "#475569";
const ACCENT = "#0e7490";

const fixed = (value: number) => Number(value.toFixed(2));
const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function line(
  commands: SheetCommand[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color = INK,
  width = 2,
  dash?: string,
) {
  commands.push({ kind: "line", x1, y1, x2, y2, color, width, dash });
}

function text(
  commands: SheetCommand[],
  x: number,
  y: number,
  value: string,
  size = 13,
  color = INK,
  weight: "normal" | "bold" = "normal",
  anchor: "start" | "middle" | "end" = "start",
) {
  commands.push({
    kind: "text",
    x,
    y,
    text: value,
    size,
    color,
    weight,
    anchor,
  });
}

function panel(
  commands: SheetCommand[],
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
  subtitle?: string,
) {
  commands.push({
    kind: "rect",
    x,
    y,
    width,
    height,
    stroke: "#94a3b8",
    fill: "#ffffff",
    lineWidth: 1.25,
  });
  text(commands, x + 16, y + 24, title, 14, ACCENT, "bold");
  if (subtitle) text(commands, x + 16, y + 42, subtitle, 10, MUTED);
  line(commands, x + 16, y + 51, x + width - 16, y + 51, "#cbd5e1", 1);
}

function horizontalDimension(
  commands: SheetCommand[],
  x1: number,
  x2: number,
  y: number,
  label: string,
) {
  line(commands, x1, y, x2, y, ACCENT, 1.25);
  line(commands, x1, y - 6, x1, y + 6, ACCENT, 1.25);
  line(commands, x2, y - 6, x2, y + 6, ACCENT, 1.25);
  text(commands, (x1 + x2) / 2, y - 7, label, 11, ACCENT, "bold", "middle");
}

function verticalDimension(
  commands: SheetCommand[],
  x: number,
  y1: number,
  y2: number,
  label: string,
) {
  line(commands, x, y1, x, y2, ACCENT, 1.25);
  line(commands, x - 6, y1, x + 6, y1, ACCENT, 1.25);
  line(commands, x - 6, y2, x + 6, y2, ACCENT, 1.25);
  text(commands, x + 8, (y1 + y2) / 2, label, 11, ACCENT, "bold");
}

function addSideElevation(
  commands: SheetCommand[],
  project: ProjectState,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const { stairParams, units } = project;
  const geometry = calculateStairGeometry(stairParams, units);
  panel(
    commands,
    x,
    y,
    width,
    height,
    "SIDE ELEVATION",
    `${stairParams.style.toUpperCase()} · ${geometry.stepCount} risers / ${geometry.treadCount} treads`,
  );
  const left = x + 62;
  const bottom = y + height - 56;
  const availableWidth = width - 122;
  const availableHeight = height - 130;
  const scale = Math.min(
    availableWidth / stairParams.totalRun,
    availableHeight / stairParams.totalRise,
  );
  const run = stairParams.totalRun * scale;
  const rise = stairParams.totalRise * scale;
  const stepRun = run / geometry.treadCount;
  const stepRise = rise / geometry.stepCount;
  const points: Array<[number, number]> = [[left, bottom]];
  for (let index = 0; index < geometry.treadCount; index += 1) {
    const currentX = left + index * stepRun;
    const currentY = bottom - index * stepRise;
    points.push([currentX + stepRun, currentY]);
    points.push([currentX + stepRun, currentY - stepRise]);
  }
  points.push([left + run, bottom - rise]);
  commands.push({
    kind: "polyline",
    points,
    color: INK,
    width: 2.25,
    fill: "none",
  });
  line(commands, left - 7, bottom + 1, left + run + 24, bottom + 1, MUTED, 1);
  line(commands, left + run + 20, bottom + 6, left + run + 20, bottom - rise - 20, MUTED, 1);
  horizontalDimension(
    commands,
    left,
    left + run,
    bottom + 22,
    `RUN ${formatLength(stairParams.totalRun, units)}`,
  );
  verticalDimension(
    commands,
    left - 22,
    bottom,
    bottom - rise,
    `RISE ${formatLength(stairParams.totalRise, units)}`,
  );
  text(
    commands,
    left + run / 2,
    bottom - rise - 13,
    `PITCH ${geometry.pitchAngleDegrees}°`,
    10,
    MUTED,
    "bold",
    "middle",
  );
  text(
    commands,
    x + 16,
    y + height - 12,
    `AVG RISE ${geometry.unitRiseExact.toFixed(units === "imperial" ? 3 : 1)} ${units === "imperial" ? "in" : "mm"}  ·  TREAD ${formatLength(geometry.unitRun, units)}`,
    10,
    MUTED,
  );
}

function addTopPlan(
  commands: SheetCommand[],
  project: ProjectState,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const { stairParams, units } = project;
  panel(
    commands,
    x,
    y,
    width,
    height,
    "TOP PLAN",
    "ORTHOGRAPHIC · AGGREGATE FLIGHT ENVELOPE",
  );
  const left = x + 62;
  const top = y + 93;
  const availableWidth = width - 112;
  const availableHeight = height - 152;
  const scale = Math.min(
    availableWidth / stairParams.totalRun,
    availableHeight / stairParams.width,
  );
  const run = stairParams.totalRun * scale;
  const stairWidth = stairParams.width * scale;
  commands.push({
    kind: "rect",
    x: left,
    y: top,
    width: run,
    height: stairWidth,
    stroke: INK,
    fill: "none",
    lineWidth: 2,
  });
  const treadCount = calculateStairGeometry(stairParams, units).treadCount;
  for (let index = 1; index < treadCount; index += 1) {
    const treadX = left + (run * index) / treadCount;
    line(commands, treadX, top, treadX, top + stairWidth, "#64748b", 0.8);
  }
  horizontalDimension(
    commands,
    left,
    left + run,
    top + stairWidth + 20,
    `RUN ${formatLength(stairParams.totalRun, units)}`,
  );
  verticalDimension(
    commands,
    left + run + 19,
    top,
    top + stairWidth,
    `WIDTH ${formatLength(stairParams.width, units)}`,
  );
  text(commands, left + run / 2, top + stairWidth / 2 + 4, "STAIR FLIGHT", 11, MUTED, "bold", "middle");
}

function addFrontElevation(
  commands: SheetCommand[],
  project: ProjectState,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const { stairParams, units } = project;
  panel(
    commands,
    x,
    y,
    width,
    height,
    "FRONT ELEVATION",
    "FLIGHT WIDTH · SCHEMATIC",
  );
  const inset = 76;
  const areaWidth = width - inset * 2;
  const areaHeight = height - 104;
  const scale = Math.min(
    areaWidth / stairParams.width,
    areaHeight / stairParams.totalRise,
  );
  const stairWidth = stairParams.width * scale;
  const rise = stairParams.totalRise * scale;
  const left = x + (width - stairWidth) / 2;
  const bottom = y + height - 32;
  const top = bottom - rise;
  line(commands, left, bottom, left, top, INK, 2);
  line(commands, left + stairWidth, bottom, left + stairWidth, top, INK, 2);
  line(commands, left, top, left + stairWidth, top, INK, 2);
  line(commands, left + stairWidth * 0.16, bottom, left + stairWidth * 0.16, top, "#64748b", 1.3);
  line(commands, left + stairWidth * 0.84, bottom, left + stairWidth * 0.84, top, "#64748b", 1.3);
  horizontalDimension(
    commands,
    left,
    left + stairWidth,
    bottom + 15,
    `WIDTH ${formatLength(stairParams.width, units)}`,
  );
  text(commands, x + 16, y + height - 10, "Stringer positions shown schematically; confirm framing and handrail design onsite.", 9, MUTED);
}

function addStringerNotch(
  commands: SheetCommand[],
  project: ProjectState,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const { stairParams, units } = project;
  const geometry = calculateStairGeometry(stairParams, units);
  panel(
    commands,
    x,
    y,
    width,
    height,
    "STRINGER NOTCH LAYOUT",
    "PROFILE · NOT TO SCALE FOR CUTTING",
  );
  const marginX = 26;
  const topPad = 80;
  const bottom = y + height - 40;
  const availableWidth = width - marginX * 2;
  const availableHeight = height - topPad - 60;
  const scale = Math.min(
    availableWidth / stairParams.totalRun,
    availableHeight / stairParams.totalRise,
  );
  const run = stairParams.totalRun * scale;
  const rise = stairParams.totalRise * scale;
  const left = x + marginX;
  const stepRun = run / geometry.treadCount;
  const stepRise = rise / geometry.stepCount;
  const points: Array<[number, number]> = [[left, bottom]];
  for (let index = 0; index < geometry.treadCount; index += 1) {
    const currentX = left + index * stepRun;
    const currentY = bottom - index * stepRise;
    points.push(
      [currentX + stepRun, currentY],
      [currentX + stepRun, currentY - stepRise],
    );
  }
  points.push([left + run, bottom - rise]);
  commands.push({
    kind: "polyline",
    points,
    color: ACCENT,
    width: 2,
    fill: "none",
  });
  horizontalDimension(commands, left, left + run, bottom + 17, `RUN ${formatLength(stairParams.totalRun, units)}`);
  text(
    commands,
    x + 16,
    y + height - 10,
    `${geometry.treadCount} tread notches · ${geometry.stepCount} risers · stringer line ${formatLength(geometry.stringerLength, units)}`,
    9,
    MUTED,
  );
}

function addLadderAngle(
  commands: SheetCommand[],
  project: ProjectState,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const { ladderParams, units } = project;
  const geometry = calculateLadderGeometry(
    ladderParams.workingHeight,
    units,
    ladderParams.ladderType,
  );
  panel(
    commands,
    x,
    y,
    width,
    height,
    "LADDER SETUP",
    `${ladderParams.ladderType.toUpperCase()} · 4:1 GUIDANCE FOR LEANING LADDERS`,
  );
  const floorY = y + height - 36;
  const wallX = x + width - 72;
  const scale = Math.min(
    (height - 120) / ladderParams.workingHeight,
    (width - 145) /
      Math.max(ladderParams.workingHeight + geometry.baseSetback, 1),
  );
  const vertical = ladderParams.workingHeight * scale;
  const setback = geometry.baseSetback * scale;
  const baseX = wallX - setback;
  const topY = floorY - vertical;
  line(commands, x + 30, floorY, x + width - 32, floorY, INK, 1.5);
  line(commands, wallX, floorY + 2, wallX, topY - 25, INK, 2.5);
  line(commands, baseX, floorY, wallX, topY, ACCENT, 3);
  if (geometry.roofExtension > 0) {
    line(
      commands,
      wallX,
      topY,
      wallX,
      topY - geometry.roofExtension * scale,
      ACCENT,
      3,
      "7 4",
    );
  }
  horizontalDimension(
    commands,
    baseX,
    wallX,
    floorY + 17,
    `SETBACK ${formatLength(geometry.baseSetback, units)}`,
  );
  verticalDimension(
    commands,
    wallX + 18,
    floorY,
    topY,
    `HEIGHT ${formatLength(ladderParams.workingHeight, units)}`,
  );
  const angle = Math.atan2(vertical, setback || 0.001);
  const arcRadius = 25;
  const arcPoints: Array<[number, number]> = [];
  for (let index = 0; index <= 12; index += 1) {
    const theta = (angle * index) / 12;
    arcPoints.push([
      baseX + arcRadius * Math.cos(theta),
      floorY - arcRadius * Math.sin(theta),
    ]);
  }
  commands.push({ kind: "polyline", points: arcPoints, color: "#b45309", width: 1.5, fill: "none" });
  text(commands, baseX + 34, floorY - 10, `${geometry.ladderAngleDegrees}°`, 11, "#92400e", "bold");
  text(
    commands,
    x + 18,
    y + height - 10,
    `Required ladder length ${formatLength(geometry.requiredLength, units)} · overlap ${geometry.minimumOverlap === null ? "manufacturer instructions" : formatLength(geometry.minimumOverlap, units)}`,
    9,
    MUTED,
  );
}

function wrapText(value: string, maxLength: number): string[] {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function addWorkshopNotes(
  commands: SheetCommand[],
  notes: WorkshopNotes,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  panel(commands, x, y, width, height, "ASSEMBLY & CUTTING NOTES", "CHECK ALL SITE DIMENSIONS BEFORE CUTTING");
  const columns = [
    { title: "ASSEMBLY", items: notes.assemblyNotes },
    { title: "CUTTING SEQUENCE", items: notes.cuttingInstructions },
  ];
  const columnWidth = (width - 48) / 2;
  columns.forEach((column, columnIndex) => {
    const columnX = x + 18 + columnIndex * (columnWidth + 12);
    text(commands, columnX, y + 72, column.title, 10, ACCENT, "bold");
    let row = 0;
    for (const [index, item] of column.items.entries()) {
      const wrapped = wrapText(`${index + 1}. ${item}`, 88);
      for (const wrappedLine of wrapped) {
        text(commands, columnX, y + 91 + row * 15, wrappedLine, 9.5, INK);
        row += 1;
        if (row >= 8) break;
      }
      if (row >= 8) break;
    }
  });
}

export function createShopSheetDocument(
  project: ProjectState,
  notes: WorkshopNotes,
): ShopSheetDocument {
  const width = 1400;
  const height = 1180;
  const commands: SheetCommand[] = [
    { kind: "rect", x: 0, y: 0, width, height, stroke: "#ffffff", fill: "#ffffff", lineWidth: 0 },
    { kind: "rect", x: 20, y: 20, width: width - 40, height: height - 40, stroke: INK, fill: "none", lineWidth: 1.5 },
  ];
  text(commands, 42, 54, "STAIR & LADDER SHOP SHEET", 23, INK, "bold");
  text(
    commands,
    width - 42,
    52,
    `${project.units.toUpperCase()} · ${project.projectType.toUpperCase()} · REV 1`,
    11,
    MUTED,
    "bold",
    "end",
  );
  line(commands, 42, 68, width - 42, 68, INK, 1.5);

  addSideElevation(commands, project, 40, 86, 640, 348);
  addTopPlan(commands, project, 700, 86, 660, 348);
  addFrontElevation(commands, project, 40, 450, 420, 318);
  addStringerNotch(commands, project, 480, 450, 420, 318);
  addLadderAngle(commands, project, 920, 450, 440, 318);
  addWorkshopNotes(commands, notes, 40, 784, 1320, 318);

  text(
    commands,
    42,
    height - 32,
    "SCHEMATIC ONLY · Verify field dimensions, material grades, connections, local code, and manufacturer requirements before construction.",
    10,
    MUTED,
  );
  text(commands, width - 42, height - 32, "FLOORPLAN STUDIO · PHASE 2", 9, MUTED, "normal", "end");
  return { width, height, commands };
}

export function renderShopSheetSvg(document: ShopSheetDocument): string {
  const body = document.commands
    .map((command) => {
      switch (command.kind) {
        case "line":
          return `<line x1="${fixed(command.x1)}" y1="${fixed(command.y1)}" x2="${fixed(command.x2)}" y2="${fixed(command.y2)}" stroke="${command.color ?? INK}" stroke-width="${command.width ?? 1}"${command.dash ? ` stroke-dasharray="${command.dash}"` : ""}/>`;
        case "rect":
          return `<rect x="${fixed(command.x)}" y="${fixed(command.y)}" width="${fixed(command.width)}" height="${fixed(command.height)}" stroke="${command.stroke ?? INK}" fill="${command.fill ?? "none"}" stroke-width="${command.lineWidth ?? 1}"/>`;
        case "polyline":
          return `<polyline points="${command.points.map(([x, y]) => `${fixed(x)},${fixed(y)}`).join(" ")}" stroke="${command.color ?? INK}" fill="${command.fill ?? "none"}" stroke-width="${command.width ?? 1}" stroke-linejoin="round" stroke-linecap="round"/>`;
        case "text":
          return `<text x="${fixed(command.x)}" y="${fixed(command.y)}" font-family="Arial, Helvetica, sans-serif" font-size="${command.size ?? 12}" font-weight="${command.weight === "bold" ? "700" : "400"}" fill="${command.color ?? INK}" text-anchor="${command.anchor ?? "start"}">${escapeXml(command.text)}</text>`;
      }
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${document.width}" height="${document.height}" viewBox="0 0 ${document.width} ${document.height}">`,
    `<title>Stair and ladder shop sheet</title>`,
    `<desc>Dimensioned schematic generated from deterministic project geometry.</desc>`,
    `<g shape-rendering="geometricPrecision">${body}</g>`,
    `</svg>`,
  ].join("\n");
}

function pdfEscape(value: string): string {
  return value
    .replace(/°/g, " deg")
    .replace(/[–—]/g, "-")
    .replace(/·/g, "|")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function pdfColor(value: string): [number, number, number] {
  const hex = value.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return [0, 0, 0];
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

function pdfNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

function drawPdfCommand(
  command: SheetCommand,
  document: ShopSheetDocument,
  scale: number,
  offsetX: number,
  offsetY: number,
): string {
  const xy = (x: number, y: number) => [
    offsetX + x * scale,
    offsetY + (document.height - y) * scale,
  ];
  if (command.kind === "text") {
    const [x, y] = xy(command.x, command.y);
    const [r, g, b] = pdfColor(command.color ?? INK);
    const font = command.weight === "bold" ? "F2" : "F1";
    let alignedX = x;
    if (command.anchor === "middle") alignedX -= command.text.length * (command.size ?? 12) * scale * 0.25;
    if (command.anchor === "end") alignedX -= command.text.length * (command.size ?? 12) * scale * 0.5;
    return `${r} ${g} ${b} rg BT /${font} ${pdfNumber((command.size ?? 12) * scale)} Tf 1 0 0 1 ${pdfNumber(alignedX)} ${pdfNumber(y)} Tm (${pdfEscape(command.text)}) Tj ET`;
  }
  if (command.kind === "line" || command.kind === "polyline") {
    const [r, g, b] = pdfColor(command.kind === "line" ? command.color ?? INK : command.color ?? INK);
    const strokeWidth = (command.width ?? 1) * scale;
    const dash = command.kind === "line" && command.dash
      ? `[${command.dash.split(/\s+/).map((part) => pdfNumber(Number(part) * scale)).join(" ")}] 0 d`
      : "[] 0 d";
    const points =
      command.kind === "line"
        ? [[command.x1, command.y1], [command.x2, command.y2]] as Array<[number, number]>
        : command.points;
    const [firstX, firstY] = xy(points[0][0], points[0][1]);
    const path = [
      `${pdfNumber(firstX)} ${pdfNumber(firstY)} m`,
      ...points.slice(1).map(([x, y]) => {
        const [px, py] = xy(x, y);
        return `${pdfNumber(px)} ${pdfNumber(py)} l`;
      }),
      "S",
    ].join(" ");
    return `${r} ${g} ${b} RG ${pdfNumber(strokeWidth)} w ${dash} ${path}`;
  }
  const [strokeR, strokeG, strokeB] = pdfColor(command.stroke ?? INK);
  const [fillR, fillG, fillB] = pdfColor(command.fill ?? "#ffffff");
  const [x, y] = xy(command.x, command.y + command.height);
  const rect = `${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(command.width * scale)} ${pdfNumber(command.height * scale)} re`;
  if (command.fill && command.fill !== "none") {
    return `${fillR} ${fillG} ${fillB} rg ${rect} f ${strokeR} ${strokeG} ${strokeB} RG ${pdfNumber((command.lineWidth ?? 1) * scale)} w ${rect} S`;
  }
  return `${strokeR} ${strokeG} ${strokeB} RG ${pdfNumber((command.lineWidth ?? 1) * scale)} w ${rect} S`;
}

export function buildShopSheetPdf(document: ShopSheetDocument): Uint8Array {
  const pageWidth = 1191;
  const pageHeight = 842;
  const scale = Math.min(pageWidth / document.width, pageHeight / document.height);
  const offsetX = (pageWidth - document.width * scale) / 2;
  const offsetY = (pageHeight - document.height * scale) / 2;
  const content = document.commands
    .map((command) => drawPdfCommand(command, document, scale, offsetX, offsetY))
    .join("\n");
  const encoder = new TextEncoder();
  const stream = `${content}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return encoder.encode(pdf);
}

export function defaultWorkshopNotes(
  project: ProjectState,
): WorkshopNotes {
  const { units, stairParams, ladderParams } = project;
  if (project.projectType === "staircase") {
    const geometry = calculateStairGeometry(stairParams, units);
    return {
      assemblyNotes: [
        `Verify the ${formatLength(stairParams.totalRise, units)} floor-to-floor rise and ${formatLength(stairParams.totalRun, units)} aggregate run at the site before laying out.`,
        `Lay out ${geometry.stepCount} equal risers and ${geometry.treadCount} treads; use the side elevation and notch profile as a dimension reference.`,
        `Confirm stringer bearing, attachment, lumber grade, and handrail/guard details with the approved plan and local authority.`,
        "Dry-fit one stringer and verify level treads, plumb risers, and top/bottom bearing before cutting the remaining stock.",
      ],
      cuttingInstructions: [
        `Mark ${geometry.stepCount} riser positions over the full rise; average rise is ${geometry.unitRiseExact.toFixed(units === "imperial" ? 3 : 1)} ${units === "imperial" ? "in" : "mm"}.`,
        `Lay out ${geometry.treadCount} tread notches using the ${formatLength(geometry.unitRun, units)} unit run and ${geometry.pitchAngleDegrees}° pitch.`,
        `Allow extra stringer stock for end cuts and bearing; the ${formatLength(geometry.stringerLength, units)} stringer line is a geometric reference, not a final blank length.`,
        `Prepare ${geometry.treadCount} tread blanks to the project width of ${formatLength(stairParams.width, units)}; confirm overhang and finish dimensions before cutting.`,
      ],
    };
  }

  const ladder = calculateLadderGeometry(
    ladderParams.workingHeight,
    units,
    ladderParams.ladderType,
  );
  return {
    assemblyNotes: [
      `Set the ${ladderParams.ladderType} ladder on a firm, stable ${ladderParams.surfaceType} surface and inspect rails, feet, locks, and labels.`,
      `For leaning ladders, set the base ${formatLength(ladder.baseSetback, units)} from the support point (1:4 guidance); this does not apply to a step ladder.`,
      "Secure the ladder against movement and follow the ladder manufacturer's instructions for load rating and use.",
      "Keep access clear and maintain three-point contact while climbing; do not use the schematic as a substitute for a site inspection.",
    ],
    cuttingInstructions: [
      `Required ladder length is approximately ${formatLength(ladder.requiredLength, units)} including the access extension where applicable.`,
      ladder.minimumOverlap === null
        ? "Use the manufacturer's extension overlap specifications for this ladder length."
        : `Confirm at least ${formatLength(ladder.minimumOverlap, units)} overlap against the ladder label and manufacturer.`,
      `The setup diagram uses a ${ladder.ladderAngleDegrees}° angle and ${formatLength(ladder.roofExtension, units)} access extension.`,
    ],
  };
}
