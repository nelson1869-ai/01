import { describe, expect, it } from "vitest";
import {
  formatSseEvent,
  ProgressEmitter,
  safeAssistantProgressEventSchema,
  safeModelSelectedMessage,
  safeRetryMessage,
  safeStageMessage,
  safeToolExecutionMessage,
  type SafeAssistantProgressEvent,
} from "./assistant-progress";

describe("Assistant Progress Streaming Contracts", () => {
  it("formats SSE frames with standards-compliant event and data fields", () => {
    const frame = formatSseEvent("progress", {
      requestId: "req-123",
      stage: "RECEIVED",
      message: "Request received.",
    });

    expect(frame).toBe(
      'event: progress\ndata: {"requestId":"req-123","stage":"RECEIVED","message":"Request received."}\n\n',
    );
  });

  it("produces monotonically increasing sequence numbers", async () => {
    const events: SafeAssistantProgressEvent[] = [];
    const emitter = new ProgressEmitter(
      {
        emit(event) {
          events.push(event);
        },
      },
      "req-abc",
    );

    await emitter.emit({ stage: "RECEIVED" });
    await emitter.emit({ stage: "CONTEXT" });
    await emitter.emit({ stage: "ROUTING" });
    await emitter.emit({
      stage: "MODEL_SELECTED",
      provider: "ollama",
      model: "qwen3.5:9b",
    });
    await emitter.emit({ stage: "COMPLETED" });

    expect(events).toHaveLength(5);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.requestId === "req-abc")).toBe(true);
  });

  it("validates safe progress events strictly against schema", () => {
    const valid = {
      requestId: "req-123",
      sequence: 1,
      stage: "RECEIVED",
      message: "Request received.",
      occurredAt: new Date().toISOString(),
    };
    expect(safeAssistantProgressEventSchema.parse(valid)).toEqual(valid);

    // Rejects invalid sequence
    expect(() =>
      safeAssistantProgressEventSchema.parse({
        ...valid,
        sequence: 0,
      }),
    ).toThrow();

    // Rejects invalid stage
    expect(() =>
      safeAssistantProgressEventSchema.parse({
        ...valid,
        stage: "INVALID_STAGE",
      }),
    ).toThrow();
  });

  it("provides safe bounded messages for models, tools, and retries", () => {
    expect(safeModelSelectedMessage("autodo", "deterministic")).toBe(
      "Using AutoDo fast path.",
    );
    expect(safeModelSelectedMessage("ollama", "qwen3.5:9b")).toBe(
      "Using local Qwen.",
    );
    expect(safeModelSelectedMessage("gemini", "gemini-3.5-flash-lite")).toBe(
      "Using Gemini Flash-Lite.",
    );
    expect(safeModelSelectedMessage("gemini", "gemini-3.7-flash")).toBe(
      "Using Gemini Flash.",
    );

    expect(safeToolExecutionMessage({ path: "README.md" })).toBe(
      "Reading README.md.",
    );
    expect(safeToolExecutionMessage({ path: "src/index.ts" })).toBe(
      "Reading src/index.ts.",
    );
    expect(safeToolExecutionMessage({ issueNumber: 42 })).toBe(
      "Reading issue #42.",
    );
    expect(safeToolExecutionMessage({ pullNumber: 7 })).toBe(
      "Reading pull request #7.",
    );
    expect(safeToolExecutionMessage({ action: "github.issues.list" })).toBe(
      "Listing open issues.",
    );
    expect(safeToolExecutionMessage({ action: "github.pulls.list" })).toBe(
      "Listing open pull requests.",
    );
    expect(
      safeToolExecutionMessage({ action: "github.pull_requests.list" }),
    ).toBe("Listing open pull requests.");
    expect(
      safeToolExecutionMessage({
        action: "github.pull_request.get",
        pullNumber: 15,
      }),
    ).toBe("Reading pull request #15.");

    expect(safeRetryMessage("RATE_LIMITED")).toBe(
      "The AI provider is temporarily busy. Retrying safely.",
    );
    expect(safeRetryMessage("TIMEOUT")).toBe(
      "The AI provider is taking longer than expected. Retrying safely.",
    );
    expect(safeRetryMessage("PROVIDER_UNAVAILABLE")).toBe(
      "The AI provider is temporarily unavailable. Retrying safely.",
    );

    expect(safeStageMessage("SAFETY_CHECK")).toBe(
      "Checking safety and permissions.",
    );
    expect(safeStageMessage("PLANNING")).toBe(
      "Preparing the requested operation.",
    );
    expect(safeStageMessage("OBSERVING")).toBe("Processing the tool result.");
    expect(safeStageMessage("VERIFYING")).toBe("Verifying the result.");
    expect(safeStageMessage("COMPOSING")).toBe("Preparing the final answer.");
    expect(safeStageMessage("COMPLETED")).toBe("Done.");
  });

  it("sanitizes malicious paths and numeric identifiers in tool progress messages", () => {
    const maliciousPath = safeToolExecutionMessage({
      path: "../../../etc/passwd<script>",
    });
    expect(maliciousPath).not.toContain("<script>");
    expect(maliciousPath).toBe("Reading ../../../etc/passwdscript.");

    const emptySpecial = safeToolExecutionMessage({
      path: "<>\"'",
    });
    expect(emptySpecial).toBe("Reading the requested repository file.");

    const safeNum = safeToolExecutionMessage({
      issueNumber: -99.99,
    });
    expect(safeNum).toBe("Reading issue #99.");
  });
});
