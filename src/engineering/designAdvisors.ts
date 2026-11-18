import { generateLocalJson } from "../services/localAiService";
import type { MaterialLine } from "./billOfMaterials";
import type { ProjectState } from "./types";

export type AdvisorResult = {
  source: "local-model" | "offline";
  advice: string[];
  disclaimer: string;
};

export type CostEstimate = {
  currency: "USD";
  low: number;
  high: number;
  assumptions: string[];
};

const ADVISOR_DISCLAIMER =
  "Advisory only; not a structural design, stamped calculation, code approval, quote, or purchasing recommendation.";

function parseAdvice(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("advice" in parsed) ||
    !Array.isArray(parsed.advice) ||
    !parsed.advice.every((item) => typeof item === "string")
  ) {
    throw new Error("The local model returned an invalid advisor response.");
  }
  return parsed.advice
    .map((item) => item.trim().replace(/\s+/g, " ").slice(0, 300))
    .filter(Boolean)
    .slice(0, 8);
}

function offlineStructuralAdvice(project: ProjectState): string[] {
  const metrics = project.calculatedMetrics;
  if (project.projectType === "ladder") {
    return [
      `Verify the ladder's duty rating, maximum load, rail condition, feet, locks, and required overlap against the maker's label before use; the calculated reach is ${metrics.ladderRequiredLength} ${project.units}.`,
      "Use the deterministic setback and angle as a setup reference only; confirm the actual support point, surface, tie-off, and site hazards.",
      "Do not repair or use damaged equipment; remove it from service and follow the employer's inspection procedure.",
    ];
  }
  const advice = [
    `The calculated stringer line is ${metrics.stringerLength} ${project.units}. A qualified designer should verify member species/grade, unsupported span, bearing, connections, and deflection for the actual loads.`,
    "Confirm tread/riser dimensions, guards, handrails, landings, and headroom against the locally adopted code and field measurements.",
  ];
  if (metrics.stringerLength > (project.units === "imperial" ? 120 : 3048)) {
    advice.push(
      "The geometric stringer line is relatively long; ask a qualified structural professional whether intermediate support or a different framing scheme is appropriate. No load capacity is calculated here.",
    );
  }
  if (project.stairParams.style === "spiral") {
    advice.push(
      "Spiral stair support, center-post connections, tread cantilevers, and guard attachment require project-specific structural design.",
    );
  }
  return advice;
}

export async function requestStructuralAdvice(
  project: ProjectState,
  model?: string,
): Promise<AdvisorResult> {
  const fallback = offlineStructuralAdvice(project);
  if (!model) {
    return { source: "offline", advice: fallback, disclaimer: ADVISOR_DISCLAIMER };
  }
  try {
    const facts = {
      projectType: project.projectType,
      units: project.units,
      style: project.stairParams.style,
      stair: project.stairParams,
      ladder: project.ladderParams,
      deterministicMetrics: project.calculatedMetrics,
    };
    const raw = await generateLocalJson(
      [
        "You are an advisory-only construction checklist assistant.",
        "Do not calculate loads, capacities, spans, code compliance, or member sizes.",
        "Use only provided deterministic facts. Never present a guess as verified.",
        "Return JSON exactly as {\"advice\":[\"...\"]} with 3 to 6 concise, cautious suggestions.",
        "Explicitly direct the user to a qualified structural professional for load, deflection, connection, bearing, and material-grade decisions.",
        `Verified project facts: ${JSON.stringify(facts)}`,
      ].join("\n"),
      { model, operation: "stairs-structural-advisor" },
      {
        type: "object",
        properties: { advice: { type: "array", items: { type: "string" } } },
        required: ["advice"],
        additionalProperties: false,
      },
    );
    const advice = parseAdvice(raw);
    return {
      source: "local-model",
      advice: advice.length ? advice : fallback,
      disclaimer: ADVISOR_DISCLAIMER,
    };
  } catch {
    return { source: "offline", advice: fallback, disclaimer: ADVISOR_DISCLAIMER };
  }
}

const UNIT_COST_RANGES: Record<string, [number, number]> = {
  "stringer-": [25, 70],
  treads: [12, 35],
  risers: [6, 20],
  balusters: [4, 18],
  handrail: [18, 60],
  "tread-fasteners": [0.15, 0.6],
  "landing-frames": [18, 45],
  "spiral-center-post": [100, 450],
  "ladder-assembly": [120, 900],
  "ladder-inspection-tags": [3, 20],
};

function unitPriceRange(line: MaterialLine): [number, number] {
  const entry = Object.entries(UNIT_COST_RANGES).find(([key]) =>
    line.id.startsWith(key),
  );
  return entry?.[1] ?? [0, 0];
}

/** Illustrative placeholder ranges; they are not current or regional supplier prices. */
export function estimateIllustrativeMaterialCost(lines: MaterialLine[]): CostEstimate {
  const total = lines.reduce(
    ([low, high], line): [number, number] => {
      const [unitLow, unitHigh] = unitPriceRange(line);
      return [
        low + unitLow * line.quantity,
        high + unitHigh * line.quantity,
      ];
    },
    [0, 0] as [number, number],
  );
  return {
    currency: "USD",
    low: Math.round(total[0]),
    high: Math.round(total[1]),
    assumptions: [
      "Broad illustrative U.S. planning ranges only; replace with local supplier quotes.",
      "Excludes tax, delivery, labor, finish, waste, concrete, engineered hardware, permits, and site-specific design.",
      "Quantities are preliminary and may not capture every required component or cut allowance.",
    ],
  };
}

export async function requestCostSourcingAdvice(
  project: ProjectState,
  lines: MaterialLine[],
  model?: string,
): Promise<AdvisorResult> {
  const estimate = estimateIllustrativeMaterialCost(lines);
  const fallback = [
    `Illustrative material-only planning range: $${estimate.low}–$${estimate.high} USD before tax, delivery, labor, finishes, waste, and engineered hardware. Replace the placeholder rates with local supplier quotes.`,
    "Compare grade-stamped structural stock and manufacturer-listed connectors; do not substitute a lower grade based only on price.",
    "Ask suppliers about standard lengths, availability, treatment, moisture condition, lead time, and return policy; keep the approved design's material specification.",
  ];
  if (!model) {
    return { source: "offline", advice: fallback, disclaimer: ADVISOR_DISCLAIMER };
  }
  try {
    const context = {
      projectType: project.projectType,
      units: project.units,
      materialLines: lines.map(({ item, material, quantity, unit, cutLength, stockProfile }) => ({
        item, material, quantity, unit, cutLength, stockProfile,
      })),
      deterministicIllustrativeRange: estimate,
    };
    const raw = await generateLocalJson(
      [
        "You are an advisory-only materials sourcing assistant.",
        "Do not invent live prices, suppliers, availability, or quotations. Do not change or recompute the provided estimate.",
        "Return JSON exactly as {\"advice\":[\"...\"]} with 3 to 6 practical sourcing suggestions.",
        "State that prices are illustrative and require local quotes. Do not authorize substitutions that change structural design.",
        `Verified project/BOM and deterministic estimate: ${JSON.stringify(context)}`,
      ].join("\n"),
      { model, operation: "stairs-material-cost-advisor" },
      {
        type: "object",
        properties: { advice: { type: "array", items: { type: "string" } } },
        required: ["advice"],
        additionalProperties: false,
      },
    );
    const advice = parseAdvice(raw);
    return {
      source: "local-model",
      advice: advice.length ? advice : fallback,
      disclaimer: ADVISOR_DISCLAIMER,
    };
  } catch {
    return { source: "offline", advice: fallback, disclaimer: ADVISOR_DISCLAIMER };
  }
}
