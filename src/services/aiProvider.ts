import { useSyncExternalStore } from "react";
import { logAiError, logAiOutput } from "./aiLog";
import {
  DEFAULT_AI_MODELS,
  checkOllamaStatus,
  generateLocalJson,
  generateLocalText,
  type StreamOptions,
} from "./localAiService";
import {
  GeminiRequestError,
  checkGeminiStatus,
  generateWithGemini,
  reloadGeminiConfig,
  type GeminiGenerateResult,
} from "./geminiService";

export type { StreamOptions };

export type AiProvider = "gemini" | "ollama";
export type AiProviderPreference = "auto" | AiProvider;

export type AiStatus = {
  provider: AiProvider;
  online: boolean;
  models: string[];
  baseUrl?: string;
  error?: string;
  configPath?: string;
  missingKeys?: string[];
};

const STORAGE_KEY = "floorplan-studio:ai-provider";
const listeners = new Set<() => void>();

function readPreference(): AiProviderPreference {
  if (typeof localStorage === "undefined") return "auto";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "gemini" || stored === "ollama" ? stored : "auto";
  } catch {
    return "auto";
  }
}

let preference: AiProviderPreference = readPreference();
let activeProvider: AiProvider =
  preference === "auto" ? "ollama" : preference;
let resolution: Promise<AiProvider> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

export function getAiProviderPreference(): AiProviderPreference {
  return preference;
}

export function getActiveAiProvider(): AiProvider {
  return activeProvider;
}

export function setAiProviderPreference(
  next: AiProviderPreference,
): void {
  preference = next;
  activeProvider = next === "auto" ? "ollama" : next;
  resolution = null;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference persistence is best-effort.
    }
  }
  notify();
}

/**
 * Resolve `auto` to Gemini when a key is configured, otherwise Ollama.
 * Explicit preferences are respected even when the selected provider is
 * unavailable, so the UI can show a clear configuration error.
 */
export async function resolveAiProvider(force = false): Promise<AiProvider> {
  if (force) {
    resolution = null;
    activeProvider = preference === "auto" ? "ollama" : preference;
  } else if (resolution) {
    return resolution;
  }

  if (preference !== "auto") {
    activeProvider = preference;
    return activeProvider;
  }

  resolution = (async () => {
    try {
      const gemini = await checkGeminiStatus();
      activeProvider = gemini.configured ? "gemini" : "ollama";
    } catch {
      activeProvider = "ollama";
    }
    notify();
    return activeProvider;
  })();
  return resolution;
}

export function subscribeAiProvider(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAiProvider(): AiProvider {
  return useSyncExternalStore(
    subscribeAiProvider,
    getActiveAiProvider,
    () => "ollama",
  );
}

export function useAiProviderPreference(): AiProviderPreference {
  return useSyncExternalStore(
    subscribeAiProvider,
    getAiProviderPreference,
    () => "auto",
  );
}

function combinedPrompt(
  prompt: string,
  systemInstruction: string | undefined,
): string {
  return systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
}

export async function generateAiText(
  prompt: string,
  options: StreamOptions = {},
): Promise<string> {
  const provider = await resolveAiProvider();
  if (provider !== "gemini") {
    return generateLocalText(combinedPrompt(prompt, options.systemInstruction), options);
  }

  const operation = options.operation ?? "gemini-text";
  try {
    const result = await generateWithGemini(
      {
        prompt,
        systemInstruction: options.systemInstruction,
        model: options.model,
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.numPredict ?? 2_048,
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        onChunk: options.onChunk,
      },
    );
    await logAiOutput(operation, result.model, result.text);
    return result.text;
  } catch (error) {
    await logAiError(operation, options.model ?? "gemini", error);
    throw error;
  }
}

export async function generateAiJson(
  prompt: string,
  options: StreamOptions = {},
  format: unknown = "json",
): Promise<string> {
  const provider = await resolveAiProvider();
  if (provider !== "gemini") {
    return generateLocalJson(
      combinedPrompt(prompt, options.systemInstruction),
      options,
      format,
    );
  }

  const operation = options.operation ?? "gemini-json";
  const schema = format && format !== "json" ? format : undefined;
  const run = (withSchema: boolean) =>
    generateWithGemini(
      {
        prompt,
        systemInstruction: options.systemInstruction,
        model: options.model,
        temperature: options.temperature ?? 0.1,
        maxOutputTokens: options.numPredict ?? 2_048,
        responseMimeType: "application/json",
        responseJsonSchema: withSchema ? schema : undefined,
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        onChunk: options.onChunk,
      },
    );

  try {
    let result: GeminiGenerateResult;
    try {
      result = await run(Boolean(schema));
    } catch (error) {
      // Some JSON Schema constructs are not accepted by the structured-output
      // endpoint. Fall back to plain JSON mode and let the caller validate.
      if (
        schema &&
        error instanceof GeminiRequestError &&
        error.status === 400 &&
        /schema|json|payload|invalid/i.test(error.message)
      ) {
        result = await run(false);
      } else {
        throw error;
      }
    }
    await logAiOutput(operation, result.model, result.text);
    return result.text;
  } catch (error) {
    await logAiError(operation, options.model ?? "gemini", error);
    throw error;
  }
}

export async function checkAiStatus(
  provider?: AiProvider,
  signal?: AbortSignal,
): Promise<AiStatus> {
  const target = provider ?? (await resolveAiProvider());
  if (target === "gemini") {
    const status = await checkGeminiStatus();
    return {
      provider: "gemini",
      online: status.configured,
      models: [...new Set([status.model, status.fastModel].filter(Boolean))],
      baseUrl: "Gemini API",
      error: status.error,
      configPath: status.path,
      missingKeys: status.missingKeys,
    };
  }

  const status = await checkOllamaStatus(signal);
  return {
    provider: "ollama",
    online: status.online,
    models: status.models.length > 0 ? status.models : DEFAULT_AI_MODELS,
    baseUrl: status.baseUrl,
    error: status.error,
  };
}

export async function reloadAiProvider(): Promise<AiStatus> {
  resolution = null;
  activeProvider = preference === "auto" ? "ollama" : preference;
  await reloadGeminiConfig();
  const provider = await resolveAiProvider(true);
  return checkAiStatus(provider);
}
