import { isTauriRuntime } from "../utils/fileIO";
import { logAiError, logAiOutput } from "./aiLog";

export const OLLAMA_BASE_URL = "http://localhost:11434";
export const OLLAMA_GENERATE_URL = `${OLLAMA_BASE_URL}/api/generate`;
export const DEFAULT_AI_MODELS = ["llama3.2", "qwen2.5", "mistral"];
export const AI_TIMEOUT_RESPONSE_WINDOW_MS = 10_000;

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
  numPredict?: number;
  numContext?: number;
  timeoutMs?: number;
  /** Optional instruction kept separate for providers that support system prompts. */
  systemInstruction?: string;
  /** Optional sampling temperature; defaults are provider-specific. */
  temperature?: number;
  /** Called when the request timeout is reached; choose whether to keep waiting. */
  onTimeout?: (respond: (continueWaiting: boolean) => void) => void;
  /** Called when no timeout decision was made within the response window. */
  onTimeoutExpired?: () => void;
  /** Ask whether to continue after a structured-generation retry batch fails. */
  onRetryLimit?: (details: {
    stage: string;
    attempts: number;
    batch: number;
    error: string;
  }) => Promise<boolean>;
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
        options: { temperature: options.temperature ?? 0.2 },
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
  let graceTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  const timeoutDecision = {
    current: null as ((continueWaiting: boolean) => void) | null,
  };
  const clearGraceTimeout = () => {
    if (graceTimeout !== null) {
      globalThis.clearTimeout(graceTimeout);
      graceTimeout = null;
    }
  };
  const controllerAbortHandler = () => clearGraceTimeout();
  controller.signal.addEventListener("abort", controllerAbortHandler);

  const timeout = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    if (!options.onTimeout) {
      controller.abort();
      return;
    }

    let decisionMade = false;
    const respond = (continueWaiting: boolean) => {
      if (decisionMade) return;
      decisionMade = true;
      clearGraceTimeout();
      timeoutDecision.current = null;
      if (!continueWaiting) controller.abort();
    };
    timeoutDecision.current = respond;
    graceTimeout = globalThis.setTimeout(() => {
      try {
        options.onTimeoutExpired?.();
      } catch {
        // The request must still be canceled if timeout UI cleanup fails.
      }
      respond(false);
    }, AI_TIMEOUT_RESPONSE_WINDOW_MS);

    try {
      options.onTimeout(respond);
    } catch {
      respond(false);
    }
  }, options.timeoutMs ?? 90_000);
  const abortHandler = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", abortHandler);
  }

  try {
    const response = await aiFetch(OLLAMA_GENERATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: Boolean(options.onChunk),
        format,
        options: {
          temperature: options.temperature ?? 0.1,
          num_predict: options.numPredict ?? 512,
          num_ctx: options.numContext ?? 4096,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Ollama request failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
      );
    }

    let output = "";
    if (options.onChunk) {
      const parseLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let payload: { response?: string; error?: string };
        try {
          payload = JSON.parse(trimmed) as {
            response?: string;
            error?: string;
          };
        } catch {
          return;
        }
        if (payload.error) throw new Error(payload.error);
        if (typeof payload.response === "string") {
          output += payload.response;
          options.onChunk?.(payload.response);
        }
      };

      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
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
        } finally {
          reader.releaseLock();
        }
      } else {
        const text = await response.text();
        for (const line of text.split("\n")) parseLine(line);
      }
    } else {
      const payload = (await response.json()) as {
        response?: string;
        error?: string;
      };
      if (payload.error) throw new Error(payload.error);
      if (typeof payload.response === "string") output = payload.response;
    }

    if (!output.trim()) {
      throw new Error("Ollama returned an empty JSON response.");
    }
    const result = output.trim();
    await logAiOutput(operation, model, result);
    return result;
  } catch (error) {
    await logAiError(operation, model, error);
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    timeoutDecision.current?.(true);
    clearGraceTimeout();
    controller.signal.removeEventListener("abort", controllerAbortHandler);
    options.signal?.removeEventListener("abort", abortHandler);
  }
}
