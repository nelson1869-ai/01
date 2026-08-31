import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiProviderError, sanitizeErrorMessage } from "./ai-errors";
import { GeminiStructuredAiProvider } from "./gemini-provider";
import { FakeStructuredAiProvider } from "./testing/fake-ai-provider";

describe("GeminiStructuredAiProvider and AI Error handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed with MISSING_CREDENTIAL when GEMINI_API_KEY is not provided", async () => {
    const provider = new GeminiStructuredAiProvider({ apiKey: "" });

    await expect(
      provider.generateStructured({
        taskName: "test-task",
        systemInstruction: "test",
        prompt: "test",
        schema: z.object({ result: z.string() }),
      }),
    ).rejects.toMatchObject({
      code: "MISSING_CREDENTIAL",
    });
  });

  it("never includes API key in error messages or sanitized text", () => {
    const rawError =
      "Invalid API key AIzaSyD9876543210abcdefghijklmnopq supplied to Gemini endpoint.";
    const sanitized = sanitizeErrorMessage(rawError);

    expect(sanitized).not.toContain("AIzaSyD9876543210abcdefghijklmnopq");
    expect(sanitized).toContain("[REDACTED_GEMINI_KEY]");

    const err = AiProviderError.unknown("gemini", rawError);
    expect(err.message).not.toContain("AIzaSyD9876543210abcdefghijklmnopq");
    expect(err.message).toContain("[REDACTED_GEMINI_KEY]");
  });

  it("redacts GitHub tokens and Bearer headers from error messages", () => {
    const rawError =
      "GitHub request with token ghp_1234567890abcdefghijklmnopqrstuvwxyz and Bearer secret-token-xyz failed.";
    const sanitized = sanitizeErrorMessage(rawError);

    expect(sanitized).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(sanitized).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(sanitized).toContain("Bearer [REDACTED_TOKEN]");
  });

  it("validates structured output correctly with Zod schema", async () => {
    const testSchema = z.object({
      summary: z.string(),
      count: z.number(),
    });

    const fakeProvider = new FakeStructuredAiProvider({
      fixedValue: { summary: "Test summary", count: 42 },
    });

    const res = await fakeProvider.generateStructured({
      taskName: "test-structured",
      systemInstruction: "test",
      prompt: "test",
      schema: testSchema,
    });

    expect(res.value).toEqual({ summary: "Test summary", count: 42 });
    expect(res.provider).toBe("fake-gemini");
    expect(res.model).toBe("gemini-3.7-flash");
  });

  it("rejects invalid or malformed structured output", async () => {
    const testSchema = z.object({
      summary: z.string(),
      count: z.number(),
    });

    const fakeProvider = new FakeStructuredAiProvider({
      fixedValue: { summary: "Missing count field" },
    });

    await expect(
      fakeProvider.generateStructured({
        taskName: "test-structured-invalid",
        systemInstruction: "test",
        prompt: "test",
        schema: testSchema,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
    });
  });

  it("handles simulated provider rate limit, timeout, and safety blocks", async () => {
    const rateLimitProvider = new FakeStructuredAiProvider({
      errorToThrow: AiProviderError.rateLimited("gemini"),
    });
    await expect(
      rateLimitProvider.generateStructured({
        taskName: "test",
        systemInstruction: "test",
        prompt: "test",
        schema: z.any(),
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", isRetryable: true });

    const timeoutProvider = new FakeStructuredAiProvider({
      errorToThrow: AiProviderError.timeout("gemini", 30000),
    });
    await expect(
      timeoutProvider.generateStructured({
        taskName: "test",
        systemInstruction: "test",
        prompt: "test",
        schema: z.any(),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT", isRetryable: true });

    const safetyProvider = new FakeStructuredAiProvider({
      errorToThrow: AiProviderError.safetyBlocked("gemini", "Harmful text"),
    });
    await expect(
      safetyProvider.generateStructured({
        taskName: "test",
        systemInstruction: "test",
        prompt: "test",
        schema: z.any(),
      }),
    ).rejects.toMatchObject({ code: "SAFETY_BLOCKED", isRetryable: false });
  });

  it("passes AbortSignal to generateContent and clears the timeout timer after success", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const provider = new GeminiStructuredAiProvider({
      defaultTimeoutMs: 100,
      client: {
        models: {
          generateContent: vi.fn(async (params) => {
            signal = params.config?.abortSignal;
            return { text: '{"result":"ok"}' };
          }),
        },
      } as never,
    });

    const result = await provider.generateStructured({
      taskName: "timer-success",
      systemInstruction: "test",
      prompt: "test",
      schema: z.object({ result: z.string() }),
    });

    expect(result.value).toEqual({ result: "ok" });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the SDK request, normalizes the abort to TIMEOUT, and clears the timer", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const provider = new GeminiStructuredAiProvider({
      defaultTimeoutMs: 25,
      client: {
        models: {
          generateContent: vi.fn((params) => {
            signal = params.config?.abortSignal;
            return new Promise((_, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  reject(
                    new DOMException(
                      "The operation was aborted.",
                      "AbortError",
                    ),
                  );
                },
                { once: true },
              );
            });
          }),
        },
      } as never,
    });

    const pending = provider.generateStructured({
      taskName: "timer-timeout",
      systemInstruction: "test",
      prompt: "test",
      schema: z.object({ result: z.string() }),
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not emit an unhandled rejection if a non-cooperative request rejects after timeout", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let rejectRequest: ((reason?: unknown) => void) | undefined;
    try {
      const provider = new GeminiStructuredAiProvider({
        defaultTimeoutMs: 10,
        client: {
          models: {
            generateContent: vi.fn(
              () =>
                new Promise((_, reject) => {
                  rejectRequest = reject;
                }),
            ),
          },
        } as never,
      });
      const pending = provider.generateStructured({
        taskName: "late-rejection",
        systemInstruction: "test",
        prompt: "test",
        schema: z.object({ result: z.string() }),
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      rejectRequest?.(new Error("late raw provider failure"));
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("aborts generation promptly when caller AbortSignal triggers without mapping to TIMEOUT", async () => {
    let signal: AbortSignal | undefined;
    const abortController = new AbortController();

    const provider = new GeminiStructuredAiProvider({
      defaultTimeoutMs: 10_000,
      client: {
        models: {
          generateContent: vi.fn((params) => {
            signal = params.config?.abortSignal;
            return new Promise((_, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  reject(
                    new DOMException(
                      "The operation was aborted.",
                      "AbortError",
                    ),
                  );
                },
                { once: true },
              );
            });
          }),
        },
      } as never,
    });

    const pending = provider.generateStructured({
      taskName: "caller-abort",
      systemInstruction: "test",
      prompt: "test",
      schema: z.object({ result: z.string() }),
      signal: abortController.signal,
    });

    // Caller aborts
    abortController.abort();

    await expect(pending).rejects.toThrow("The operation was aborted.");
    expect(signal?.aborted).toBe(true);
  });
});
