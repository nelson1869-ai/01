import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OllamaStructuredAiProvider, stripThinking } from "./ollama-provider";

describe("OllamaStructuredAiProvider", () => {
  const schema = z.object({ answer: z.string(), confidence: z.number() });

  it("enforces loopback-only URLs to prevent SSRF", () => {
    expect(
      () =>
        new OllamaStructuredAiProvider({
          baseUrl: "http://192.168.1.100:11434",
        }),
    ).toThrow(/must be a local loopback address/);
    expect(
      () =>
        new OllamaStructuredAiProvider({ baseUrl: "https://api.external.com" }),
    ).toThrow(/must be a local loopback address/);
    expect(
      () =>
        new OllamaStructuredAiProvider({ baseUrl: "http://localhost:11434" }),
    ).not.toThrow();
    expect(
      () =>
        new OllamaStructuredAiProvider({ baseUrl: "http://127.0.0.1:11434" }),
    ).not.toThrow();
    expect(
      () => new OllamaStructuredAiProvider({ baseUrl: "http://[::1]:11434" }),
    ).not.toThrow();
  });

  it("strips thinking tags and isolates pure text", () => {
    const raw =
      '<think>\nThinking about the response\nLet me make sure...\n</think>{"answer": "TypeScript is typed JS", "confidence": 0.99}';
    const cleaned = stripThinking(raw);
    expect(cleaned).toBe(
      '{"answer": "TypeScript is typed JS", "confidence": 0.99}',
    );
    expect(cleaned).not.toContain("Thinking about the response");
  });

  it("successfully parses valid structured JSON response from Ollama chat", async () => {
    const fakeFetch: typeof fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "qwen3.5:9b",
          message: {
            role: "assistant",
            content:
              '{"answer": "TypeScript adds static types.", "confidence": 0.95}',
            thinking: "Private model thoughts that should be discarded",
          },
          done: true,
          prompt_eval_count: 50,
          eval_count: 20,
        }),
    } as unknown as Response);

    const provider = new OllamaStructuredAiProvider({
      fetchFn: fakeFetch,
    });

    const res = await provider.generateStructured({
      taskName: "test-task",
      systemInstruction: "You are a test system.",
      prompt: "Explain TypeScript.",
      schema,
    });

    expect(res.value).toEqual({
      answer: "TypeScript adds static types.",
      confidence: 0.95,
    });
    expect(res.provider).toBe("ollama");
    expect(res.model).toBe("qwen3.5:9b");
    expect(res.usage?.totalTokens).toBe(70);
    expect(JSON.stringify(res)).not.toContain("Private model thoughts");
  });

  it("normalizes schema validation failure into INVALID_STRUCTURED_OUTPUT", async () => {
    const fakeFetch: typeof fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "qwen3.5:9b",
          message: {
            role: "assistant",
            content: '{"answer": "Missing confidence field"}',
          },
        }),
    } as unknown as Response);

    const provider = new OllamaStructuredAiProvider({ fetchFn: fakeFetch });

    await expect(
      provider.generateStructured({
        taskName: "test-task",
        systemInstruction: "test",
        prompt: "test",
        schema,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
      provider: "ollama",
    });
  });

  it("normalizes unparseable non-JSON into INVALID_STRUCTURED_OUTPUT", async () => {
    const fakeFetch: typeof fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "qwen3.5:9b",
          message: {
            role: "assistant",
            content: "Sorry, I cannot produce JSON right now.",
          },
        }),
    } as unknown as Response);

    const provider = new OllamaStructuredAiProvider({ fetchFn: fakeFetch });

    await expect(
      provider.generateStructured({
        taskName: "test-task",
        systemInstruction: "test",
        prompt: "test",
        schema,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
      provider: "ollama",
    });
  });

  it("normalizes connection failure into PROVIDER_UNAVAILABLE", async () => {
    const fakeFetch: typeof fetch = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434"));

    const provider = new OllamaStructuredAiProvider({ fetchFn: fakeFetch });

    await expect(
      provider.generateStructured({
        taskName: "test-task",
        systemInstruction: "test",
        prompt: "test",
        schema,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "ollama",
    });
  });

  it("normalizes 404 model missing into PROVIDER_UNAVAILABLE", async () => {
    const fakeFetch: typeof fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "model 'qwen3.5:9b' not found, try pulling it first",
    } as unknown as Response);

    const provider = new OllamaStructuredAiProvider({ fetchFn: fakeFetch });

    await expect(
      provider.generateStructured({
        taskName: "test-task",
        systemInstruction: "test",
        prompt: "test",
        schema,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "ollama",
    });
  });

  it("handles timeout cancellation safely", async () => {
    const fakeFetch: typeof fetch = vi
      .fn()
      .mockImplementation((_url, init: RequestInit) => {
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new Error("The operation was aborted"));
          });
        });
      });

    const provider = new OllamaStructuredAiProvider({
      fetchFn: fakeFetch,
      defaultTimeoutMs: 25,
    });

    await expect(
      provider.generateStructured({
        taskName: "test-task",
        systemInstruction: "test",
        prompt: "test",
        schema,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      provider: "ollama",
    });
  });

  it("checks health cleanly via /api/tags", async () => {
    const fakeFetch: typeof fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "qwen3.5:9b" }] }),
    } as unknown as Response);

    const provider = new OllamaStructuredAiProvider({ fetchFn: fakeFetch });
    const health = await provider.checkHealth();
    expect(health.available).toBe(true);
    expect(health.models).toContain("qwen3.5:9b");
  });

  it("aborts fetch promptly when caller AbortSignal triggers without mapping to TIMEOUT", async () => {
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const fakeFetch: typeof fetch = vi
      .fn()
      .mockImplementation((_url, init: RequestInit) => {
        receivedSignal = init.signal as AbortSignal;
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        });
      });

    const provider = new OllamaStructuredAiProvider({
      fetchFn: fakeFetch,
      defaultTimeoutMs: 10_000,
    });

    const pending = provider.generateStructured({
      taskName: "test-task",
      systemInstruction: "test",
      prompt: "test",
      schema,
      signal: abortController.signal,
    });

    // Caller aborts
    abortController.abort();

    await expect(pending).rejects.toThrow("The operation was aborted.");
    expect(receivedSignal?.aborted).toBe(true);
  });
});
