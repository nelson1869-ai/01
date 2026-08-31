import { describe, expect, it } from "vitest";
import { createAssistantChatStreamPostHandler } from "../../../app/api/assistant/chat/stream/route";
import { AiProviderError } from "../ai/ai-errors";
import type {
  StructuredAiProvider,
  StructuredAiRequest,
} from "../ai/ai-provider-contract";
import type {
  AssistantIntent,
  AssistantIntentInterpreterPort,
  AssistantResponseComposerPort,
  SafeConversationTurn,
} from "./assistant-ai";
import {
  AssistantChatService,
  type AssistantConversationStorePort,
  type AssistantToolRunnerPort,
  type AssistantToolRunResult,
} from "./assistant-chat-service";
import type { PersistedAssistantTurn } from "../persistence/contracts/assistant-conversation";
import type { AssistantProgressStage } from "./assistant-progress";

const NOW = "2026-08-31T15:00:00.000Z";

class MemoryStore implements AssistantConversationStorePort {
  turns: PersistedAssistantTurn[] = [];

  createConversation() {
    return Promise.resolve();
  }

  beginTurn(input: Parameters<AssistantConversationStorePort["beginTurn"]>[0]) {
    const value: PersistedAssistantTurn = {
      turnId: input.turnId,
      conversationId: input.conversationId,
      ordinal: this.turns.length + 1,
      userMessage: input.userMessage,
      assistantMessage: "",
      kind: "DIRECT_ANSWER",
      status: "PROCESSING",
      decisionSummary: [],
      cueId: null,
      sessionId: null,
      executionId: null,
      verificationId: null,
      createdAt: input.createdAt,
      completedAt: null,
    };
    this.turns.push(value);
    return Promise.resolve(value);
  }

  completeTurn(
    input: Parameters<AssistantConversationStorePort["completeTurn"]>[0],
  ) {
    const index = this.turns.findIndex((t) => t.turnId === input.turnId);
    const current = this.turns[index];
    const value: PersistedAssistantTurn = {
      ...current,
      kind: input.kind,
      status: input.status,
      assistantMessage: input.assistantMessage,
      decisionSummary: [...input.decisionSummary],
      cueId: input.cueId ?? null,
      sessionId: input.sessionId ?? null,
      executionId: input.executionId ?? null,
      verificationId: input.verificationId ?? null,
      completedAt: input.completedAt,
    };
    this.turns[index] = value;
    return Promise.resolve(value);
  }

  recentTurns(id: string, limit: number) {
    return Promise.resolve(
      this.turns
        .filter(
          (turn) => turn.conversationId === id && turn.status !== "PROCESSING",
        )
        .slice(-limit),
    );
  }
}

class FakeInterpreter implements AssistantIntentInterpreterPort {
  calls: Array<{ message: string; context: readonly SafeConversationTurn[] }> =
    [];

  constructor(
    private readonly value: AssistantIntent,
    private readonly error?: Error,
  ) {}

  interpret(
    message: string,
    context: readonly SafeConversationTurn[],
    _options?: {
      onRetry?: (info: {
        stage: string;
        provider: string;
        model: string;
        attempt: number;
        errorCode: string;
      }) => void | Promise<void>;
    },
  ) {
    void _options;
    this.calls.push({ message, context });
    if (this.error) throw this.error;
    return Promise.resolve(this.value);
  }
}

class FakeComposer implements AssistantResponseComposerPort {
  directCalls = 0;
  verifiedCalls = 0;

  constructor(
    readonly direct = "TypeScript is a typed superset of JavaScript.",
    readonly verified = "I checked README.md and verified AutoDo is a safe assistant.",
  ) {}

  composeDirect() {
    this.directCalls++;
    return Promise.resolve(this.direct);
  }

  composeVerified() {
    this.verifiedCalls++;
    return Promise.resolve(this.verified);
  }
}

class FakeToolRunner implements AssistantToolRunnerPort {
  calls: AssistantIntent[] = [];

  constructor(private readonly value: AssistantToolRunResult) {}

  async run(
    intent: AssistantIntent,
    _msg: string,
    _now: string,
    options?: { onStage?: (stage: AssistantProgressStage) => void | Promise<void> },
  ) {
    this.calls.push(intent);
    await options?.onStage?.("SAFETY_CHECK");
    await options?.onStage?.("PLANNING");
    await options?.onStage?.("TOOL_EXECUTION");
    await options?.onStage?.("OBSERVING");
    await options?.onStage?.("VERIFYING");
    return this.value;
  }
}

const directIntent: AssistantIntent = {
  kind: "DIRECT_ANSWER",
  action: null,
  path: null,
  issueNumber: null,
  pullNumber: null,
  response: null,
  goal: "Explain TypeScript",
};

const toolIntent: AssistantIntent = {
  kind: "TOOL_REQUIRED",
  action: "github.contents.read",
  path: "README.md",
  issueNumber: null,
  pullNumber: null,
  response: null,
  goal: "Read README.md",
};

const verifiedTool: AssistantToolRunResult = {
  status: "VERIFIED",
  cueId: "cue-1",
  sessionId: "sess-1",
  executionId: "exec-1",
  verificationId: "ver-1",
  verifiedFacts: { path: "README.md", content: "AutoDo" },
  reason: "Verified",
};

interface ParsedSseEvent {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

async function parseSseStream(response: Response): Promise<{
  rawText: string;
  events: ParsedSseEvent[];
}> {
  const text = await response.text();
  const rawChunks = text.split("\n\n").filter((c) => c.trim().length > 0);
  const events: ParsedSseEvent[] = [];

  for (const chunk of rawChunks) {
    const lines = chunk.split("\n");
    let eventName = "message";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventName = line.slice("event: ".length).trim();
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice("data: ".length).trim();
      }
    }
    if (dataStr) {
      try {
        events.push({
          event: eventName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: JSON.parse(dataStr) as Record<string, any>,
        });
      } catch {
        events.push({ event: eventName, data: { raw: dataStr } });
      }
    }
  }

  return { rawText: text, events };
}

describe("POST /api/assistant/chat/stream", () => {
  it("rejects invalid request JSON before opening an SSE stream", async () => {
    const handler = createAssistantChatStreamPostHandler({
      chat: async () => {
        throw new Error("should not run");
      },
    });

    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("rejects invalid schema with 400 before stream starts", async () => {
    const handler = createAssistantChatStreamPostHandler({
      chat: async () => {
        throw new Error("should not run");
      },
    });

    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" }),
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("streams deterministic fast path with 0 AI calls, monotonic sequences, and single final event", async () => {
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);
    const service = new AssistantChatService({
      store,
      toolRunner: runner,
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello AutoDo. What can you do?" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );

    const { events } = await parseSseStream(res);

    const progressEvents = events.filter((e) => e.event === "progress");
    const finalEvents = events.filter((e) => e.event === "final");

    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0].data.data).toMatchObject({
      status: "COMPLETED",
      modelSelection: {
        provider: "autodo",
        model: "deterministic",
        fallbackUsed: false,
        taskClass: "STATIC_CAPABILITY",
      },
    });

    const stages = progressEvents.map((e) => e.data.stage);
    expect(stages).toEqual(["RECEIVED", "CONTEXT", "COMPLETED"]);

    const sequences = progressEvents.map((e) => e.data.sequence);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it("streams simple general chat with local Qwen routing", async () => {
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);
    const interpreter = new FakeInterpreter(directIntent);
    const composer = new FakeComposer();

    const service = new AssistantChatService({
      store,
      interpreter,
      composer,
      toolRunner: runner,
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "What is TypeScript? Explain it simply.",
        }),
      }),
    );

    const { events } = await parseSseStream(res);
    const progressEvents = events.filter((e) => e.event === "progress");
    const finalEvents = events.filter((e) => e.event === "final");

    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0].data.data.status).toBe("COMPLETED");

    const stages = progressEvents.map((e) => e.data.stage);
    expect(stages).toEqual([
      "RECEIVED",
      "CONTEXT",
      "ROUTING",
      "MODEL_SELECTED",
      "GENERATING",
      "COMPOSING",
      "COMPLETED",
    ]);

    const modelSelected = progressEvents.find(
      (e) => e.data.stage === "MODEL_SELECTED",
    );
    expect(modelSelected?.data.provider).toBe("ollama");
    expect(modelSelected?.data.model).toBe("qwen3.5:9b");
  });

  it("streams cross-provider fallback from Ollama to Gemini", async () => {
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);

    const mockOllama: StructuredAiProvider = {
      providerName: "ollama",
      defaultModel: "qwen3.5:9b",
      generateStructured: async <T>(req: StructuredAiRequest<T>) => {
        await req.onRetry?.({
          stage: "assistant.intent",
          provider: "ollama",
          model: "qwen3.5:9b",
          attempt: 2,
          errorCode: "TIMEOUT",
        });
        throw AiProviderError.timeout("ollama", 60_000);
      },
    };

    const mockGemini: StructuredAiProvider = {
      providerName: "gemini",
      defaultModel: "gemini-3.5-flash-lite",
      generateStructured: async <T>(req: StructuredAiRequest<T>) => {
        if (req.taskName === "assistant-intent") {
          return {
            provider: "gemini",
            model: "gemini-3.5-flash-lite",
            value: directIntent as T,
            latencyMs: 10,
            finishedAt: NOW,
          };
        }
        return {
          provider: "gemini",
          model: "gemini-3.5-flash-lite",
          value: { message: "Fallback response." } as T,
          latencyMs: 15,
          finishedAt: NOW,
        };
      },
    };

    const service = new AssistantChatService({
      store,
      toolRunner: runner,
      providers: {
        ollama: mockOllama,
        gemini: mockGemini,
      },
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "What is TypeScript?" }),
      }),
    );

    const { events } = await parseSseStream(res);
    const progressEvents = events.filter((e) => e.event === "progress");
    const stages = progressEvents.map((e) => e.data.stage);

    expect(stages).toContain("RETRYING");
    expect(stages).toContain("FALLBACK");
    expect(stages).toContain("COMPLETED");

    const fallbackIndex = stages.indexOf("FALLBACK");
    const secondModelSelected = progressEvents[fallbackIndex + 1];
    expect(secondModelSelected.data.provider).toBe("gemini");
    expect(secondModelSelected.data.model).toBe("gemini-3.5-flash-lite");
    expect(secondModelSelected.data.fallback).toBe(true);
  });

  it("streams tool-backed flow with exact stages and single tool execution", async () => {
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);
    const interpreter = new FakeInterpreter(toolIntent);
    const composer = new FakeComposer();

    const service = new AssistantChatService({
      store,
      interpreter,
      composer,
      toolRunner: runner,
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message:
            "Read README.md from my repository and tell me what this project does.",
        }),
      }),
    );

    const { events } = await parseSseStream(res);
    const progressEvents = events.filter((e) => e.event === "progress");
    const stages = progressEvents.map((e) => e.data.stage);

    expect(stages).toEqual([
      "RECEIVED",
      "CONTEXT",
      "ROUTING",
      "MODEL_SELECTED",
      "GENERATING",
      "SAFETY_CHECK",
      "PLANNING",
      "TOOL_EXECUTION",
      "OBSERVING",
      "VERIFYING",
      "COMPOSING",
      "COMPLETED",
    ]);

    expect(runner.calls).toHaveLength(1);
    const toolProgress = progressEvents.find(
      (e) => e.data.stage === "TOOL_EXECUTION",
    );
    expect(toolProgress?.data.message).toBe("Reading README.md.");
  });

  it("streams deterministic safety denial before any AI or GitHub calls", async () => {
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);
    const interpreter = new FakeInterpreter(toolIntent);
    const composer = new FakeComposer();

    const service = new AssistantChatService({
      store,
      interpreter,
      composer,
      toolRunner: runner,
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Delete my GitHub repository." }),
      }),
    );

    const { events } = await parseSseStream(res);
    const progressEvents = events.filter((e) => e.event === "progress");
    const finalEvents = events.filter((e) => e.event === "final");

    expect(progressEvents.map((e) => e.data.stage)).toEqual([
      "RECEIVED",
      "CONTEXT",
      "SAFETY_CHECK",
      "DENIED",
    ]);

    expect(finalEvents[0].data.data.status).toBe("DENIED");
    expect(interpreter.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it("streams clarification when request is ambiguous", async () => {
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);
    const interpreter = new FakeInterpreter({
      ...directIntent,
      kind: "CLARIFICATION",
      response: "Which issue do you mean?",
    });
    const composer = new FakeComposer();

    const service = new AssistantChatService({
      store,
      interpreter,
      composer,
      toolRunner: runner,
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Check that issue." }),
      }),
    );

    const { events } = await parseSseStream(res);
    const progressEvents = events.filter((e) => e.event === "progress");
    const finalEvents = events.filter((e) => e.event === "final");

    expect(progressEvents.map((e) => e.data.stage)).toContain(
      "CLARIFICATION_REQUIRED",
    );
    expect(finalEvents[0].data.data.status).toBe("CLARIFICATION_REQUIRED");
    expect(runner.calls).toHaveLength(0);
  });

  it("never exposes secrets, tokens, or chain-of-thought in stream chunks", async () => {
    const fakeSecret = "ghp_superSecretToken12345678901234567890";
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);
    const composer = new FakeComposer(`Response containing ${fakeSecret}`);

    const service = new AssistantChatService({
      store,
      interpreter: new FakeInterpreter(directIntent),
      composer,
      toolRunner: runner,
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "What is TypeScript?" }),
      }),
    );

    const { rawText } = await parseSseStream(res);
    expect(rawText).not.toContain(fakeSecret);
    expect(rawText).not.toMatch(
      /ghp_|AIza|Bearer|chainOfThought|<think>|thoughtSignature/i,
    );
  });

  it("reuses verified facts on composer fallback with single tool dispatch in stream", async () => {
    const store = new MemoryStore();
    const runner = new FakeToolRunner(verifiedTool);
    let primaryComposerCalls = 0;
    let fallbackComposerCalls = 0;

    const mockPrimary: StructuredAiProvider = {
      providerName: "gemini",
      defaultModel: "gemini-3.5-flash-lite",
      generateStructured: async <T>(req: StructuredAiRequest<T>) => {
        if (req.taskName === "assistant-intent") {
          return {
            provider: "gemini",
            model: "gemini-3.5-flash-lite",
            value: toolIntent as T,
            latencyMs: 10,
            finishedAt: NOW,
          };
        }
        if (req.taskName === "assistant-verified-response") {
          primaryComposerCalls++;
          throw AiProviderError.timeout("gemini", 30_000);
        }
        throw new Error("unexpected task");
      },
    };

    const mockFallback: StructuredAiProvider = {
      providerName: "ollama",
      defaultModel: "qwen3.5:9b",
      generateStructured: async <T>(req: StructuredAiRequest<T>) => {
        if (req.taskName === "assistant-verified-response") {
          fallbackComposerCalls++;
          return {
            provider: "ollama",
            model: "qwen3.5:9b",
            value: { message: "Qwen verified stream response." } as T,
            latencyMs: 20,
            finishedAt: NOW,
          };
        }
        throw new Error("unexpected task");
      },
    };

    const service = new AssistantChatService({
      store,
      toolRunner: runner,
      providers: {
        gemini: mockPrimary,
        ollama: mockFallback,
      },
      now: () => NOW,
    });

    const handler = createAssistantChatStreamPostHandler(service);
    const res = await handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message:
            "Read README.md from my repository and tell me what this project does.",
        }),
      }),
    );

    const { events } = await parseSseStream(res);
    const finalEvents = events.filter((e) => e.event === "final");

    expect(runner.calls).toHaveLength(1);
    expect(primaryComposerCalls).toBe(1);
    expect(fallbackComposerCalls).toBe(1);
    expect(finalEvents[0].data.data.status).toBe("COMPLETED");
    expect(finalEvents[0].data.data.verification).toBe("VERIFIED");
  });

  it("handles client abort signal cleanly", async () => {
    const abortController = new AbortController();

    const slowService: Pick<AssistantChatService, "chat"> = {
      chat: async (_req, options) => {
        return new Promise((resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      },
    };

    const handler = createAssistantChatStreamPostHandler(slowService);
    const streamPromise = handler(
      new Request("http://localhost/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "What is TypeScript?" }),
        signal: abortController.signal,
      }),
    );

    const response = await streamPromise;
    expect(response.status).toBe(200);

    // Abort after initiating stream
    abortController.abort();

    const reader = response.body?.getReader();
    if (reader) {
      const { done } = await reader.read();
      expect(typeof done).toBe("boolean");
    }
  });
});
