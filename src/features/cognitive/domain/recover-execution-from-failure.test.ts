import { describe, expect, it } from "vitest";

import { createInitialExecutionSafetyState } from "./execution-safety";
import { recoverExecutionFromFailure } from "./recover-execution-from-failure";
import type { ExecutionRecord } from "./execution";
import type { AgentContext } from "./types";

describe("recoverExecutionFromFailure", () => {
  it("blocks a running execution and enters the cognitive recovery path", () => {
    const context: AgentContext = {
      sessionId: "session-1",
      phase: "VERIFY_RESULT",

      failureCount: 0,
      retryCount: 0,
      maxRetries: 2,

      cooldownUntilMs: null,

      workingMemory: {
        cue: {
          id: "cue-1",
        },

        assumption: "temporary failed assumption",
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "RUNNING",

      currentStepId: "step-3",

      startedAt: "2026-08-30T16:00:00.000Z",
      completedAt: null,
      error: null,
    };

    const result = recoverExecutionFromFailure(
      context,
      execution,
      createInitialExecutionSafetyState(),
      "HALLUCINATION_DETECTED",
      1_000,
      {
        id: "audit-1",
        evidenceIds: ["evidence-1"],
        createdAt: "2026-08-30T16:01:00.000Z",
      },
    );

    // ============================================================
    // RECOVERY DECISION
    // ============================================================
    expect(result.recovery.decision.action).toBe("RETRY_WITH_FRESH_CONTEXT");

    // ============================================================
    // COGNITIVE RECOVERY
    // ============================================================
    expect(result.recovery.context.phase).toBe("BUILD_CONTEXT");

    expect(result.recovery.context.failureCount).toBe(1);

    expect(result.recovery.context.retryCount).toBe(1);

    // Temporary assumptions are removed.
    expect(result.recovery.context.workingMemory).toEqual({
      cue: {
        id: "cue-1",
      },
    });

    // ============================================================
    // AUTONOMOUS EXECUTION PERMISSION
    // ============================================================
    expect(result.recovery.executionSafety.status).toBe("BLOCKED");

    expect(result.recovery.executionSafety.failure).toBe(
      "HALLUCINATION_DETECTED",
    );

    // ============================================================
    // EXECUTION RECORD
    // ============================================================
    expect(result.execution.status).toBe("BLOCKED");

    // Preserve exactly where execution stopped.
    expect(result.execution.currentStepId).toBe("step-3");

    expect(result.execution.startedAt).toBe("2026-08-30T16:00:00.000Z");

    expect(result.execution.completedAt).toBe("2026-08-30T16:01:00.000Z");

    expect(result.execution.error).toBe(result.recovery.decision.reason);

    // ============================================================
    // AUDIT
    // ============================================================
    expect(result.recovery.audit.id).toBe("audit-1");

    expect(result.recovery.audit.phase).toBe("VERIFY_RESULT");

    expect(result.recovery.audit.evidenceIds).toEqual(["evidence-1"]);
  });
});
