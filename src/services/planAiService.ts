import type { Opening, Wall } from "../types/floorplan";
import { generateAiText, type StreamOptions } from "./aiProvider";
import { buildPlanContext, buildSystemPrompt } from "./planContext";

export function analyzeComplianceWithAI(
  walls: Wall[],
  openings: Opening[],
  options: StreamOptions = {},
): Promise<string> {
  const prompt = [
    "Perform a full spatial compliance audit of this floor plan.",
    buildPlanContext(walls, openings),
    "",
    "Return 4 to 7 prioritized findings. End with one short recommended next step.",
  ].join("\n");

  return generateAiText(prompt, {
    ...options,
    systemInstruction: buildSystemPrompt(),
    operation: options.operation ?? "floorplan-compliance-audit",
  });
}

export function askPlanQuestionWithAI(
  question: string,
  walls: Wall[],
  openings: Opening[],
  options: StreamOptions = {},
): Promise<string> {
  const trimmed = question.trim();
  if (!trimmed) {
    return Promise.reject(new Error("Ask a question about the floor plan first."));
  }

  const prompt = [
    `User question: ${trimmed}`,
    buildPlanContext(walls, openings),
    "",
    "Answer the question directly using the scene data. If the plan does not contain enough information, say what is missing.",
  ].join("\n");

  return generateAiText(prompt, {
    ...options,
    systemInstruction: buildSystemPrompt(),
    operation: options.operation ?? "floorplan-question",
  });
}
