import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiProviderError, type AiErrorCode } from "./ai-errors";
import type {
  StructuredAiProvider,
  StructuredAiRequest,
  StructuredAiResponse,
} from "./ai-provider-contract";
import {
  DEFAULT_BACKOFF_DELAYS_MS,
  ReliableStructuredAiProvider,
  SimpleAiTelemetryCollector,
} from "./reliable-provider";

class MockProvider implements StructuredAiProvider {
  readonly providerName = "mock-gemini";
  readonly defaultModel = "gemini-3.7-flash";
  calls = 0;
  private readonly queue: Array<
    { outcome: "success"; value: unknown } | { outcome: "error"; error: Error }
  >;

  constructor(
    outcomes: Array<
      | { outcome: "success"; value: unknown }
      | { outcome: "error"; error: Error }
    >,
  ) {
    this.queue = [...outcomes];
  }

  async generateStructured<T>(
    request: StructuredAiRequest<T>,
  ): Promise<StructuredAiResponse<T>> {
    this.calls++;
    const next = this.queue.shift();
    if (!next) {
      throw new Error("No mock outcome configured.");
    }
    if (next.outcome === "error") {
      throw next.error;
    }
    return {
      provider: this.providerName,
      model: request.model ?? this.defaultModel,
      value: next.value as T,
      latencyMs: 10,
      finishedAt: new Date().toISOString(),
    };
  }
}

describe("ReliableStructuredAiProvider", () => {
  const schema = z.object({ result: z.string() });

  it("completes on the first attempt without retry when provider succeeds", async () => {
    const mock = new MockProvider([
      { outcome: "success", value: { result: "ok" } },
    ]);
    const collector = new SimpleAiTelemetryCollector();
    const reliable = new ReliableStructuredAiProvider(mock, {
      telemetryCollector: collector,
    });

    const res = await reliable.generateStructured({
      taskName: "assistant-intent",
      systemInstruction: "test",
      prompt: "test",
      schema,
    });

    expect(res.value).toEqual({ result: "ok" });
    expect(mock.calls).toBe(1);

    const stages = collector.getStages();
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      stage: "assistant.intent",
      provider: "mock-gemini",
      model: "gemini-3.7-flash",
      attemptCount: 1,
      retried: false,
      finalStatus: "READY",
    });
  });

  const retryableScenarios: ReadonlyArray<{
    code: "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE";
    error: Error;
    expectedBackoffMs: number;
  }> = [
    {
      code: "TIMEOUT",
      error: AiProviderError.timeout("mock-gemini", 30000),
      expectedBackoffMs: DEFAULT_BACKOFF_DELAYS_MS.TIMEOUT,
    },
    {
      code: "RATE_LIMITED",
      error: AiProviderError.rateLimited("mock-gemini"),
      expectedBackoffMs: DEFAULT_BACKOFF_DELAYS_MS.RATE_LIMITED,
    },
    {
      code: "PROVIDER_UNAVAILABLE",
      error: AiProviderError.providerUnavailable("mock-gemini"),
      expectedBackoffMs: DEFAULT_BACKOFF_DELAYS_MS.PROVIDER_UNAVAILABLE,
    },
  ];

  it.each(retryableScenarios)(
    "retries exactly once for transient error $code and succeeds on attempt 2",
    async ({ error, expectedBackoffMs }) => {
      const mock = new MockProvider([
        { outcome: "error", error },
        { outcome: "success", value: { result: "recovered" } },
      ]);
      const collector = new SimpleAiTelemetryCollector();
      const sleeps: number[] = [];
      const reliable = new ReliableStructuredAiProvider(mock, {
        telemetryCollector: collector,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      });

      const res = await reliable.generateStructured({
        taskName: "assistant-direct-response",
        systemInstruction: "test",
        prompt: "test",
        schema,
      });

      expect(res.value).toEqual({ result: "recovered" });
      expect(mock.calls).toBe(2);
      expect(sleeps).toEqual([expectedBackoffMs]);

      const stages = collector.getStages();
      expect(stages).toHaveLength(1);
      expect(stages[0]).toMatchObject({
        stage: "assistant.compose.direct",
        provider: "mock-gemini",
        model: "gemini-3.7-flash",
        attemptCount: 2,
        retried: true,
        finalStatus: "READY",
      });
    },
  );

  it("stops after exactly 1 retry (2 total attempts) when transient error persists", async () => {
    const timeoutErr = AiProviderError.timeout("mock-gemini", 30000);
    const mock = new MockProvider([
      { outcome: "error", error: timeoutErr },
      { outcome: "error", error: timeoutErr },
      { outcome: "success", value: { result: "should not reach" } },
    ]);
    const collector = new SimpleAiTelemetryCollector();
    const sleeps: number[] = [];
    const reliable = new ReliableStructuredAiProvider(mock, {
      telemetryCollector: collector,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(
      reliable.generateStructured({
        taskName: "assistant-verified-response",
        systemInstruction: "test",
        prompt: "test",
        schema,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    expect(mock.calls).toBe(2);
    expect(sleeps).toEqual([500]);

    const stages = collector.getStages();
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      stage: "assistant.compose.verified",
      provider: "mock-gemini",
      model: "gemini-3.7-flash",
      attemptCount: 2,
      retried: true,
      finalStatus: "TIMEOUT",
    });
  });

  const nonRetryableScenarios: ReadonlyArray<{
    name: string;
    code: AiErrorCode;
    error: Error;
  }> = [
    {
      name: "MISSING_CREDENTIAL",
      code: "MISSING_CREDENTIAL",
      error: AiProviderError.missingCredential("mock-gemini"),
    },
    {
      name: "AUTHENTICATION_FAILED",
      code: "AUTHENTICATION_FAILED",
      error: AiProviderError.authenticationFailed("mock-gemini"),
    },
    {
      name: "SAFETY_BLOCKED",
      code: "SAFETY_BLOCKED",
      error: AiProviderError.safetyBlocked("mock-gemini", "safety violation"),
    },
    {
      name: "INVALID_STRUCTURED_OUTPUT",
      code: "INVALID_STRUCTURED_OUTPUT",
      error: AiProviderError.invalidStructuredOutput("mock-gemini", "bad JSON"),
    },
    {
      name: "RESPONSE_TOO_LARGE",
      code: "RESPONSE_TOO_LARGE",
      error: new AiProviderError("too large", {
        code: "RESPONSE_TOO_LARGE",
        provider: "mock-gemini",
      }),
    },
  ];

  it.each(nonRetryableScenarios)(
    "never retries non-retryable error $name (fails on attempt 1)",
    async ({ code, error }) => {
      const mock = new MockProvider([
        { outcome: "error", error },
        { outcome: "success", value: { result: "should not reach" } },
      ]);
      const collector = new SimpleAiTelemetryCollector();
      const sleepFn = vi.fn();
      const reliable = new ReliableStructuredAiProvider(mock, {
        telemetryCollector: collector,
        sleepFn,
      });

      await expect(
        reliable.generateStructured({
          taskName: "candidate-generation",
          systemInstruction: "test",
          prompt: "test",
          schema,
        }),
      ).rejects.toMatchObject({
        code,
      });

      expect(mock.calls).toBe(1);
      expect(sleepFn).not.toHaveBeenCalled();

      const stages = collector.getStages();
      expect(stages).toHaveLength(1);
      expect(stages[0]).toMatchObject({
        stage: "candidate.generate",
        attemptCount: 1,
        retried: false,
        finalStatus: code,
      });
    },
  );

  it("never retries generic unknown exceptions (fails on attempt 1)", async () => {
    const rawError = new Error("Generic network socket hang up");
    const mock = new MockProvider([
      { outcome: "error", error: rawError },
      { outcome: "success", value: { result: "should not reach" } },
    ]);
    const collector = new SimpleAiTelemetryCollector();
    const sleepFn = vi.fn();
    const reliable = new ReliableStructuredAiProvider(mock, {
      telemetryCollector: collector,
      sleepFn,
    });

    await expect(
      reliable.generateStructured({
        taskName: "assistant-intent",
        systemInstruction: "test",
        prompt: "test",
        schema,
      }),
    ).rejects.toThrow("Generic network socket hang up");

    expect(mock.calls).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();

    const stages = collector.getStages();
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      stage: "assistant.intent",
      attemptCount: 1,
      retried: false,
      finalStatus: "UNKNOWN_PROVIDER_FAILURE",
    });
  });

  it("redacts secrets and protects sensitive data from telemetry", async () => {
    const mock = new MockProvider([
      { outcome: "success", value: { result: "ok" } },
    ]);
    const collector = new SimpleAiTelemetryCollector();
    const reliable = new ReliableStructuredAiProvider(mock, {
      telemetryCollector: collector,
    });

    await reliable.generateStructured({
      taskName: "assistant-intent",
      systemInstruction: "test",
      prompt:
        "prompt with AIzaSySecret1234567890 and ghp_testSecretToken1234567890",
      schema,
    });

    const serialized = JSON.stringify(collector.getStages());
    expect(serialized).not.toContain("AIzaSySecret1234567890");
    expect(serialized).not.toContain("ghp_testSecretToken1234567890");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("systemInstruction");
  });

  it("stops immediately and never retries when caller signal aborts during execution", async () => {
    const abortController = new AbortController();
    const mock = new MockProvider([
      {
        outcome: "error",
        error: new DOMException("The operation was aborted.", "AbortError"),
      },
      { outcome: "success", value: { result: "should not reach" } },
    ]);
    const reliable = new ReliableStructuredAiProvider(mock);

    abortController.abort();

    await expect(
      reliable.generateStructured({
        taskName: "assistant-intent",
        systemInstruction: "test",
        prompt: "test",
        schema,
        signal: abortController.signal,
      }),
    ).rejects.toThrow("The operation was aborted.");

    expect(mock.calls).toBe(0);
  });

  it("stops immediately and cancels attempt 2 if caller signal aborts during retry backoff", async () => {
    const abortController = new AbortController();
    const timeoutErr = AiProviderError.timeout("mock-gemini", 30000);
    const mock = new MockProvider([
      { outcome: "error", error: timeoutErr },
      { outcome: "success", value: { result: "should not reach" } },
    ]);

    const reliable = new ReliableStructuredAiProvider(mock, {
      sleepFn: async () => {
        abortController.abort();
      },
    });

    await expect(
      reliable.generateStructured({
        taskName: "assistant-intent",
        systemInstruction: "test",
        prompt: "test",
        schema,
        signal: abortController.signal,
      }),
    ).rejects.toThrow("The operation was aborted.");

    expect(mock.calls).toBe(1);
  });
});
