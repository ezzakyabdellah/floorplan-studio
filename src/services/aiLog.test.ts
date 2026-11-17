import { describe, expect, it } from "vitest";
import { logAiError, logAiOutput, readAiLog } from "./aiLog";

describe("AI JSONL log", () => {
  it("records model output and request errors as separate file-ready entries", async () => {
    const operation = `ai-log-test-${Date.now()}`;
    await logAiOutput(operation, "local-model", '{"tool":"updateDesignParameters"}');
    await logAiError(operation, "local-model", new Error("model request failed"));

    const lines = (await readAiLog())
      .split("\n")
      .filter((line) => line.includes(operation))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      operation,
      model: "local-model",
      outcome: "output",
      output: '{"tool":"updateDesignParameters"}',
    });
    expect(lines[1]).toMatchObject({
      operation,
      outcome: "error",
      error: "model request failed",
    });
    expect(typeof lines[0].timestamp).toBe("string");
  });
});
