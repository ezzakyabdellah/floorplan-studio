import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_TIMEOUT_RESPONSE_WINDOW_MS,
  generateLocalJson,
} from "./localAiService";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("structured local AI request timeout", () => {
  it("continues waiting when the timeout prompt is accepted", async () => {
    vi.useFakeTimers();

    let requestSignal: AbortSignal | undefined;
    let resolveFetch!: (response: Response) => void;
    let respondToTimeout!: (continueWaiting: boolean) => void;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            requestSignal = init?.signal ?? undefined;
            requestSignal?.addEventListener(
              "abort",
              () => reject(new Error("Request canceled")),
              { once: true },
            );
            resolveFetch = resolve;
          }),
      ),
    );

    const result = generateLocalJson("test prompt", {
      timeoutMs: 100,
      onTimeout: (respond) => {
        respondToTimeout = respond;
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(respondToTimeout).toBeTypeOf("function");
    expect(requestSignal?.aborted).toBe(false);

    respondToTimeout(true);
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_RESPONSE_WINDOW_MS);
    expect(requestSignal?.aborted).toBe(false);

    resolveFetch({
      ok: true,
      json: async () => ({ response: "{}" }),
    } as Response);
    await expect(result).resolves.toBe("{}");
  });

  it("cancels after the timeout prompt receives no response", async () => {
    vi.useFakeTimers();

    let requestSignal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const onTimeoutExpired = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? undefined;
            requestSignal?.addEventListener(
              "abort",
              () => reject(new Error("Request canceled")),
              { once: true },
            );
          }),
      ),
    );

    const result = generateLocalJson("test prompt", {
      timeoutMs: 100,
      onTimeout,
      onTimeoutExpired,
    });
    const rejection = expect(result).rejects.toThrow("Request canceled");

    await vi.advanceTimersByTimeAsync(100);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_RESPONSE_WINDOW_MS);
    await rejection;
    expect(onTimeoutExpired).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });
});
