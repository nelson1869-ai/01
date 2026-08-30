import { describe, expect, it } from "vitest";

import { FAILURE_COOLDOWN_MS } from "./cooldown";
import { recoverFromFailure } from "./recover-from-failure";
import type { AgentContext } from "./types";

describe("recoverFromFailure", () => {
  // ============================================================
  // TEST 1: FIRST FAILURE → FRESH CONTEXT RETRY
  // ============================================================
  it("retries the first recoverable failure with fresh context", () => {
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

        // Temporary assumption that must disappear.
        assumption: "temporary guess",
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const result = recoverFromFailure(
      context,
      "HALLUCINATION_DETECTED",
      1_000,
      {
        id: "audit-1",
        evidenceIds: ["evidence-1"],
        createdAt: "2026-08-30T01:00:00.000Z",
      },
    );

    // ============================================================
    // RECOVERY DECISION
    // ============================================================
    expect(result.decision.action).toBe("RETRY_WITH_FRESH_CONTEXT");

    // ============================================================
    // RECOVERED CONTEXT
    // ============================================================
    expect(result.context.phase).toBe("BUILD_CONTEXT");

    expect(result.context.failureCount).toBe(1);

    expect(result.context.retryCount).toBe(1);

    expect(result.context.cooldownUntilMs).toBeNull();

    // Fresh mind:
    // preserve only the original cue.
    expect(result.context.workingMemory).toEqual({
      cue: {
        id: "cue-1",
      },
    });

    // ============================================================
    // AUDIT EVENT
    // ============================================================
    expect(result.audit.id).toBe("audit-1");

    expect(result.audit.failure).toBe("HALLUCINATION_DETECTED");

    // Audit keeps the ORIGINAL phase where failure happened.
    expect(result.audit.phase).toBe("VERIFY_RESULT");

    expect(result.audit.evidenceIds).toEqual(["evidence-1"]);

    // ============================================================
    // EXECUTION SAFETY
    // ============================================================
    // Failure immediately blocks autonomous execution.
    expect(result.executionSafety.status).toBe("BLOCKED");

    expect(result.executionSafety.failure).toBe("HALLUCINATION_DETECTED");

    expect(result.executionSafety.reason).toBe(result.decision.reason);

    expect(result.executionSafety.blockedAt).toBe("2026-08-30T01:00:00.000Z");
  });

  // ============================================================
  // TEST 2: SECOND FAILURE → 4-MINUTE COOLDOWN
  // ============================================================
  it("starts a four-minute cooldown after the second recoverable failure", () => {
    const nowMs = 10_000;

    const context: AgentContext = {
      sessionId: "session-1",
      phase: "VERIFY_RESULT",

      // First failure already happened.
      failureCount: 1,

      // First retry already happened.
      retryCount: 1,

      maxRetries: 2,

      cooldownUntilMs: null,

      workingMemory: {
        cue: {
          id: "cue-1",
        },

        // Temporary data from the failed retry.
        assumption: "another temporary guess",
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const result = recoverFromFailure(
      context,
      "HALLUCINATION_DETECTED",
      nowMs,
      {
        id: "audit-2",
        evidenceIds: ["evidence-2"],
        createdAt: "2026-08-30T01:01:00.000Z",
      },
    );

    // ============================================================
    // RECOVERY DECISION
    // ============================================================
    expect(result.decision.action).toBe("START_COOLDOWN");

    // ============================================================
    // RECOVERED CONTEXT
    // ============================================================
    expect(result.context.phase).toBe("COOLDOWN");

    expect(result.context.failureCount).toBe(2);

    // Retry is NOT consumed yet.
    expect(result.context.retryCount).toBe(1);

    // OUTPUT: 250000
    expect(result.context.cooldownUntilMs).toBe(nowMs + FAILURE_COOLDOWN_MS);

    // Temporary assumptions are removed.
    expect(result.context.workingMemory).toEqual({
      cue: {
        id: "cue-1",
      },
    });

    // ============================================================
    // AUDIT EVENT
    // ============================================================
    expect(result.audit.id).toBe("audit-2");

    expect(result.audit.action).toBe("START_COOLDOWN");

    expect(result.audit.phase).toBe("VERIFY_RESULT");

    // ============================================================
    // EXECUTION SAFETY
    // ============================================================
    expect(result.executionSafety.status).toBe("BLOCKED");

    expect(result.executionSafety.failure).toBe("HALLUCINATION_DETECTED");
  });

  // ============================================================
  // TEST 3: THIRD FAILURE → HUMAN REVIEW
  // ============================================================
  it("escalates the third recoverable failure to human review", () => {
    const context: AgentContext = {
      sessionId: "session-1",
      phase: "VERIFY_RESULT",

      // Two failures already happened.
      failureCount: 2,

      // Two retries already started.
      retryCount: 2,

      // Keep budget available.
      // This proves failure #3 itself causes escalation.
      maxRetries: 5,

      cooldownUntilMs: null,

      workingMemory: {
        cue: {
          id: "cue-1",
        },

        assumption: "failed third-attempt assumption",
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const result = recoverFromFailure(
      context,
      "HALLUCINATION_DETECTED",
      20_000,
      {
        id: "audit-3",
        evidenceIds: ["evidence-3"],
        createdAt: "2026-08-30T01:02:00.000Z",
      },
    );

    // ============================================================
    // RECOVERY DECISION
    // ============================================================
    expect(result.decision.action).toBe("ESCALATE_TO_HUMAN");

    // ============================================================
    // RECOVERED CONTEXT
    // ============================================================
    expect(result.context.phase).toBe("HUMAN_REVIEW");

    expect(result.context.failureCount).toBe(3);

    // No extra retry is started.
    expect(result.context.retryCount).toBe(2);

    expect(result.context.cooldownUntilMs).toBeNull();

    // Temporary assumptions are removed.
    expect(result.context.workingMemory).toEqual({
      cue: {
        id: "cue-1",
      },
    });

    // ============================================================
    // AUDIT EVENT
    // ============================================================
    expect(result.audit.id).toBe("audit-3");

    expect(result.audit.action).toBe("ESCALATE_TO_HUMAN");

    expect(result.audit.failureCount).toBe(3);

    // ============================================================
    // EXECUTION SAFETY
    // ============================================================
    expect(result.executionSafety.status).toBe("BLOCKED");

    expect(result.executionSafety.failure).toBe("HALLUCINATION_DETECTED");
  });

  // ============================================================
  // TEST 4: POLICY VIOLATION → HUMAN REVIEW IMMEDIATELY
  // ============================================================
  it("escalates a policy violation immediately without autonomous retry", () => {
    const context: AgentContext = {
      sessionId: "session-1",
      phase: "POLICY_SAFETY",

      // First failure.
      failureCount: 0,

      // No retry consumed yet.
      retryCount: 0,

      // Retry budget exists,
      // but policy safety overrides it.
      maxRetries: 5,

      cooldownUntilMs: null,

      workingMemory: {
        cue: {
          id: "cue-1",
        },

        assumption: "unsafe temporary assumption",
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const result = recoverFromFailure(context, "POLICY_VIOLATION", 30_000, {
      id: "audit-4",
      evidenceIds: ["evidence-policy-1"],
      createdAt: "2026-08-30T01:03:00.000Z",
    });

    // ============================================================
    // RECOVERY DECISION
    // ============================================================
    expect(result.decision.action).toBe("ESCALATE_TO_HUMAN");

    // ============================================================
    // RECOVERED CONTEXT
    // ============================================================
    expect(result.context.phase).toBe("HUMAN_REVIEW");

    // Policy violation becomes failure #1.
    expect(result.context.failureCount).toBe(1);

    // No autonomous retry allowed.
    expect(result.context.retryCount).toBe(0);

    expect(result.context.cooldownUntilMs).toBeNull();

    // Remove unsafe temporary assumptions.
    expect(result.context.workingMemory).toEqual({
      cue: {
        id: "cue-1",
      },
    });

    // ============================================================
    // AUDIT EVENT
    // ============================================================
    expect(result.audit.id).toBe("audit-4");

    expect(result.audit.failure).toBe("POLICY_VIOLATION");

    expect(result.audit.action).toBe("ESCALATE_TO_HUMAN");

    expect(result.audit.phase).toBe("POLICY_SAFETY");

    expect(result.audit.evidenceIds).toEqual(["evidence-policy-1"]);

    // ============================================================
    // EXECUTION SAFETY
    // ============================================================
    expect(result.executionSafety.status).toBe("BLOCKED");

    expect(result.executionSafety.failure).toBe("POLICY_VIOLATION");
  });
});
