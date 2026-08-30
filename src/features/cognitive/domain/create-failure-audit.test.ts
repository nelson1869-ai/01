import { describe, expect, it } from "vitest";

import { createFailureAuditEvent } from "./create-failure-audit";
import type { FailureRecoveryDecision } from "./failure-recovery";
import type { AgentContext } from "./types";

describe("createFailureAuditEvent", () => {
  it("records the original failure context and durable evidence references", () => {
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

        // Temporary data must NOT be copied into the audit event.
        assumption: "temporary guess",
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const decision: FailureRecoveryDecision = {
      failure: "HALLUCINATION_DETECTED",
      action: "RETRY_WITH_FRESH_CONTEXT",
      failureCount: 1,
      retryCount: 0,
      reason: "First failure. Retry with fresh grounded context.",
    };

    const audit = createFailureAuditEvent(context, decision, {
      id: "audit-1",
      evidenceIds: ["evidence-1", "evidence-2"],
      createdAt: "2026-08-30T01:00:00.000Z",
    });

    expect(audit).toEqual({
      id: "audit-1",
      sessionId: "session-1",

      failure: "HALLUCINATION_DETECTED",
      action: "RETRY_WITH_FRESH_CONTEXT",

      // Failure happened here BEFORE recovery.
      phase: "VERIFY_RESULT",

      failureCount: 1,
      retryCount: 0,

      reason: "First failure. Retry with fresh grounded context.",

      evidenceIds: ["evidence-1", "evidence-2"],

      createdAt: "2026-08-30T01:00:00.000Z",
    });

    // Temporary working-memory assumptions are not part of the audit record.
    expect(audit).not.toHaveProperty("workingMemory");
  });
});
