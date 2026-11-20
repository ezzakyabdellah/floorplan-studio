import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateWithGemini: vi.fn(),
  checkGeminiStatus: vi.fn(),
  generateLocalJson: vi.fn(),
  generateLocalText: vi.fn(),
  checkOllamaStatus: vi.fn(),
}));

vi.mock("./geminiService", () => ({
  GeminiRequestError: class GeminiRequestError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  checkGeminiStatus: mocks.checkGeminiStatus,
  generateWithGemini: mocks.generateWithGemini,
  reloadGeminiConfig: vi.fn(),
}));

vi.mock("./localAiService", () => ({
  DEFAULT_AI_MODELS: ["llama3.2"],
  checkOllamaStatus: mocks.checkOllamaStatus,
  generateLocalJson: mocks.generateLocalJson,
  generateLocalText: mocks.generateLocalText,
}));

import {
  generateAiJson,
  generateAiText,
  resolveAiProvider,
  setAiProviderPreference,
} from "./aiProvider";
import { GeminiRequestError } from "./geminiService";

const schema = {
  type: "object",
  properties: { advice: { type: "array", items: { type: "string" } } },
  required: ["advice"],
};

beforeEach(() => {
  setAiProviderPreference("auto");
  mocks.generateWithGemini.mockReset().mockResolvedValue({
    text: "gemini text",
    model: "gemini-4-hydrogen",
  });
  mocks.checkGeminiStatus.mockReset().mockResolvedValue({
    configured: true,
    model: "gemini-4-hydrogen",
    fastModel: "gemini-3.5-flash-lite",
    allowedModels: ["gemini-4-hydrogen", "gemini-3.5-flash-lite"],
    path: "C:\\test\\.env",
    missingKeys: [],
  });
  mocks.generateLocalJson.mockReset().mockResolvedValue('{"advice":["local"]}');
  mocks.generateLocalText.mockReset().mockResolvedValue("local text");
  mocks.checkOllamaStatus.mockReset().mockResolvedValue({
    online: true,
    models: ["llama3.2"],
    baseUrl: "http://localhost:11434",
  });
});

describe("AI provider routing", () => {
  it("auto-selects Gemini when it is configured", async () => {
    expect(await resolveAiProvider(true)).toBe("gemini");
    expect(await generateAiText("hello")).toBe("gemini text");
    expect(mocks.generateWithGemini).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "hello" }),
      expect.objectContaining({ onChunk: undefined }),
    );
    expect(mocks.generateLocalText).not.toHaveBeenCalled();
  });

  it("auto-falls back to Ollama when Gemini is not configured", async () => {
    mocks.checkGeminiStatus.mockResolvedValue({
      configured: false,
      model: "gemini-4-hydrogen",
      fastModel: "gemini-3.5-flash-lite",
      allowedModels: [],
      path: "C:\\test\\.env",
      missingKeys: ["GEMINI_API_KEY"],
    });

    expect(await resolveAiProvider(true)).toBe("ollama");
    expect(await generateAiText("hello", { systemInstruction: "Be brief." })).toBe(
      "local text",
    );
    expect(mocks.generateLocalText).toHaveBeenCalledWith(
      "Be brief.\n\nhello",
      expect.objectContaining({ systemInstruction: "Be brief." }),
    );
    expect(mocks.generateWithGemini).not.toHaveBeenCalled();
  });

  it("routes JSON requests to Gemini with schema mode", async () => {
    setAiProviderPreference("gemini");
    expect(await generateAiJson("advice", { numPredict: 123 }, schema)).toBe(
      "gemini text",
    );
    expect(mocks.generateWithGemini).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "advice",
        maxOutputTokens: 123,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
      }),
      expect.any(Object),
    );
  });

  it("falls back to plain JSON mode when a schema is rejected", async () => {
    setAiProviderPreference("gemini");
    mocks.generateWithGemini
      .mockRejectedValueOnce(
        new GeminiRequestError(
          400,
          "INVALID_REQUEST",
          "Gemini rejected the request: invalid responseJsonSchema",
        ),
      )
      .mockResolvedValueOnce({ text: '{"advice":[]}', model: "gemini" });

    await generateAiJson("advice", {}, schema);

    expect(mocks.generateWithGemini).toHaveBeenCalledTimes(2);
    expect(mocks.generateWithGemini.mock.calls[1][0]).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: undefined,
    });
  });

  it("respects an explicit Local preference even when Gemini is configured", async () => {
    setAiProviderPreference("ollama");
    expect(await resolveAiProvider(true)).toBe("ollama");
    expect(await generateAiJson("advice", {}, schema)).toBe(
      '{"advice":["local"]}',
    );
    expect(mocks.generateLocalJson).toHaveBeenCalledWith(
      "advice",
      expect.any(Object),
      schema,
    );
    expect(mocks.generateWithGemini).not.toHaveBeenCalled();
  });
});
