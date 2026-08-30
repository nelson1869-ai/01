import { describe, expect, it } from "vitest";

import { assertAutonomousExecutionAllowed } from "./execution-guard";
import { allowAutonomousExecution } from "./execution-safety";
import type { ExecutionSafetyState } from "./execution-safety";
import type { AgentContext } from "./types";

const policyContext: AgentContext = {
  sessionId: "session-1",
  phase: "POLICY_SAFETY",
  failureCount: 0,
  retryCount: 0,
  maxRetries: 2,
  cooldownUntilMs: null,
  workingMemory: {},
  createdAt: "2026-08-30T00:00:00.000Z",
};

describe("assertAutonomousExecutionAllowed", () => {
  it("allows execution when the safety state is ALLOWED", () => {
    const safety = allowAutonomousExecution(
      policyContext,
      {
        candidateId: "candidate-1",
        status: "VERIFIED",
        confidence: 0.95,
        evidence: [],
        reason: "Candidate is grounded.",
      },
      {
        candidateId: "candidate-1",
        outcome: "ALLOW",
        reason: "Candidate satisfies autonomous execution policy.",
        policyIds: ["policy-1"],
      },
    );

    expect(() => assertAutonomousExecutionAllowed(safety)).not.toThrow();
  });

  it("blocks execution when the safety state is BLOCKED", () => {
    const safety: ExecutionSafetyState = {
      status: "BLOCKED",
      candidateId: null,
      failure: "HALLUCINATION_DETECTED",
      reason: "Grounding failed.",
      blockedAt: "2026-08-30T15:45:00.000Z",
    };

    expect(() => assertAutonomousExecutionAllowed(safety)).toThrow(
      "Autonomous execution is blocked by the execution safety gate.",
    );
  });

  it("rejects an unbranded object that claims to be ALLOWED", () => {
    const forgedSafety = {
      status: "ALLOWED",
      candidateId: "candidate-1",
      failure: null,
      reason: null,
      blockedAt: null,
    } as unknown as ExecutionSafetyState;

    expect(() => assertAutonomousExecutionAllowed(forgedSafety)).toThrow(
      "Autonomous execution is blocked by the execution safety gate.",
    );
  });

  it("rejects a cloned authorization retargeted to another candidate", () => {
    const safety = allowAutonomousExecution(
      policyContext,
      {
        candidateId: "candidate-1",
        status: "VERIFIED",
        confidence: 0.95,
        evidence: [],
        reason: "Candidate is grounded.",
      },
      {
        candidateId: "candidate-1",
        outcome: "ALLOW",
        reason: "Candidate satisfies autonomous execution policy.",
        policyIds: ["policy-1"],
      },
    );

    const retargetedSafety = {
      ...safety,
      candidateId: "candidate-2",
    };

    expect(() => assertAutonomousExecutionAllowed(retargetedSafety)).toThrow(
      "Autonomous execution is blocked by the execution safety gate.",
    );
  });
});
