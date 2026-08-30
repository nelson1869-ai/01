import { describe, expect, it } from "vitest";

import {
  allowAutonomousExecution,
  blockAutonomousExecution,
} from "./execution-safety";

import type { GroundingResult } from "./grounding";
import type { PolicyDecision } from "./policy-decision";

describe("execution safety", () => {
  // ============================================================
  // TEST 1: FAILURE → BLOCK EXECUTION
  // ============================================================
  it("blocks autonomous execution after a recoverable failure", () => {
    const result = blockAutonomousExecution(
      "HALLUCINATION_DETECTED",
      "Grounding could not verify the proposed action.",
      "2026-08-30T15:30:00.000Z",
    );

    expect(result).toEqual({
      status: "BLOCKED",
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

    const result = allowAutonomousExecution(grounding, policy);

    expect(result).toEqual({
      status: "ALLOWED",
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

    expect(() => allowAutonomousExecution(grounding, policy)).toThrow(
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

    expect(() => allowAutonomousExecution(grounding, policy)).toThrow(
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

    expect(() => allowAutonomousExecution(grounding, policy)).toThrow(
      "Grounding and policy decisions must reference the same candidate.",
    );
  });
});
