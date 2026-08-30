import { describe, expect, it } from "vitest";

import { startAutonomousExecution } from "./start-autonomous-execution";
import {
  allowAutonomousExecution,
  createInitialExecutionSafetyState,
} from "./execution-safety";
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
  workingMemory: {},
  createdAt: "2026-08-30T00:00:00.000Z",
};

function authorizeCandidate(candidateId: string): ExecutionSafetyState {
  return allowAutonomousExecution(
    createInitialExecutionSafetyState(),
    policyContext,
    {
      candidateId,
      status: "VERIFIED",
      confidence: 0.95,
      evidence: [],
      reason: "Candidate is grounded.",
    },
    {
      candidateId,
      outcome: "ALLOW",
      reason: "Candidate satisfies autonomous execution policy.",
      policyIds: ["policy-1"],
    },
  );
}

describe("startAutonomousExecution", () => {
  // ============================================================
  // TEST 1: PENDING + ALLOWED → RUNNING
  // ============================================================
  it("starts a pending execution when autonomous execution is allowed", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    const safety = authorizeCandidate("candidate-1");

    const result = startAutonomousExecution(
      execution,
      plan,
      safety,
      safety,
      "2026-08-30T16:00:00.000Z",
    );

    expect(result).toEqual({
      id: "execution-1",
      planId: "plan-1",
      status: "RUNNING",
      currentStepId: null,
      startedAt: "2026-08-30T16:00:00.000Z",
      completedAt: null,
      error: null,
    });
  });

  // ============================================================
  // TEST 2: BLOCKED SAFETY → DO NOT START
  // ============================================================
  it("rejects execution when autonomous execution is blocked", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    const safety: ExecutionSafetyState = {
      status: "BLOCKED",
      generation: 1,
      candidateId: null,
      failure: "HALLUCINATION_DETECTED",
      reason: "Grounding failed.",
      blockedAt: "2026-08-30T15:59:00.000Z",
    };

    expect(() =>
      startAutonomousExecution(
        execution,
        plan,
        safety,
        safety,
        "2026-08-30T16:00:00.000Z",
      ),
    ).toThrow("Autonomous execution is blocked by the execution safety gate.");
  });

  // ============================================================
  // TEST 3: NON-PENDING EXECUTION → DO NOT START AGAIN
  // ============================================================
  it("rejects an execution that is already running", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "RUNNING",
      currentStepId: null,
      startedAt: "2026-08-30T15:59:00.000Z",
      completedAt: null,
      error: null,
    };

    const safety = authorizeCandidate("candidate-1");

    expect(() =>
      startAutonomousExecution(
        execution,
        plan,
        safety,
        safety,
        "2026-08-30T16:00:00.000Z",
      ),
    ).toThrow("Only a pending execution can be started.");
  });

  it("rejects an execution that is already blocked", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "BLOCKED",
      currentStepId: "step-1",
      startedAt: "2026-08-30T15:59:00.000Z",
      completedAt: "2026-08-30T15:59:30.000Z",
      error: "Execution was safety-blocked.",
    };

    const safety = authorizeCandidate("candidate-1");

    expect(() =>
      startAutonomousExecution(
        execution,
        plan,
        safety,
        safety,
        "2026-08-30T16:00:00.000Z",
      ),
    ).toThrow("Only a pending execution can be started.");
  });

  it("rejects an authorization for a different candidate than the plan", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    const safety = authorizeCandidate("candidate-2");

    expect(() =>
      startAutonomousExecution(
        execution,
        plan,
        safety,
        safety,
        "2026-08-30T16:00:00.000Z",
      ),
    ).toThrow(
      "Execution authorization and plan must reference the same candidate.",
    );
  });

  it("rejects an execution record for a different plan", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-2",
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    const safety = authorizeCandidate("candidate-1");

    expect(() =>
      startAutonomousExecution(
        execution,
        plan,
        safety,
        safety,
        "2026-08-30T16:00:00.000Z",
      ),
    ).toThrow("Execution record and plan must reference the same plan.");
  });
});
