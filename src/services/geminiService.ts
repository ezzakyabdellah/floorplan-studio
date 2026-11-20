import {
  ApiError,
  GoogleGenAI,
  type GenerateContentResponse,
} from "@google/genai";
import { loadAppEnv, reloadAppEnv, type AppEnv } from "./appEnv";

export const DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen";
export const DEFAULT_GEMINI_FAST_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_CLIENT_TIMEOUT_MS = 70_000;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_SYSTEM_INSTRUCTION_LENGTH = 8_000;
export const MAX_OUTPUT_TOKENS = 32_768;
export const MAX_TEMPERATURE = 2;

export type GeminiClient = Pick<GoogleGenAI, "models">;

export type GeminiRuntimeConfig = {
  apiKey: string;
  model: string;
  fastModel: string;
  allowedModels: string[];
  configured: boolean;
  missingKeys: string[];
  path: string;
};

export type GeminiGenerateInput = {
  prompt: string;
  systemInstruction?: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
};

type ValidatedGeminiRequest = {
  prompt: string;
  systemInstruction?: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseJsonSchema?: unknown;
};

export type GeminiUsage = {
  promptTokens?: number;
  candidateTokens?: number;
  totalTokens?: number;
};

export type GeminiGenerateResult = {
  text: string;
  model: string;
  finishReason?: string;
  usage?: GeminiUsage;
};

export type GeminiStatus = {
  configured: boolean;
  reachable: boolean;
  model: string;
  fastModel: string;
  allowedModels: string[];
  path: string;
  missingKeys: string[];
  error?: string;
};

export type GeminiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Stream text chunks as they arrive. */
  onChunk?: (chunk: string) => void;
};

export type GeminiErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_MODEL"
  | "NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "CONTENT_BLOCKED"
  | "MODEL_NOT_FOUND"
  | "UPSTREAM_AUTH_ERROR"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "EMPTY_RESPONSE"
  | "UPSTREAM_ERROR";

export class GeminiRequestError extends Error {
  readonly status: number;
  readonly code: GeminiErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: GeminiErrorCode,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GeminiRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

let cachedClient: { apiKey: string; client: GeminiClient } | null = null;

export function getGeminiClient(apiKey: string): GeminiClient {
  if (!cachedClient || cachedClient.apiKey !== apiKey) {
    cachedClient = { apiKey, client: new GoogleGenAI({ apiKey }) };
  }
  return cachedClient.client;
}

export function resetGeminiClient(): void {
  cachedClient = null;
}

function readModel(
  values: Record<string, string>,
  key: string,
  fallback: string,
): string {
  return values[key]?.trim() || fallback;
}

export function runtimeConfigFromEnv(env: AppEnv): GeminiRuntimeConfig {
  const apiKey = env.values.GEMINI_API_KEY?.trim() ?? "";
  const model = readModel(env.values, "GEMINI_MODEL", DEFAULT_GEMINI_MODEL);
  const fastModel = readModel(
    env.values,
    "GEMINI_FAST_MODEL",
    DEFAULT_GEMINI_FAST_MODEL,
  );

  return {
    apiKey,
    model,
    fastModel,
    allowedModels: [...new Set([model, fastModel])],
    configured:
      Boolean(apiKey) &&
      apiKey !== "your-google-ai-studio-api-key" &&
      !env.missingKeys.includes("GEMINI_API_KEY"),
    missingKeys: env.missingKeys,
    path: env.path,
  };
}

function invalid(message: string): never {
  throw new GeminiRequestError(400, "INVALID_REQUEST", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength = 400): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength)}…`
    : collapsed;
}

export function validateGenerateRequest(
  body: unknown,
  config: Pick<GeminiRuntimeConfig, "model" | "allowedModels">,
): ValidatedGeminiRequest {
  if (!isRecord(body)) {
    invalid("Request body must be a JSON object.");
  }

  const allowedKeys = new Set([
    "prompt",
    "systemInstruction",
    "model",
    "temperature",
    "maxOutputTokens",
    "responseMimeType",
    "responseJsonSchema",
  ]);
  const unknownKeys = Object.keys(body).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    invalid(`Unknown field(s): ${unknownKeys.join(", ")}.`);
  }

  if (typeof body.prompt !== "string") {
    invalid("prompt must be a string.");
  }
  const prompt = body.prompt.trim();
  if (!prompt) invalid("prompt cannot be empty.");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    invalid(
      `prompt cannot exceed ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
    );
  }

  let systemInstruction: string | undefined;
  if (body.systemInstruction !== undefined) {
    if (typeof body.systemInstruction !== "string") {
      invalid("systemInstruction must be a string.");
    }
    systemInstruction = body.systemInstruction.trim();
    if (systemInstruction.length > MAX_SYSTEM_INSTRUCTION_LENGTH) {
      invalid(
        `systemInstruction cannot exceed ${MAX_SYSTEM_INSTRUCTION_LENGTH.toLocaleString()} characters.`,
      );
    }
    if (!systemInstruction) systemInstruction = undefined;
  }

  let model = config.model;
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      invalid("model must be a non-empty string.");
    }
    model = body.model.trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(model)) {
      invalid("model contains unsupported characters.");
    }
    if (!config.allowedModels.includes(model)) {
      throw new GeminiRequestError(
        400,
        "INVALID_MODEL",
        `Model "${model}" is not allowed. Allowed models: ${config.allowedModels.join(", ")}.`,
      );
    }
  }

  let temperature: number | undefined;
  if (body.temperature !== undefined) {
    if (
      typeof body.temperature !== "number" ||
      !Number.isFinite(body.temperature) ||
      body.temperature < 0 ||
      body.temperature > MAX_TEMPERATURE
    ) {
      invalid(`temperature must be a number between 0 and ${MAX_TEMPERATURE}.`);
    }
    temperature = body.temperature;
  }

  let maxOutputTokens: number | undefined;
  if (body.maxOutputTokens !== undefined) {
    if (
      typeof body.maxOutputTokens !== "number" ||
      !Number.isInteger(body.maxOutputTokens) ||
      body.maxOutputTokens < 1 ||
      body.maxOutputTokens > MAX_OUTPUT_TOKENS
    ) {
      invalid(
        `maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS}.`,
      );
    }
    maxOutputTokens = body.maxOutputTokens;
  }

  let responseMimeType: string | undefined;
  if (body.responseMimeType !== undefined) {
    if (
      typeof body.responseMimeType !== "string" ||
      !body.responseMimeType.trim()
    ) {
      invalid("responseMimeType must be a non-empty string.");
    }
    responseMimeType = body.responseMimeType.trim();
  }

  let responseJsonSchema: unknown;
  if (body.responseJsonSchema !== undefined) {
    if (!isRecord(body.responseJsonSchema)) {
      invalid("responseJsonSchema must be a JSON object.");
    }
    responseJsonSchema = body.responseJsonSchema;
  }

  return {
    prompt,
    systemInstruction,
    model,
    temperature,
    maxOutputTokens,
    responseMimeType,
    responseJsonSchema,
  };
}

function retryAfterSecondsFrom(error: ApiError): number | undefined {
  const message = error.message ?? "";
  const retryIn = message.match(/retry in ([\d.]+)\s*s/i);
  const retryDelay = message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  const raw = retryIn?.[1] ?? retryDelay?.[1];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(300, Math.max(1, Math.ceil(seconds)));
}

function mapUpstreamError(error: unknown): GeminiRequestError {
  if (error instanceof GeminiRequestError) return error;

  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return new GeminiRequestError(
          400,
          "INVALID_REQUEST",
          `Gemini rejected the request: ${truncate(error.message)}`,
        );
      case 401:
      case 403:
        return new GeminiRequestError(
          502,
          "UPSTREAM_AUTH_ERROR",
          "Gemini rejected the configured API key. Check GEMINI_API_KEY in the app config file.",
        );
      case 404:
        return new GeminiRequestError(
          404,
          "MODEL_NOT_FOUND",
          `The requested Gemini model is unavailable: ${truncate(error.message)}`,
        );
      case 429: {
        const retryAfterSeconds = retryAfterSecondsFrom(error);
        return new GeminiRequestError(
          429,
          "RATE_LIMITED",
          retryAfterSeconds
            ? `Gemini rate limit reached. Retry in about ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`
            : "Gemini rate limit reached. Wait a moment before trying again.",
          retryAfterSeconds,
        );
      }
      case 408:
      case 504:
        return new GeminiRequestError(
          504,
          "TIMEOUT",
          "Gemini took too long to respond. Please retry.",
        );
      default:
        if (error.status >= 500) {
          return new GeminiRequestError(
            502,
            "UPSTREAM_UNAVAILABLE",
            "Gemini is temporarily unavailable. Please retry shortly.",
          );
        }
        return new GeminiRequestError(
          502,
          "UPSTREAM_ERROR",
          `Gemini request failed: ${truncate(error.message)}`,
        );
    }
  }

  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new GeminiRequestError(
        504,
        "TIMEOUT",
        "Gemini took too long to respond. Please retry.",
      );
    }
    return new GeminiRequestError(
      502,
      "UPSTREAM_UNAVAILABLE",
      `Could not reach Gemini: ${truncate(error.message)}`,
    );
  }

  return new GeminiRequestError(
    502,
    "UPSTREAM_ERROR",
    "Gemini request failed for an unknown reason.",
  );
}

function blockedReason(
  promptBlock: string | undefined,
  finishReason: string | undefined,
): string | undefined {
  if (promptBlock) return promptBlock;
  return finishReason &&
    ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(
      finishReason,
    )
    ? finishReason
    : undefined;
}

function usageFrom(response: GenerateContentResponse): GeminiUsage | undefined {
  const usage = response.usageMetadata;
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokenCount,
    candidateTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
  };
}

/**
 * Validate and execute a request with an explicit client. Exported for tests;
 * application code should use `generateWithGemini`.
 */
export async function runGeminiGenerate(
  client: GeminiClient,
  config: GeminiRuntimeConfig,
  body: unknown,
  options: GeminiRequestOptions = {},
): Promise<GeminiGenerateResult> {
  if (!config.apiKey) {
    throw new GeminiRequestError(
      503,
      "NOT_CONFIGURED",
      `GEMINI_API_KEY is missing. Add it to ${config.path} and reload the app.`,
    );
  }

  const input = validateGenerateRequest(body, config);
  const params = {
    model: input.model,
    contents: input.prompt,
    config: {
      systemInstruction: input.systemInstruction,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      responseMimeType: input.responseMimeType,
      responseJsonSchema: input.responseJsonSchema,
      abortSignal: options.signal,
      httpOptions: {
        timeout: options.timeoutMs ?? GEMINI_CLIENT_TIMEOUT_MS,
        retryOptions: {
          attempts: 2,
          initialDelay: 0.5,
          maxDelay: 4,
          jitter: 1,
          // Surface 429 immediately so the UI can show Retry-After.
          httpStatusCodes: [500, 502, 503, 504],
        },
      },
    },
  };

  let text = "";
  let finishReason: string | undefined;
  let modelVersion: string | undefined;
  let usage: GeminiUsage | undefined;
  let promptBlock: string | undefined;

  try {
    if (options.onChunk) {
      const stream = await client.models.generateContentStream(params);
      for await (const chunk of stream) {
        const chunkText = chunk.text ?? "";
        if (chunkText) {
          text += chunkText;
          options.onChunk(chunkText);
        }
        finishReason =
          chunk.candidates?.[0]?.finishReason ?? finishReason;
        modelVersion = chunk.modelVersion ?? modelVersion;
        usage = usageFrom(chunk) ?? usage;
        promptBlock = chunk.promptFeedback?.blockReason ?? promptBlock;
      }
      text = text.trim();
    } else {
      const response = await client.models.generateContent(params);
      text = response.text?.trim() ?? "";
      finishReason = response.candidates?.[0]?.finishReason;
      modelVersion = response.modelVersion;
      usage = usageFrom(response);
      promptBlock = response.promptFeedback?.blockReason;
    }
  } catch (error) {
    throw mapUpstreamError(error);
  }

  if (!text) {
    const reason = blockedReason(promptBlock, finishReason);
    if (reason) {
      throw new GeminiRequestError(
        422,
        "CONTENT_BLOCKED",
        `Gemini blocked the response (${reason}). Rephrase the prompt and try again.`,
      );
    }
    if (finishReason === "MAX_TOKENS") {
      throw new GeminiRequestError(
        502,
        "EMPTY_RESPONSE",
        "Gemini stopped at the output token limit before producing text. Increase maxOutputTokens.",
      );
    }
    throw new GeminiRequestError(
      502,
      "EMPTY_RESPONSE",
      "Gemini returned an empty response. Please retry.",
    );
  }

  if (finishReason === "MAX_TOKENS") {
    throw new GeminiRequestError(
      502,
      "UPSTREAM_ERROR",
      "Gemini stopped at the output token limit before finishing the response. The result was truncated; increase maxOutputTokens or shorten the prompt.",
    );
  }

  return {
    text,
    model: modelVersion || input.model,
    finishReason,
    usage,
  };
}

async function currentRuntimeConfig(): Promise<GeminiRuntimeConfig> {
  return runtimeConfigFromEnv(await loadAppEnv());
}

export async function generateWithGemini(
  input: GeminiGenerateInput,
  options: GeminiRequestOptions = {},
): Promise<GeminiGenerateResult> {
  const config = await currentRuntimeConfig();
  if (!config.configured) {
    throw new GeminiRequestError(
      503,
      "NOT_CONFIGURED",
      `GEMINI_API_KEY is missing. Add it to ${config.path} and reload the app.`,
    );
  }

  return runGeminiGenerate(getGeminiClient(config.apiKey), config, input, options);
}

export async function checkGeminiStatus(): Promise<GeminiStatus> {
  const env = await loadAppEnv();
  const config = runtimeConfigFromEnv(env);
  return {
    configured: config.configured,
    reachable: true,
    model: config.model,
    fastModel: config.fastModel,
    allowedModels: config.allowedModels,
    path: config.path,
    missingKeys: config.missingKeys,
    error: env.error,
  };
}

export async function reloadGeminiConfig(): Promise<GeminiStatus> {
  resetGeminiClient();
  const env = await reloadAppEnv();
  const config = runtimeConfigFromEnv(env);
  return {
    configured: config.configured,
    reachable: true,
    model: config.model,
    fastModel: config.fastModel,
    allowedModels: config.allowedModels,
    path: config.path,
    missingKeys: config.missingKeys,
    error: env.error,
  };
}
