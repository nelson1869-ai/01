import { describe, expect, expectTypeOf, it } from "vitest";

import {
  allowAutonomousExecution,
  blockAutonomousExecution,
  createInitialExecutionSafetyState,
} from "./execution-safety";

import type { GroundingResult } from "./grounding";
import type { PolicyDecision } from "./policy-decision";
import type { ExecutionSafetyState } from "./execution-safety";
import type { AgentContext } from "./types";

function createContext(phase: AgentContext["phase"]): AgentContext {
  return {
    sessionId: "session-1",
    phase,
    failureCount: 0,
    retryCount: 0,
    maxRetries: 2,
    cooldownUntilMs: phase === "COOLDOWN" ? 250_000 : null,
    workingMemory: {},
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("execution safety", () => {
  // ============================================================
  // TEST 1: FAILURE → BLOCK EXECUTION
  // ============================================================
  it("blocks autonomous execution after a recoverable failure", () => {
    const result = blockAutonomousExecution(
      createInitialExecutionSafetyState(),
      "HALLUCINATION_DETECTED",
      "Grounding could not verify the proposed action.",
      "2026-08-30T15:30:00.000Z",
    );

    expect(result).toMatchObject({
      status: "BLOCKED",
      generation: 1,
      candidateId: null,
      failure: "HALLUCINATION_DETECTED",
      reason: "Grounding could not verify the proposed action.",
      blockedAt: "2026-08-30T15:30:00.000Z",
    });
  });

  // ============================================================
  // TEST 2: VERIFIED + ALLOW + SAME CANDIDATE → ALLOWED
  // ============================================================
  it("allows autonomous execution only after verified grounding and policy approval", () => {
    const grounding: GroundingResult = {
      candidateId: "candidate-1",
      status: "VERIFIED",
      confidence: 0.95,
      evidence: [],
      reason: "Candidate is supported by trusted evidence.",
    };

    const policy: PolicyDecision = {
      candidateId: "candidate-1",
      outcome: "ALLOW",
      reason: "Candidate satisfies autonomous execution policy.",
      policyIds: ["policy-1"],
    };

    const result = allowAutonomousExecution(
      createInitialExecutionSafetyState(),
      createContext("POLICY_SAFETY"),
      grounding,
      policy,
    );

    expect(result).toMatchObject({
      status: "ALLOWED",
      generation: 1,
      candidateId: "candidate-1",
      failure: null,
      reason: null,
      blockedAt: null,
    });
  });

  // ============================================================
  // TEST 3: UNVERIFIED GROUNDING → BLOCK
  // ============================================================
  it("rejects autonomous execution when grounding is not verified", () => {
    const grounding: GroundingResult = {
      candidateId: "candidate-1",
      status: "INSUFFICIENT_EVIDENCE",
      confidence: 0.4,
      evidence: [],
      reason: "Not enough trusted evidence.",
    };

    const policy: PolicyDecision = {
      candidateId: "candidate-1",
      outcome: "ALLOW",
      reason: "Policy would otherwise allow the action.",
      policyIds: ["policy-1"],
    };

    expect(() =>
      allowAutonomousExecution(
        createInitialExecutionSafetyState(),
        createContext("POLICY_SAFETY"),
        grounding,
        policy,
      ),
    ).toThrow(
      "Autonomous execution requires verified grounding.",
    );
  });

  // ============================================================
  // TEST 4: HUMAN APPROVAL REQUIRED → NOT AUTO-ALLOWED
  // ============================================================
  it("rejects autonomous execution when policy requires human approval", () => {
    const grounding: GroundingResult = {
      candidateId: "candidate-1",
      status: "VERIFIED",
      confidence: 0.95,
      evidence: [],
      reason: "Candidate is grounded.",
    };

    const policy: PolicyDecision = {
      candidateId: "candidate-1",
      outcome: "REQUIRE_APPROVAL",
      reason: "A human must approve this action.",
      policyIds: ["policy-sensitive-action"],
    };

    expect(() =>
      allowAutonomousExecution(
        createInitialExecutionSafetyState(),
        createContext("POLICY_SAFETY"),
        grounding,
        policy,
      ),
    ).toThrow(
      "Autonomous execution requires an ALLOW policy decision.",
    );
  });

  // ============================================================
  // TEST 5: DIFFERENT CANDIDATES → BLOCK
  // ============================================================
  it("rejects mismatched grounding and policy decisions", () => {
    const grounding: GroundingResult = {
      candidateId: "candidate-A",
      status: "VERIFIED",
      confidence: 0.95,
      evidence: [],
      reason: "Candidate A is grounded.",
    };

    const policy: PolicyDecision = {
      candidateId: "candidate-B",
      outcome: "ALLOW",
      reason: "Candidate B is allowed.",
      policyIds: ["policy-1"],
    };

    expect(() =>
      allowAutonomousExecution(
        createInitialExecutionSafetyState(),
        createContext("POLICY_SAFETY"),
        grounding,
        policy,
      ),
    ).toThrow(
      "Grounding and policy decisions must reference the same candidate.",
    );
  });

  it.each(["COOLDOWN", "HUMAN_REVIEW"] as const)(
    "rejects autonomous authorization during %s",
    (phase) => {
      const grounding: GroundingResult = {
        candidateId: "candidate-1",
        status: "VERIFIED",
        confidence: 0.95,
        evidence: [],
        reason: "Candidate is grounded.",
      };

      const policy: PolicyDecision = {
        candidateId: "candidate-1",
        outcome: "ALLOW",
        reason: "Candidate satisfies autonomous execution policy.",
        policyIds: ["policy-1"],
      };

      expect(() =>
        allowAutonomousExecution(
          createInitialExecutionSafetyState(),
          createContext(phase),
          grounding,
          policy,
        ),
      ).toThrow(
        "Autonomous execution can only be authorized during POLICY_SAFETY.",
      );
    },
  );

  it("makes contradictory execution safety states impossible by type", () => {
    expectTypeOf<{
      status: "ALLOWED";
      generation: 1;
      candidateId: "candidate-1";
      failure: null;
      reason: null;
      blockedAt: null;
    }>().not.toMatchTypeOf<ExecutionSafetyState>();

    expectTypeOf<{
      status: "ALLOWED";
      generation: 1;
      candidateId: "candidate-1";
      failure: "HALLUCINATION_DETECTED";
      reason: "failed";
      blockedAt: "2026-08-30T15:30:00.000Z";
    }>().not.toMatchTypeOf<ExecutionSafetyState>();

    expectTypeOf<{
      status: "BLOCKED";
      generation: 1;
      candidateId: "candidate-1";
      failure: null;
      reason: null;
      blockedAt: null;
    }>().not.toMatchTypeOf<ExecutionSafetyState>();
  });
});
