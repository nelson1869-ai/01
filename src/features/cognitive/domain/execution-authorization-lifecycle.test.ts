import { describe, expect, it } from "vitest";

import {
  allowAutonomousExecution,
  createInitialExecutionSafetyState,
} from "./execution-safety";
import { recoverFromFailure } from "./recover-from-failure";
import { startAutonomousExecution } from "./start-autonomous-execution";
import type { ActionPlan } from "./action-plan";
import type { ExecutionSafetyState } from "./execution-safety";
import type { ExecutionRecord } from "./execution";
import type { AgentContext } from "./types";

const plan: ActionPlan = {
  id: "plan-1",
  candidateId: "candidate-1",
  steps: [],
  createdAt: "2026-08-30T15:58:00.000Z",
};

const policyContext: AgentContext = {
  sessionId: "session-1",
  phase: "POLICY_SAFETY",
  failureCount: 0,
  retryCount: 0,
  maxRetries: 2,
  cooldownUntilMs: null,
  workingMemory: {
    cue: {
      id: "cue-1",
    },
  },
  createdAt: "2026-08-30T00:00:00.000Z",
};

const failureContext: AgentContext = {
  ...policyContext,
  phase: "VERIFY_RESULT",
  workingMemory: {
    cue: {
      id: "cue-1",
    },
    assumption: "temporary failed assumption",
  },
};

function authorizeCandidate(
  currentSafety: ExecutionSafetyState,
  context: AgentContext = policyContext,
) {
  return allowAutonomousExecution(
    currentSafety,
    context,
    {
      candidateId: "candidate-1",
      status: "VERIFIED",
      confidence: 0.95,
      evidence: [],
      reason: "Candidate is supported by fresh trusted evidence.",
    },
    {
      candidateId: "candidate-1",
      outcome: "ALLOW",
      reason: "Candidate satisfies autonomous execution policy.",
      policyIds: ["policy-1"],
    },
  );
}

function createPendingExecution(id: string): ExecutionRecord {
  return {
    id,
    planId: plan.id,
    status: "PENDING",
    currentStepId: null,
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

function revokeAuthorization() {
  const authorization = authorizeCandidate(
    createInitialExecutionSafetyState(),
  );

  const recovery = recoverFromFailure(
    failureContext,
    authorization,
    "HALLUCINATION_DETECTED",
    1_000,
    {
      id: "audit-1",
      evidenceIds: ["evidence-1"],
      createdAt: "2026-08-30T16:01:00.000Z",
    },
  );

  return {
    authorization,
    recovery,
  };
}

describe("execution authorization lifecycle", () => {
  it("starts the correct execution with the current authorization", () => {
    const authorization = authorizeCandidate(
      createInitialExecutionSafetyState(),
    );

    const result = startAutonomousExecution(
      createPendingExecution("execution-1"),
      plan,
      authorization,
      authorization,
      "2026-08-30T16:00:00.000Z",
    );

    expect(result.status).toBe("RUNNING");
  });

  it("advances the safety generation when failure revokes authorization", () => {
    const { authorization, recovery } = revokeAuthorization();

    expect(recovery.executionSafety.status).toBe("BLOCKED");
    expect(recovery.executionSafety.generation).toBe(
      authorization.generation + 1,
    );
  });

  it("rejects stale authorization for another execution", () => {
    const { authorization, recovery } = revokeAuthorization();

    expect(() =>
      startAutonomousExecution(
        createPendingExecution("execution-2"),
        plan,
        authorization,
        recovery.executionSafety,
        "2026-08-30T16:02:00.000Z",
      ),
    ).toThrow("Autonomous execution authorization is stale.");
  });

  it("rejects stale authorization reused for the same plan", () => {
    const { authorization, recovery } = revokeAuthorization();

    expect(() =>
      startAutonomousExecution(
        createPendingExecution("execution-1"),
        plan,
        authorization,
        recovery.executionSafety,
        "2026-08-30T16:02:00.000Z",
      ),
    ).toThrow("Autonomous execution authorization is stale.");
  });

  it("accepts fresh authorization after recovery and policy evaluation", () => {
    const { authorization, recovery } = revokeAuthorization();
    const recoveredPolicyContext: AgentContext = {
      ...recovery.context,
      phase: "POLICY_SAFETY",
    };

    const freshAuthorization = authorizeCandidate(
      recovery.executionSafety,
      recoveredPolicyContext,
    );

    expect(freshAuthorization.generation).toBe(
      recovery.executionSafety.generation + 1,
    );
    expect(freshAuthorization.generation).toBeGreaterThan(
      authorization.generation,
    );

    const result = startAutonomousExecution(
      createPendingExecution("execution-2"),
      plan,
      freshAuthorization,
      freshAuthorization,
      "2026-08-30T16:03:00.000Z",
    );

    expect(result.status).toBe("RUNNING");
  });
});
