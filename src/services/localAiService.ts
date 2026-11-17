import type { Opening, Wall } from "../types/floorplan";
import { isTauriRuntime } from "../utils/fileIO";
import { wallLength } from "../utils/geometry";
import { runComplianceChecks } from "../utils/spatialRules";
import { logAiError, logAiOutput } from "./aiLog";

export const OLLAMA_BASE_URL = "http://localhost:11434";
export const OLLAMA_GENERATE_URL = `${OLLAMA_BASE_URL}/api/generate`;
export const DEFAULT_AI_MODELS = ["llama3.2", "qwen2.5", "mistral"];

export type OllamaStatus = {
  online: boolean;
  models: string[];
  baseUrl: string;
  error?: string;
};

export type StreamOptions = {
  model?: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  /** Log label only; this value is never sent to the local model. */
  operation?: string;
};

type OllamaTag = {
  name?: string;
  model?: string;
};

async function aiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  return typeof window !== "undefined"
    ? window.fetch(input, init)
    : fetch(input, init);
}

export async function checkOllamaStatus(
  signal?: AbortSignal,
): Promise<OllamaStatus> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 2200);
  const abortHandler = () => controller.abort();
  signal?.addEventListener("abort", abortHandler);

  try {
    const response = await aiFetch(`${OLLAMA_BASE_URL}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama responded with ${response.status}`);
    }

    const data = (await response.json()) as { models?: OllamaTag[] };
    const models = (data.models ?? [])
      .map((model) => model.name ?? model.model)
      .filter((model): model is string => Boolean(model));

    return {
      online: true,
      models,
      baseUrl: OLLAMA_BASE_URL,
    };
  } catch (error) {
    await logAiError("ollama-status-check", "Ollama", error);
    return {
      online: false,
      models: [],
      baseUrl: OLLAMA_BASE_URL,
      error:
        error instanceof Error
          ? error.message
          : "Unable to reach the local Ollama server",
    };
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortHandler);
  }
}

function buildPlanContext(walls: Wall[], openings: Opening[]) {
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

function buildSystemPrompt() {
  return [
    "You are an expert architectural code and spatial-compliance inspector embedded in a desktop floor-plan editor.",
    "Analyze the supplied plan geometry and deterministic rule results.",
    "Reference relevant concerns such as egress width, ADA accessibility, circulation, wall connectivity, room proportions, and door swing space.",
    "Be concise, practical, and specific. Use short bullet points with a severity label such as INFO, WARNING, or CRITICAL.",
    "Do not invent measurements that are not present in the supplied scene data.",
  ].join(" ");
}

async function streamOllama(
  prompt: string,
  options: StreamOptions,
): Promise<string> {
  const model = options.model?.trim() || "llama3.2";
  const operation = options.operation ?? "local-text-generation";
  try {
    const response = await aiFetch(OLLAMA_GENERATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        options: { temperature: 0.2 },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Ollama request failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
      );
    }

    let fullText = "";
    const emit = (chunk: string) => {
      if (!chunk) return;
      fullText += chunk;
      options.onChunk?.(chunk);
    };

    const parseLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload: { response?: string; error?: string };
      try {
        payload = JSON.parse(trimmed) as { response?: string; error?: string };
      } catch {
        return;
      }
      if (payload.error) throw new Error(payload.error);
      if (typeof payload.response === "string") emit(payload.response);
    };

    const canStream =
      response.body && typeof response.body.getReader === "function";

    if (canStream && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) parseLine(line);
      }

      buffer += decoder.decode();
      parseLine(buffer);
    } else {
      const text = await response.text();
      for (const line of text.split("\n")) parseLine(line);
    }

    if (!fullText.trim()) {
      throw new Error("Ollama returned an empty response.");
    }
    const output = fullText.trim();
    await logAiOutput(operation, model, output);
    return output;
  } catch (error) {
    await logAiError(operation, model, error);
    throw error;
  }
}

export function generateLocalText(
  prompt: string,
  options: StreamOptions = {},
): Promise<string> {
  return streamOllama(prompt, {
    ...options,
    operation: options.operation ?? "local-text-generation",
  });
}

export async function generateLocalJson(
  prompt: string,
  options: StreamOptions = {},
  format: unknown = "json",
): Promise<string> {
  const model = options.model?.trim() || "llama3.2";
  const operation = options.operation ?? "structured-local-generation";
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 90_000);
  const abortHandler = () => controller.abort();
  options.signal?.addEventListener("abort", abortHandler);

  try {
    const response = await aiFetch(OLLAMA_GENERATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format,
        options: { temperature: 0.1, num_predict: 128, num_ctx: 4096 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Ollama request failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
      );
    }

    const payload = (await response.json()) as { response?: string; error?: string };
    if (payload.error) throw new Error(payload.error);
    if (typeof payload.response !== "string" || !payload.response.trim()) {
      throw new Error("Ollama returned an empty JSON furniture suggestion.");
    }
    const output = payload.response.trim();
    await logAiOutput(operation, model, output);
    return output;
  } catch (error) {
    await logAiError(operation, model, error);
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortHandler);
  }
}

export function analyzeComplianceWithLLM(
  walls: Wall[],
  openings: Opening[],
  options: StreamOptions = {},
): Promise<string> {
  const prompt = [
    buildSystemPrompt(),
    "",
    "Perform a full spatial compliance audit of this floor plan.",
    buildPlanContext(walls, openings),
    "",
    "Return 4 to 7 prioritized findings. End with one short recommended next step.",
  ].join("\n");

  return streamOllama(prompt, {
    ...options,
    operation: options.operation ?? "floorplan-compliance-audit",
  });
}

export function askPlanQuestion(
  question: string,
  walls: Wall[],
  openings: Opening[],
  options: StreamOptions = {},
): Promise<string> {
  const prompt = [
    buildSystemPrompt(),
    "",
    `User question: ${question}`,
    buildPlanContext(walls, openings),
    "",
    "Answer the question directly using the scene data. If the plan does not contain enough information, say what is missing.",
  ].join("\n");

  return streamOllama(prompt, {
    ...options,
    operation: options.operation ?? "floorplan-question",
  });
}
