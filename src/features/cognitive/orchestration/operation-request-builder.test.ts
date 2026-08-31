import { describe, expect, it } from "vitest";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedActionPlan } from "../persistence/contracts/persisted-action-plan";
import type { AssembledCognitiveContext } from "./context-assembler";
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

  const dummyContext: AssembledCognitiveContext = {
    cue: {
      cueId: "cue-1",
      source: "test",
      externalEventId: "ev-1",
      type: "user.action",
      occurredAt: "2026-08-31T05:00:00.000Z",
      receivedAt: "2026-08-31T05:00:00.000Z",
      payload: {},
    },
    session: {
      sessionId: "sess-1",
      cueId: "cue-1",
      phase: "DURABLE_EXECUTION",
      failureCount: 0,
      retryCount: 0,
      maxRetries: 3,
      evaluationGeneration: 1,
      cooldownUntil: null,
      currentCandidateId: "cand-1",
      currentPlanId: "plan-1",
      currentExecutionId: "exec-1",
      rowVersion: 0,
      createdAt: "2026-08-31T05:00:00.000Z",
      updatedAt: "2026-08-31T05:00:00.000Z",
    },
    perception: {
      summary: "Perceived test task",
      structuredFacts: {},
      perceivedAt: "2026-08-31T05:00:00.000Z",
    },
    targetSpec: {
      kind: "FILE",
      repository: "nelson1869-ai/01",
      owner: "nelson1869-ai",
      repo: "01",
      path: "README.md",
      ref: "main",
    },
    verifiedMemories: [],
    learningState: {
      skillKey: "github.contents.read",
      confidence: 1.0,
      totalReward: 0,
      sampleCount: 0,
      rowVersion: 0,
      updatedAt: "2026-08-31T05:00:00.000Z",
    },
    metadata: {},
  };

  it("builds deterministic typed operation request with scope github-rest", () => {
    const result = builder.buildOperationRequest(
      dummyCandidate,
      dummyPlan,
      dummyPlan.steps[0],
      dummyContext,
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
      dummyContext,
    );

    const req2 = builder.buildOperationRequest(
      dummyCandidate,
      dummyPlan,
      dummyPlan.steps[0],
      dummyContext,
    );

    expect(req1.requestFingerprint).toBe(req2.requestFingerprint);
  });

  it("produces different request fingerprint when operation kind or parameters differ", () => {
    const req1 = builder.buildOperationRequest(
      dummyCandidate,
      dummyPlan,
      dummyPlan.steps[0],
      dummyContext,
    );

    const repoContext: AssembledCognitiveContext = {
      ...dummyContext,
      targetSpec: {
        kind: "REPOSITORY",
        repository: "nelson1869-ai/01",
        owner: "nelson1869-ai",
        repo: "01",
      },
    };

    const req2 = builder.buildOperationRequest(
      { ...dummyCandidate, action: "github.repo.get" },
      dummyPlan,
      dummyPlan.steps[0],
      repoContext,
    );

    expect(req1.requestFingerprint).not.toBe(req2.requestFingerprint);
  });
});
