import { describe, expect, it } from "vitest";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedActionPlan } from "../persistence/contracts/persisted-action-plan";
import { DefaultOperationRequestBuilder } from "./operation-request-builder";

describe("DefaultOperationRequestBuilder", () => {
  const builder = new DefaultOperationRequestBuilder();

  const dummyCandidate: PersistedCandidateAction = {
    candidateId: "cand-1",
    sessionId: "sess-1",
    cueId: "cue-1",
    evaluationGeneration: 1,
    goal: "Read the project README.md documentation",
    action: "github.contents.read",
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

  const dummyPlan: PersistedActionPlan = {
    planId: "plan-1",
    candidateId: "cand-1",
    planGeneration: 1,
    steps: [{ stepId: "step-1", ordinal: 0, description: "Read README" }],
    dependencies: [],
    createdAt: "2026-08-31T05:00:00.000Z",
  };

  it("builds deterministic typed operation request with scope github-rest", () => {
    const result = builder.buildOperationRequest(
      dummyCandidate,
      dummyPlan,
      dummyPlan.steps[0],
    );

    expect(result.operationKind).toBe("github.contents.read");
    expect(result.providerScope).toBe("github-rest");
    expect(result.request).toEqual({
      repository: "nelson1869-ai/01",
      path: "README.md",
      ref: "main",
    });
    expect(result.requestFingerprint).toBeDefined();
    expect(typeof result.requestFingerprint).toBe("string");
  });

  it("produces identical request fingerprint for identical operation requests (deterministic replay)", () => {
    const req1 = builder.buildOperationRequest(
      dummyCandidate,
      dummyPlan,
      dummyPlan.steps[0],
    );

    const req2 = builder.buildOperationRequest(
      dummyCandidate,
      dummyPlan,
      dummyPlan.steps[0],
    );

    expect(req1.requestFingerprint).toBe(req2.requestFingerprint);
  });

  it("produces different request fingerprint when operation kind or parameters differ", () => {
    const req1 = builder.buildOperationRequest(
      dummyCandidate,
      dummyPlan,
      dummyPlan.steps[0],
    );

    const req2 = builder.buildOperationRequest(
      { ...dummyCandidate, action: "github.repo.get" },
      dummyPlan,
      dummyPlan.steps[0],
    );

    expect(req1.requestFingerprint).not.toBe(req2.requestFingerprint);
  });
});
