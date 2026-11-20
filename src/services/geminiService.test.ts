import {
  ApiError,
  BlockedReason,
  type GenerateContentResponse,
} from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./appEnv";
import {
  GeminiRequestError,
  MAX_PROMPT_LENGTH,
  runGeminiGenerate,
  runtimeConfigFromEnv,
  validateGenerateRequest,
  type GeminiClient,
  type GeminiRuntimeConfig,
} from "./geminiService";

const config: GeminiRuntimeConfig = {
  apiKey: "test-api-key",
  model: "gemini-4-hydrogen",
  fastModel: "gemini-3.5-flash-lite",
  allowedModels: ["gemini-4-hydrogen", "gemini-3.5-flash-lite"],
  configured: true,
  missingKeys: [],
  path: "C:\\Users\\test\\AppData\\Roaming\\com.floorplan.studio\\.env",
};

function fakeClient(result: GenerateContentResponse | Error) {
  const generateContent = vi.fn((_params: unknown) => {
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  });
  return {
    client: { models: { generateContent } } as unknown as GeminiClient,
    generateContent,
  };
}

function fakeStreamingClient(chunks: GenerateContentResponse[]) {
  const generateContentStream = vi.fn(async () =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  );
  return {
    client: { models: { generateContentStream } } as unknown as GeminiClient,
    generateContentStream,
  };
}

function response(
  overrides: Partial<GenerateContentResponse> = {},
): GenerateContentResponse {
  return {
    text: "  A compliant layout.  ",
    candidates: [{ finishReason: "STOP" }],
    modelVersion: "gemini-4-hydrogen-001",
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 34,
      totalTokenCount: 46,
    },
    ...overrides,
  } as unknown as GenerateContentResponse;
}

function appEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    path: config.path,
    exists: true,
    values: {
      GEMINI_API_KEY: "test-api-key",
      GEMINI_MODEL: "gemini-4-hydrogen",
      GEMINI_FAST_MODEL: "gemini-3.5-flash-lite",
    },
    missingKeys: [],
    ...overrides,
  };
}

describe("runtimeConfigFromEnv", () => {
  it("uses the env file models and defaults", () => {
    const runtime = runtimeConfigFromEnv(appEnv());
    expect(runtime.configured).toBe(true);
    expect(runtime.model).toBe("gemini-4-hydrogen");
    expect(runtime.fastModel).toBe("gemini-3.5-flash-lite");
    expect(runtime.allowedModels).toEqual([
      "gemini-4-hydrogen",
      "gemini-3.5-flash-lite",
    ]);
  });

  it("falls back to default models when values are blank", () => {
    const runtime = runtimeConfigFromEnv(
      appEnv({
        values: { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "  " },
      }),
    );
    expect(runtime.model).toBe("gemini-4-hydrogen");
    expect(runtime.fastModel).toBe("gemini-3.5-flash-lite");
  });

  it("is not configured when the key is missing", () => {
    const runtime = runtimeConfigFromEnv(
      appEnv({
        values: { GEMINI_MODEL: "gemini-4-hydrogen" },
        missingKeys: ["GEMINI_API_KEY"],
      }),
    );
    expect(runtime.configured).toBe(false);
  });

  it("is not configured for the example placeholder", () => {
    const runtime = runtimeConfigFromEnv(
      appEnv({
        values: { GEMINI_API_KEY: "your-google-ai-studio-api-key" },
      }),
    );
    expect(runtime.configured).toBe(false);
  });
});

describe("validateGenerateRequest", () => {
  it("applies defaults and trims the prompt", () => {
    const input = validateGenerateRequest(
      { prompt: "  Check this plan  " },
      config,
    );
    expect(input).toEqual({
      prompt: "Check this plan",
      systemInstruction: undefined,
      model: "gemini-4-hydrogen",
      temperature: undefined,
      maxOutputTokens: undefined,
      responseMimeType: undefined,
      responseJsonSchema: undefined,
    });
  });

  it("accepts the fast model and optional controls", () => {
    const input = validateGenerateRequest(
      {
        prompt: "Summarize the plan",
        model: "gemini-3.5-flash-lite",
        temperature: 0.4,
        maxOutputTokens: 512,
        systemInstruction: "Be brief.",
      },
      config,
    );
    expect(input.model).toBe("gemini-3.5-flash-lite");
    expect(input.temperature).toBe(0.4);
    expect(input.maxOutputTokens).toBe(512);
  });

  it.each([
    [{}, "prompt must be a string"],
    [{ prompt: "   " }, "prompt cannot be empty"],
    [{ prompt: "x".repeat(MAX_PROMPT_LENGTH + 1) }, "cannot exceed"],
    [{ prompt: "hello", extra: true }, "Unknown field"],
    [{ prompt: "hello", temperature: 3 }, "temperature"],
    [{ prompt: "hello", maxOutputTokens: 1.5 }, "maxOutputTokens"],
    [{ prompt: "hello", systemInstruction: 42 }, "systemInstruction"],
  ])("rejects invalid input %#", (body, message) => {
    expect(() => validateGenerateRequest(body, config)).toThrow(message);
    expect(() => validateGenerateRequest(body, config)).toThrow(
      GeminiRequestError,
    );
  });

  it("rejects models outside the allowlist with a specific code", () => {
    try {
      validateGenerateRequest(
        { prompt: "hello", model: "gemini-expensive-ultra" },
        config,
      );
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GeminiRequestError);
      expect((error as GeminiRequestError).code).toBe("INVALID_MODEL");
      expect((error as GeminiRequestError).status).toBe(400);
    }
  });
});

describe("runGeminiGenerate", () => {
  it("calls generateContent with the validated request and returns usage", async () => {
    const { client, generateContent } = fakeClient(response());

    const result = await runGeminiGenerate(client, config, {
      prompt: "  Check this plan  ",
      systemInstruction: "You are an inspector.",
      temperature: 0.2,
      maxOutputTokens: 800,
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0]).toMatchObject({
      model: "gemini-4-hydrogen",
      contents: "Check this plan",
      config: {
        systemInstruction: "You are an inspector.",
        temperature: 0.2,
        maxOutputTokens: 800,
        httpOptions: {
          timeout: 70_000,
          retryOptions: { attempts: 2 },
        },
      },
    });
    expect(result).toEqual({
      text: "A compliant layout.",
      model: "gemini-4-hydrogen-001",
      finishReason: "STOP",
      usage: {
        promptTokens: 12,
        candidateTokens: 34,
        totalTokens: 46,
      },
    });
  });

  it("passes JSON response options through to the SDK", async () => {
    const { client, generateContent } = fakeClient(
      response({ text: '{"ok":true}' }),
    );

    const result = await runGeminiGenerate(client, config, {
      prompt: "Return JSON",
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
      },
    });

    expect(generateContent.mock.calls[0][0]).toMatchObject({
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    });
    expect(result.text).toBe('{"ok":true}');
  });

  it("streams text chunks and concatenates the result", async () => {
    const { client, generateContentStream } = fakeStreamingClient([
      response({ text: "Hello ", candidates: [] }),
      response({ text: "world", modelVersion: "gemini-4-hydrogen-001" }),
    ]);
    const onChunk = vi.fn();

    const result = await runGeminiGenerate(
      client,
      config,
      { prompt: "hello" },
      { onChunk },
    );

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls.map((call) => call[0])).toEqual([
      "Hello ",
      "world",
    ]);
    expect(result.text).toBe("Hello world");
    expect(result.model).toBe("gemini-4-hydrogen-001");
  });

  it("returns 503 when the API key is not configured", async () => {
    const { client, generateContent } = fakeClient(response());

    await expect(
      runGeminiGenerate(client, { ...config, apiKey: "" }, { prompt: "hello" }),
    ).rejects.toMatchObject({
      status: 503,
      code: "NOT_CONFIGURED",
    });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("maps 429 into a friendly rate-limit error with retry delay", async () => {
    const { client } = fakeClient(
      new ApiError({
        status: 429,
        message:
          "429 RESOURCE_EXHAUSTED. Quota exceeded. Please retry in 12.4s.",
      }),
    );

    await expect(
      runGeminiGenerate(client, config, { prompt: "hello" }),
    ).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: 13,
    });
  });

  it("reads retryDelay from structured upstream errors", async () => {
    const { client } = fakeClient(
      new ApiError({
        status: 429,
        message: '{"error":{"details":[{"retryDelay":"7s"}]}}',
      }),
    );

    await expect(
      runGeminiGenerate(client, config, { prompt: "hello" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 7,
    });
  });

  it("maps auth, missing-model, and server failures", async () => {
    const cases: Array<[number, string, number]> = [
      [401, "UPSTREAM_AUTH_ERROR", 502],
      [403, "UPSTREAM_AUTH_ERROR", 502],
      [404, "MODEL_NOT_FOUND", 404],
      [500, "UPSTREAM_UNAVAILABLE", 502],
      [503, "UPSTREAM_UNAVAILABLE", 502],
    ];

    for (const [upstreamStatus, code, status] of cases) {
      const { client } = fakeClient(
        new ApiError({ status: upstreamStatus, message: "upstream failure" }),
      );
      await expect(
        runGeminiGenerate(client, config, { prompt: "hello" }),
      ).rejects.toMatchObject({ code, status });
    }
  });

  it("rejects safety-blocked responses with 422", async () => {
    const { client } = fakeClient(
      response({
        text: undefined,
        promptFeedback: { blockReason: BlockedReason.SAFETY },
      }),
    );

    await expect(
      runGeminiGenerate(client, config, { prompt: "hello" }),
    ).rejects.toMatchObject({
      status: 422,
      code: "CONTENT_BLOCKED",
    });
  });

  it("rejects empty output that is not safety-related", async () => {
    const { client } = fakeClient(response({ text: "   ", candidates: [] }));

    await expect(
      runGeminiGenerate(client, config, { prompt: "hello" }),
    ).rejects.toMatchObject({
      status: 502,
      code: "EMPTY_RESPONSE",
    });
  });

  it("maps aborted requests to a timeout", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const { client } = fakeClient(abortError);

    await expect(
      runGeminiGenerate(client, config, { prompt: "hello" }),
    ).rejects.toMatchObject({
      status: 504,
      code: "TIMEOUT",
    });
  });
});
