import { describe, expect, it } from "vitest";

import type { OperationAdapter } from "../adapters/adapter-contract";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import {
  advanceCognitiveCycle,
  type CognitiveCyclePorts,
} from "./cognitive-loop-driver";
import type {
  CandidateGeneratorPort,
  GeneratedCandidateAction,
  GroundingEvaluation,
  GroundingEvaluatorPort,
  PerceptionPort,
  PlanBuilderPort,
  PlanProposal,
  PolicyEvaluation,
  PolicyEvaluatorPort,
} from "./cognitive-ports";
import type {
  AssembledCognitiveContext,
  PerceptionResult,
} from "./context-assembler";
import { DeterministicResultVerifier } from "./testing/deterministic-result-verifier";

const T0 = "2026-08-31T05:00:00.000Z";

class FakePerception implements PerceptionPort {
  async perceive(cue: PersistedCueIngress): Promise<PerceptionResult> {
    return {
      summary: `Perceived cue ${cue.cueId}`,
      structuredFacts: { task: "email.send" },
      perceivedAt: T0,
    };
  }
}

class FakeCandidateGenerator implements CandidateGeneratorPort {
  constructor(private readonly candidates: GeneratedCandidateAction[]) {}
  async generateCandidates(
    context: AssembledCognitiveContext,
  ): Promise<readonly GeneratedCandidateAction[]> {
    void context;
    return this.candidates;
  }
}

class FakeGroundingEvaluator implements GroundingEvaluatorPort {
  constructor(
    private readonly evaluation: GroundingEvaluation = {
      status: "VERIFIED",
      confidence: 0.95,
      reason: "Grounded with evidence",
      evaluatorVersion: "v1",
      evidenceIds: [],
    },
  ) {}
  async evaluateGrounding(
    candidate: PersistedCandidateAction,
    context: AssembledCognitiveContext,
  ): Promise<GroundingEvaluation> {
    void candidate;
    void context;
    return this.evaluation;
  }
}

class FakePolicyEvaluator implements PolicyEvaluatorPort {
  constructor(
    private readonly evaluation: PolicyEvaluation = {
      outcome: "ALLOW",
      reason: "Allowed by test policy",
      policyEngineVersion: "v1",
      policyIds: ["policy-test-1"],
    },
  ) {}
  async evaluatePolicy(
    candidate: PersistedCandidateAction,
    grounding: PersistedGroundingResult,
    context: AssembledCognitiveContext,
  ): Promise<PolicyEvaluation> {
    void candidate;
    void grounding;
    void context;
    return this.evaluation;
  }
}

class FakePlanBuilder implements PlanBuilderPort {
  constructor(
    private readonly plan: PlanProposal = {
      planId: "plan-test-1",
      planGeneration: 1,
      steps: [{ stepId: "step-1", ordinal: 0, description: "Send email" }],
      dependencies: [],
    },
  ) {}
  async buildPlan(
    candidate: PersistedCandidateAction,
    context: AssembledCognitiveContext,
  ): Promise<PlanProposal> {
    void candidate;
    void context;
    return this.plan;
  }
}

class FakeAdapter implements OperationAdapter {
  readonly scope = "test-provider";
  readonly idempotencySupport = "NATIVE" as const;
  readonly supportsReconciliation = true;
  public dispatchCount = 0;
  async dispatch(input: unknown) {
    void input;
    this.dispatchCount++;
    return {
      outcome: "CONFIRMED_SUCCESS" as const,
      providerOperationId: "prov-ref-1",
      result: { delivered: true },
      finishedAt: T0,
    };
  }
}

describe("Cognitive Loop Driver unit tests (M6)", () => {
  const verifier = new DeterministicResultVerifier("test-verifier-v1");

  it("fails if session is not found in database", async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    } as unknown as DatabaseClient;

    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter: new FakeAdapter(),
    };

    await expect(
      advanceCognitiveCycle(fakeDb, "missing-sess", ports, {
        skillKey: "email.send",
        now: T0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns BLOCKED if session execution safety is permanently BLOCKED", async () => {
    const session: PersistedCognitiveSession = {
      sessionId: "sess-blocked",
      cueId: "cue-1",
      currentCandidateId: null,
      currentPlanId: null,
      currentExecutionId: null,
      phase: "CUE",
      failureCount: 3,
      retryCount: 3,
      maxRetries: 3,
      evaluationGeneration: 1,
      cooldownUntil: null,
      rowVersion: 1,
      createdAt: T0,
      updatedAt: T0,
    };

    let queryCount = 0;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              queryCount++;
              if (queryCount === 1) {
                return [
                  {
                    session_id: session.sessionId,
                    cue_id: session.cueId,
                    current_candidate_id: null,
                    current_plan_id: null,
                    current_execution_id: null,
                    phase: session.phase,
                    failure_count: session.failureCount,
                    retry_count: session.retryCount,
                    max_retries: session.maxRetries,
                    cooldown_until: null,
                    row_version: session.rowVersion,
                    created_at: session.createdAt,
                    updated_at: session.updatedAt,
                  },
                ];
              }
              return [
                {
                  session_id: session.sessionId,
                  generation: 1,
                  durable_status: "BLOCKED",
                  reason: "Permanent safety block",
                  failure: "EXECUTION_TIMEOUT",
                  blocked_at: T0,
                  evaluated_candidate_id: null,
                  grounding_result_id: null,
                  policy_decision_id: null,
                  updated_at: T0,
                },
              ];
            },
          }),
        }),
      }),
    } as unknown as DatabaseClient;

    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter: new FakeAdapter(),
    };

    const result = await advanceCognitiveCycle(
      fakeDb,
      session.sessionId,
      ports,
      {
        skillKey: "email.send",
        now: T0,
      },
    );

    expect(result.isBoundary).toBe(true);
    expect(result.cycleResult?.status).toBe("BLOCKED");
  });
});
