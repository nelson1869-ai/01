import { describe, expect, it } from "vitest";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import type { AssembledCognitiveContext } from "./context-assembler";
import {
  GitHubGroundingEvaluator,
  GitHubPolicyEvaluator,
} from "./github-grounding-policy";

const dummyContext = {} as AssembledCognitiveContext;

describe("GitHubGroundingEvaluator and GitHubPolicyEvaluator", () => {
  const grounding = new GitHubGroundingEvaluator();
  const policy = new GitHubPolicyEvaluator();

  const validCandidate: PersistedCandidateAction = {
    candidateId: "cand-1",
    sessionId: "sess-1",
    cueId: "cue-1",
    evaluationGeneration: 1,
    goal: "Read repository metadata",
    action: "github.repo.get",
    confidence: 0.95,
    expectedUtility: 0.9,
    estimatedRisk: 0.1,
    estimatedCost: 0.05,
    scoreValue: 0.9,
    recommendation: "AUTO_CANDIDATE",
    scoreFormulaVersion: "v1",
    evidenceIds: [],
    createdAt: "2026-08-31T05:00:00.000Z",
  };

  it("grounds supported read-only actions as VERIFIED", async () => {
    const evalResult = await grounding.evaluateGrounding(
      validCandidate,
      dummyContext,
    );
    expect(evalResult.status).toBe("VERIFIED");
    expect(evalResult.confidence).toBe(1.0);
  });

  it("grounds mutating or write actions as CONFLICTING_EVIDENCE", async () => {
    const writeCandidate: PersistedCandidateAction = {
      ...validCandidate,
      goal: "Write to README file",
      action: "github.contents.write",
    };

    const evalResult = await grounding.evaluateGrounding(
      writeCandidate,
      dummyContext,
    );
    expect(evalResult.status).toBe("CONFLICTING_EVIDENCE");
    expect(evalResult.confidence).toBe(0.0);
  });

  it("permits verified read-only actions under policy github-readonly-v1 (ALLOW)", async () => {
    const groundingResult: PersistedGroundingResult = {
      groundingResultId: "ground-1",
      candidateId: "cand-1",
      evaluationKey: "eval-1",
      status: "VERIFIED",
      confidence: 1.0,
      reason: "Verified read action",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: "2026-08-31T05:00:00.000Z",
    };

    const policyResult = await policy.evaluatePolicy(
      validCandidate,
      groundingResult,
      dummyContext,
    );
    expect(policyResult.outcome).toBe("ALLOW");
    expect(policyResult.policyIds).toContain("github-readonly-v1");
  });

  it("denies ungrounded actions under policy github-readonly-v1 (DENY)", async () => {
    const unverifiedGrounding: PersistedGroundingResult = {
      groundingResultId: "ground-2",
      candidateId: "cand-1",
      evaluationKey: "eval-2",
      status: "UNVERIFIED",
      confidence: 0.2,
      reason: "Missing evidence",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: "2026-08-31T05:00:00.000Z",
    };

    const policyResult = await policy.evaluatePolicy(
      validCandidate,
      unverifiedGrounding,
      dummyContext,
    );
    expect(policyResult.outcome).toBe("DENY");
  });

  it("denies mutating write actions even if confidence is 1.0", async () => {
    const writeCandidate: PersistedCandidateAction = {
      ...validCandidate,
      action: "github.contents.write",
      confidence: 1.0,
    };

    const verifiedGrounding: PersistedGroundingResult = {
      groundingResultId: "ground-3",
      candidateId: "cand-1",
      evaluationKey: "eval-3",
      status: "VERIFIED",
      confidence: 1.0,
      reason: "Fake verified",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: "2026-08-31T05:00:00.000Z",
    };

    const policyResult = await policy.evaluatePolicy(
      writeCandidate,
      verifiedGrounding,
      dummyContext,
    );
    expect(policyResult.outcome).toBe("DENY");
  });
});
