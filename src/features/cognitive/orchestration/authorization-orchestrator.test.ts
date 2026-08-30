import { describe, expect, it } from "vitest";

import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import type { PersistedPolicyDecision } from "../persistence/contracts/persisted-policy-decision";
import { inspectAuthorizationGate } from "./authorization-orchestrator";

describe("authorization orchestrator unit tests", () => {
  const validGrounding: PersistedGroundingResult = {
    groundingResultId: "gr-1",
    candidateId: "cand-1",
    evaluationKey: "eval-gr-1",
    status: "VERIFIED",
    confidence: 0.95,
    reason: "Grounding verified against documentation.",
    evaluatorVersion: "v1.0",
    evidenceIds: ["ev-1"],
    evaluatedAt: "2026-08-31T00:04:00.000Z",
  };

  const validPolicy: PersistedPolicyDecision = {
    policyDecisionId: "pol-1",
    candidateId: "cand-1",
    groundingResultId: "gr-1",
    evaluationKey: "eval-pol-1",
    outcome: "ALLOW",
    reason: "Policy allows autonomous execution.",
    policyEngineVersion: "v1.0",
    policyIds: ["pol-rule-1"],
    evaluatedAt: "2026-08-31T00:04:30.000Z",
  };

  it("1. inspectAuthorizationGate returns READY_TO_AUTHORIZE on valid matching gate records", () => {
    const result = inspectAuthorizationGate({
      candidateId: "cand-1",
      grounding: validGrounding,
      policy: validPolicy,
    });

    expect(result.status).toBe("READY_TO_AUTHORIZE");
    if (result.status === "READY_TO_AUTHORIZE") {
      expect(result.candidateId).toBe("cand-1");
      expect(result.groundingResultId).toBe("gr-1");
      expect(result.policyDecisionId).toBe("pol-1");
    }
  });

  it("2. inspectAuthorizationGate returns GROUNDING_NOT_VERIFIED for UNVERIFIED or CONTRADICTED grounding", () => {
    const unverified: PersistedGroundingResult = {
      ...validGrounding,
      status: "UNVERIFIED",
    };

    const res1 = inspectAuthorizationGate({
      candidateId: "cand-1",
      grounding: unverified,
      policy: validPolicy,
    });

    expect(res1.status).toBe("GROUNDING_NOT_VERIFIED");

    const contradicted: PersistedGroundingResult = {
      ...validGrounding,
      status: "CONTRADICTED",
    };

    const res2 = inspectAuthorizationGate({
      candidateId: "cand-1",
      grounding: contradicted,
      policy: validPolicy,
    });

    expect(res2.status).toBe("GROUNDING_NOT_VERIFIED");
  });

  it("3. inspectAuthorizationGate returns POLICY_REQUIRES_APPROVAL for REQUIRE_HUMAN_CONFIRMATION", () => {
    const requireApproval: PersistedPolicyDecision = {
      ...validPolicy,
      outcome: "REQUIRE_HUMAN_CONFIRMATION",
    };

    const result = inspectAuthorizationGate({
      candidateId: "cand-1",
      grounding: validGrounding,
      policy: requireApproval,
    });

    expect(result.status).toBe("POLICY_REQUIRES_APPROVAL");
  });

  it("4. inspectAuthorizationGate returns POLICY_DENIED for DENY", () => {
    const denyPolicy: PersistedPolicyDecision = {
      ...validPolicy,
      outcome: "DENY",
    };

    const result = inspectAuthorizationGate({
      candidateId: "cand-1",
      grounding: validGrounding,
      policy: denyPolicy,
    });

    expect(result.status).toBe("POLICY_DENIED");
  });

  it("5. inspectAuthorizationGate returns BINDING_MISMATCH for mismatched candidate or grounding IDs", () => {
    const mismatchCandGrounding: PersistedGroundingResult = {
      ...validGrounding,
      candidateId: "cand-other",
    };

    const res1 = inspectAuthorizationGate({
      candidateId: "cand-1",
      grounding: mismatchCandGrounding,
      policy: validPolicy,
    });

    expect(res1.status).toBe("BINDING_MISMATCH");

    const mismatchGroundingRef: PersistedPolicyDecision = {
      ...validPolicy,
      groundingResultId: "gr-other",
    };

    const res2 = inspectAuthorizationGate({
      candidateId: "cand-1",
      grounding: validGrounding,
      policy: mismatchGroundingRef,
    });

    expect(res2.status).toBe("BINDING_MISMATCH");
  });
});
