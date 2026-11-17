import { generateLocalJson, type StreamOptions } from "../services/localAiService";
import { logAiError } from "../services/aiLog";
import { runBuildingCodeAudit } from "./buildingCodeAudit";
import { feetToProjectUnits, inchesToProjectUnits } from "./units";
import type {
  AuditReport,
  EngineeringUnits,
  ProjectParametersPatch,
  ProjectState,
  StairStyle,
} from "./types";

export const DESIGN_TOOL_SCHEMAS = [
  {
    name: "updateDesignParameters",
    description:
      "Apply explicitly requested staircase or ladder design parameters. Never calculate geometry or code compliance.",
    parameters: {
      type: "object",
      properties: {
        projectType: { type: "string", enum: ["staircase", "ladder"] },
        units: { type: "string", enum: ["imperial", "metric"] },
        stairParams: {
          type: "object",
          properties: {
            style: {
              type: "string",
              enum: ["straight", "l-shaped", "u-shaped", "spiral"],
            },
            totalRise: { type: "number" },
            totalRun: { type: "number" },
            width: { type: "number" },
            landingLength: { type: "number" },
            spiralRadius: { type: "number" },
            spiralTurns: { type: "number" },
            headroomCeilingHeight: { type: "number" },
            headroomClearance: { type: ["number", "null"] },
            balusterSpacingMax: { type: "number" },
          },
          additionalProperties: false,
        },
        ladderParams: {
          type: "object",
          properties: {
            workingHeight: { type: "number" },
            ladderType: {
              type: "string",
              enum: ["extension", "single", "step"],
            },
            surfaceType: {
              type: "string",
              enum: ["concrete", "wood", "soil", "other"],
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "auditBuildingCode",
    description:
      "Run the deterministic building-code audit on the current calculated project state.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

type DesignToolCall =
  | { tool: "updateDesignParameters"; arguments: ProjectParametersPatch }
  | { tool: "auditBuildingCode"; arguments: Record<string, never> };

type CopilotResult = {
  response: string;
  patch?: ProjectParametersPatch;
  audit?: AuditReport;
  source: "local-model" | "offline-parser";
};

const DIMENSION =
  /(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*(?:-\s*)?(inches?|in|mm|millimeters?|cm|centimeters?|ft|feet|foot|')/gi;

function parseNumber(value: string): number {
  const mixed = value.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  if (value.includes("/")) {
    const [numerator, denominator] = value.split("/").map(Number);
    return denominator ? numerator / denominator : Number.NaN;
  }
  return Number(value);
}

function dimensionInProjectUnits(
  value: number,
  unit: string,
  projectUnits: EngineeringUnits,
) {
  const normalized = unit.toLowerCase();
  const inches =
    normalized.startsWith("ft") ||
    normalized === "feet" ||
    normalized === "foot" ||
    normalized === "'"
      ? value * 12
      : normalized.startsWith("mm")
        ? value / 25.4
        : normalized.startsWith("cm")
          ? value / 2.54
          : value;
  return projectUnits === "imperial"
    ? inchesToProjectUnits(inches, "imperial")
    : feetToProjectUnits(inches / 12, "metric");
}

function inferDimensionTarget(
  before: string,
  after: string,
): "totalRise" | "totalRun" | "width" | "workingHeight" | "headroomClearance" | "headroomCeilingHeight" | "balusterSpacingMax" | "landingLength" | "spiralRadius" | null {
  const labels = [
    ["workingHeight", /\bworking\s+height\b|\bladder\s+height\b/gi],
    ["headroomClearance", /\bheadroom\b|\bclearance\b/gi],
    ["balusterSpacingMax", /\bbaluster\b|\bguard\s+spacing\b|\bopening\s+spacing\b/gi],
    ["width", /\b(?:stair(?:case)?\s+)?width\b/gi],
    ["landingLength", /\blanding(?:\s+(?:length|size))?\b/gi],
    ["spiralRadius", /\bspiral\s+radius\b|\b(?:inner|outer)\s+radius\b/gi],
    ["totalRun", /\bhallway\b|\bhorizontal\b|\btotal\s+run\b|\brun\b|\blength\b/gi],
    ["headroomCeilingHeight", /\bceiling\s+height\b/gi],
    ["totalRise", /\bfloor[- ]to[- ]floor\b|\btotal\s+rise\b|\brise\b|\bvertical\s+height\b/gi],
  ] as const;
  let closest:
    | {
        target: (typeof labels)[number][0];
        distance: number;
      }
    | undefined;

  for (const [target, expression] of labels) {
    expression.lastIndex = 0;
    for (const match of before.matchAll(expression)) {
      const distance = before.length - (match.index ?? 0) - match[0].length;
      if (!closest || distance < closest.distance) closest = { target, distance };
    }
    expression.lastIndex = 0;
    for (const match of after.matchAll(expression)) {
      const distance = match.index ?? 0;
      if (!closest || distance < closest.distance) closest = { target, distance };
    }
  }
  return closest?.target ?? null;
}

/**
 * Small, explicit offline command parser for common dimensions and design
 * attributes. It only extracts requested parameters; all resulting geometry
 * and audits still come from the deterministic calculation modules.
 */
export function parseOfflineDesignRequest(
  request: string,
  state: Pick<ProjectState, "units">,
): ProjectParametersPatch | null {
  const patch: ProjectParametersPatch = {};
  const text = request.toLowerCase();
  const styleMatch = text.match(/\b(u[- ]shaped|l[- ]shaped|spiral|straight)\b/);
  if (styleMatch) {
    const styleText = styleMatch[1].replace(" ", "-") as StairStyle;
    patch.stairParams = { style: styleText };
    patch.projectType = "staircase";
  }
  const spiralTurnsMatch = text.match(
    /\b(\d+(?:\.\d+)?)\s*(?:full\s+)?turns?\b/,
  );
  if (spiralTurnsMatch) {
    patch.projectType = "staircase";
    patch.stairParams = {
      ...patch.stairParams,
      style: "spiral",
      spiralTurns: Number(spiralTurnsMatch[1]),
    };
  }
  if (/\b(ladder|setback|extension ladder|step ladder)\b/.test(text)) {
    patch.projectType = "ladder";
    const ladderParams: NonNullable<ProjectParametersPatch["ladderParams"]> = {};
    if (/\bextension\b/.test(text)) ladderParams.ladderType = "extension";
    else if (/\bstep ladder\b/.test(text)) ladderParams.ladderType = "step";
    const surface = text.match(/\b(concrete|wood|soil|ground)\b/);
    if (surface) {
      ladderParams.surfaceType = surface[1] === "ground" ? "soil" : surface[1] as "concrete" | "wood" | "soil";
    }
    patch.ladderParams = { ...patch.ladderParams, ...ladderParams };
  }
  if (/\b(?:use|switch to|set units to|in)\s+metric\b|\bmetric units\b/.test(text)) {
    patch.units = "metric";
  } else if (
    /\b(?:use|switch to|set units to|in)\s+imperial\b|\bimperial units\b/.test(
      text,
    )
  ) {
    patch.units = "imperial";
  }

  const targetUnits = patch.units ?? state.units;
  const matches = [...request.matchAll(DIMENSION)];
  for (const match of matches) {
    const number = parseNumber(match[1]);
    if (!Number.isFinite(number)) continue;
    const index = match.index ?? 0;
    const separators = /[,;]|\s+\b(?:and|then)\b\s+/gi;
    const precedingText = request.slice(0, index);
    const precedingSeparators = [...precedingText.matchAll(separators)];
    const lastSeparator =
      precedingSeparators[precedingSeparators.length - 1];
    const segmentStart =
      lastSeparator
        ? (lastSeparator.index ?? 0) + lastSeparator[0].length
        : Math.max(0, index - 48);
    const afterIndex = index + match[0].length;
    const followingText = request.slice(afterIndex);
    separators.lastIndex = 0;
    const nextSeparator = separators.exec(followingText);
    const segmentEnd =
      nextSeparator?.index === undefined
        ? afterIndex + 48
        : afterIndex + nextSeparator.index;
    const before = request.slice(segmentStart, index);
    const after = request.slice(afterIndex, segmentEnd);
    const target = inferDimensionTarget(before, after);
    if (!target) continue;
    const value = dimensionInProjectUnits(number, match[2], targetUnits);
    if (target === "workingHeight") {
      patch.projectType = "ladder";
      patch.ladderParams = {
        ...patch.ladderParams,
        workingHeight: value,
      };
    } else {
      patch.projectType ??= "staircase";
      patch.stairParams = {
        ...patch.stairParams,
        [target]: value,
      };
    }
  }

  return Object.keys(patch).length ? patch : null;
}

function isValidToolCall(value: unknown): value is DesignToolCall {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.arguments || typeof candidate.arguments !== "object") return false;
  if (candidate.tool === "auditBuildingCode") return true;
  if (candidate.tool !== "updateDesignParameters") return false;
  const args = candidate.arguments as Record<string, unknown>;
  return (
    (args.projectType === undefined ||
      args.projectType === "staircase" ||
      args.projectType === "ladder") &&
    (args.units === undefined ||
      args.units === "imperial" ||
      args.units === "metric")
  );
}

function sanitizeToolCall(call: DesignToolCall): DesignToolCall {
  if (call.tool === "auditBuildingCode") {
    return { tool: call.tool, arguments: {} };
  }
  const args = call.arguments as Record<string, unknown>;
  const result: ProjectParametersPatch = {};
  if (args.projectType === "staircase" || args.projectType === "ladder") {
    result.projectType = args.projectType;
  }
  if (args.units === "imperial" || args.units === "metric") {
    result.units = args.units;
  }
  const stairSource =
    args.stairParams && typeof args.stairParams === "object"
      ? (args.stairParams as Record<string, unknown>)
      : {};
  const stairParams: NonNullable<ProjectParametersPatch["stairParams"]> = {};
  if (
    stairSource.style === "straight" ||
    stairSource.style === "l-shaped" ||
    stairSource.style === "u-shaped" ||
    stairSource.style === "spiral"
  ) {
    stairParams.style = stairSource.style;
  }
  for (const key of [
    "totalRise",
    "totalRun",
    "width",
    "landingLength",
    "spiralRadius",
    "headroomCeilingHeight",
    "headroomClearance",
    "balusterSpacingMax",
  ] as const) {
    const value = stairSource[key];
    if (
      (typeof value === "number" && Number.isFinite(value)) ||
      (key === "headroomClearance" && value === null)
    ) {
      (stairParams as Record<string, number | null>)[key] = value as
        | number
        | null;
    }
  }
  if (
    typeof stairSource.spiralTurns === "number" &&
    Number.isFinite(stairSource.spiralTurns)
  ) {
    stairParams.spiralTurns = stairSource.spiralTurns;
  }
  if (Object.keys(stairParams).length > 0) result.stairParams = stairParams;

  const ladderSource =
    args.ladderParams && typeof args.ladderParams === "object"
      ? (args.ladderParams as Record<string, unknown>)
      : {};
  const ladderParams: NonNullable<ProjectParametersPatch["ladderParams"]> = {};
  if (
    typeof ladderSource.workingHeight === "number" &&
    Number.isFinite(ladderSource.workingHeight)
  ) {
    ladderParams.workingHeight = ladderSource.workingHeight;
  }
  if (
    ladderSource.ladderType === "extension" ||
    ladderSource.ladderType === "single" ||
    ladderSource.ladderType === "step"
  ) {
    ladderParams.ladderType = ladderSource.ladderType;
  }
  if (
    ladderSource.surfaceType === "concrete" ||
    ladderSource.surfaceType === "wood" ||
    ladderSource.surfaceType === "soil" ||
    ladderSource.surfaceType === "other"
  ) {
    ladderParams.surfaceType = ladderSource.surfaceType;
  }
  if (Object.keys(ladderParams).length > 0) result.ladderParams = ladderParams;
  return { tool: call.tool, arguments: result };
}

function responseFormat() {
  return {
    type: "object",
    properties: {
      tool: {
        type: "string",
        enum: ["updateDesignParameters", "auditBuildingCode"],
      },
      arguments: { type: "object" },
      message: { type: "string" },
    },
    required: ["tool", "arguments", "message"],
  };
}

export async function requestDesignToolCall(
  request: string,
  state: ProjectState,
  options: StreamOptions = {},
): Promise<{ toolCall: DesignToolCall; message: string }> {
  const schemas = DESIGN_TOOL_SCHEMAS.map((tool) => JSON.stringify(tool)).join("\n");
  const raw = await generateLocalJson(
    [
      "You are a parameter-extraction copilot for a stair and ladder calculator.",
      "Return only the JSON schema requested. Do not calculate geometry, safety, code compliance, angles, or dimensions.",
      `Available function tools:\n${schemas}`,
      `Current units: ${state.units}. Dimensions in tool arguments must use these units (inches for imperial, mm for metric).`,
      "Only include parameter values explicitly requested or unambiguously stated by the user. Use auditBuildingCode if the user asks for a code/safety audit.",
      `User request: ${request}`,
    ].join("\n\n"),
    { ...options, operation: options.operation ?? "stairs-design-copilot" },
    responseFormat(),
  );
  try {
    const parsed = JSON.parse(raw) as {
      tool?: unknown;
      arguments?: unknown;
      message?: unknown;
    };
    const toolCall = { tool: parsed.tool, arguments: parsed.arguments };
    if (!isValidToolCall(toolCall)) {
      throw new Error("The local model returned an invalid design tool call.");
    }
    return {
      toolCall: sanitizeToolCall(toolCall),
      message:
        typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : "I extracted the requested design update.",
    };
  } catch (error) {
    await logAiError(
      "stairs-design-copilot-output-validation",
      options.model?.trim() || "llama3.2",
      error,
    );
    throw error;
  }
}

export async function runOfflineDesignRequest(
  request: string,
  state: ProjectState,
): Promise<CopilotResult> {
  if (/\b(audit|compliance|safe|safety|code check)\b/i.test(request)) {
    const audit = runBuildingCodeAudit(state);
    return {
      response: `Deterministic audit complete: ${audit.passCount} passed, ${audit.failCount} failed, ${audit.warningCount} warnings.`,
      audit,
      source: "offline-parser",
    };
  }
  const patch = parseOfflineDesignRequest(request, state);
  if (!patch) {
    return {
      response:
        "I couldn't identify a supported parameter. Try “set rise to 108 inches, run to 120 inches, L-shaped” or “ladder working height 12 feet.”",
      source: "offline-parser",
    };
  }
  return {
    response: "I extracted a parameter update. Review the calculated metrics and compliance findings below.",
    patch,
    source: "offline-parser",
  };
}

export type { CopilotResult, DesignToolCall };
