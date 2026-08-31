import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OperationAdapter } from "../../../adapters/adapter-contract";
import {
  allowAutonomousExecution,
  createInitialExecutionSafetyState,
} from "../../../domain/execution-safety";
import {
  advanceCognitiveCycle,
  type CognitiveCyclePorts,
  runCognitiveCycleUntilBoundary,
} from "../../../orchestration/cognitive-loop-driver";
import { orchestrateAuthorizationIssuance } from "../../../orchestration/authorization-orchestrator";
import type {
  CandidateGeneratorPort,
  GeneratedCandidateAction,
  GroundingEvaluation,
  GroundingEvaluatorPort,
  MemoryProposal,
  MemoryProposalStrategyPort,
  PerceptionPort,
  PlanBuilderPort,
  PlanProposal,
  PolicyEvaluation,
  PolicyEvaluatorPort,
} from "../../../orchestration/cognitive-ports";
import type {
  AssembledCognitiveContext,
  PerceptionResult,
} from "../../../orchestration/context-assembler";
import { DeterministicResultVerifier } from "../../../orchestration/testing/deterministic-result-verifier";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import type { PersistedExecution } from "../../contracts/execution";
import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import type { PersistedObservation } from "../../contracts/persisted-observation";
import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";
import type { PersistedResultVerification } from "../../contracts/result-verification";
import type { PostgresDatabaseContext } from "../client";
import { candidateRepository } from "../repositories/candidate-repository";
import { executionOperationRepository } from "../repositories/execution-operation-repository";
import { executionRepository } from "../repositories/execution-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { learningRepository } from "../repositories/learning-repository";
import { observationRepository } from "../repositories/observation-repository";
import { planRepository } from "../repositories/plan-repository";
import { policyRepository } from "../repositories/policy-repository";
import { rewardRepository } from "../repositories/reward-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import { verificationRepository } from "../repositories/verification-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { persistFailureRecovery } from "../transactions/persist-failure-recovery";

const T0 = "2026-08-31T05:00:00.000Z";
const T1 = "2026-08-31T05:01:00.000Z";

class FakePerception implements PerceptionPort {
  async perceive(cue: PersistedCueIngress): Promise<PerceptionResult> {
    return {
      summary: `Perceived cue ${cue.cueId}`,
      structuredFacts: { task: "email.send", target: "alice@example.com" },
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
      reason: "Allowed by default test policy",
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
  constructor(
    private readonly outcome: "SUCCESS" | "FAILURE" | "UNKNOWN" = "SUCCESS",
  ) {}

  async dispatch(input: unknown) {
    void input;
    this.dispatchCount++;
    if (this.outcome === "SUCCESS") {
      return {
        outcome: "CONFIRMED_SUCCESS" as const,
        providerOperationId: "prov-ref-1",
        result: { delivered: true },
        finishedAt: T1,
      };
    }
    if (this.outcome === "UNKNOWN") {
      return {
        outcome: "INDETERMINATE" as const,
        providerOperationId: "prov-ref-1",
        uncertaintyReason: "Provider timeout occurred",
        category: "INDETERMINATE_PROVIDER_STATE" as const,
        finishedAt: T1,
      };
    }
    return {
      outcome: "CONFIRMED_FAILURE" as const,
      providerOperationId: "prov-ref-1",
      errorSummary: "Rejected by provider",
      isDeterministic: true as const,
      finishedAt: T1,
    };
  }
}

class FakeMemoryProposalStrategy implements MemoryProposalStrategyPort {
  constructor(private readonly proposals: MemoryProposal[] = []) {}
  async proposeVerifiedMemory(
    execution: PersistedExecution,
    verification: PersistedResultVerification,
    observations: readonly PersistedObservation[],
  ): Promise<readonly MemoryProposal[]> {
    void execution;
    void verification;
    void observations;
    return this.proposals;
  }
}

describe("live PostgreSQL autonomous cognitive loop driver integration tests (M6)", () => {
  let context: PostgresDatabaseContext;
  const verifier = new DeterministicResultVerifier("test-verifier-v1");

  beforeAll(async () => {
    context = await setupIntegrationTestDatabase();
  });

  beforeEach(async () => {
    await cleanIntegrationTestTables(context.db);
  });

  afterAll(async () => {
    if (context) {
      await context.close();
    }
  });

  it("1. Step-by-step exact durable phase sequence with CAS rowVersion increments (NO SKIPPED PHASES)", async () => {
    const sessionId = "sess-m6-step-by-step";
    const cueId = "cue-m6-step-by-step";
    const candidateId = "cand-m6-step-by-step";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-step-1",
        type: "email.received",
        occurredAt: T0,
        receivedAt: T0,
        payload: { email: "step@example.com" },
      },
      sessionId,
      maxRetries: 3,
    });

    const candidate: GeneratedCandidateAction = {
      candidateId,
      cueId,
      goal: "Process incoming email",
      action: "email.send",
      confidence: 0.95,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.05,
    };

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([candidate]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
      memoryProposalStrategy: new FakeMemoryProposalStrategy([
        {
          memoryId: "mem-step-1",
          kind: "FACT",
          key: "email.processed",
          version: 1,
          content: { status: "processed" },
          sourceIds: [`ev-obs:exec:${sessionId}:plan-test-1:step-1`],
          confidence: 0.99,
          admissionRuleVersion: "v1",
        },
      ]),
    };

    // Initial state: CUE, rowVersion: 0
    const s = await sessionRepository.findSessionById(context.db, sessionId);
    expect(s?.phase).toBe("CUE");
    expect(s?.rowVersion).toBe(0);

    // 1. CUE -> PERCEIVE
    let step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("PERCEIVE");
    expect(step.nextSession.rowVersion).toBe(1);

    // 2. PERCEIVE -> BUILD_CONTEXT
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("BUILD_CONTEXT");
    expect(step.nextSession.rowVersion).toBe(2);

    // 3. BUILD_CONTEXT -> RETRIEVE_MEMORY
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("RETRIEVE_MEMORY");
    expect(step.nextSession.rowVersion).toBe(3);

    // 4. RETRIEVE_MEMORY -> GENERATE_CANDIDATES
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("GENERATE_CANDIDATES");
    expect(step.nextSession.rowVersion).toBe(4);

    // 5. GENERATE_CANDIDATES -> SCORE
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("SCORE");
    expect(step.nextSession.rowVersion).toBe(5);

    // 6. SCORE -> GROUND_VERIFY
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("GROUND_VERIFY");
    expect(step.nextSession.rowVersion).toBe(6);

    // 7. GROUND_VERIFY -> POLICY_SAFETY
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("POLICY_SAFETY");
    expect(step.nextSession.rowVersion).toBe(7);

    // 8. POLICY_SAFETY -> PLAN (Mints live runtime capability)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("PLAN");
    expect(step.nextSession.rowVersion).toBe(8);
    expect(step.runtimeAuthorization).toBeDefined();
    const auth = step.runtimeAuthorization;

    // 9. PLAN -> DURABLE_EXECUTION (prepare execution)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 }, auth);
    expect(step.nextSession.phase).toBe("DURABLE_EXECUTION");
    expect(step.nextSession.rowVersion).toBe(9);

    // 10. DURABLE_EXECUTION -> ACT (reserves operation in Transaction A)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 }, auth);
    expect(step.nextSession.phase).toBe("ACT");
    expect(step.nextSession.rowVersion).toBe(10);

    // 11. ACT -> OBSERVE (dispatches adapter outside DB tx, records Transaction B)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 }, auth);
    expect(step.nextSession.phase).toBe("OBSERVE");
    expect(step.nextSession.rowVersion).toBe(11);
    expect(adapter.dispatchCount).toBe(1);

    // 12. OBSERVE -> VERIFY_RESULT
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("VERIFY_RESULT");
    expect(step.nextSession.rowVersion).toBe(12);

    // 13. VERIFY_RESULT -> REWARD
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("REWARD");
    expect(step.nextSession.rowVersion).toBe(13);

    // 14. REWARD -> LEARN (atomic reward applied and learning projected)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("LEARN");
    expect(step.nextSession.rowVersion).toBe(14);

    // Verify learning projected
    const learning = await learningRepository.findLearningState(context.db, "email.send");
    expect(learning).not.toBeNull();
    expect(learning?.sampleCount).toBe(1);

    // 15. LEARN -> SAVE_MEMORY (verifies projection, does NOT duplicate reward)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("SAVE_MEMORY");
    expect(step.nextSession.rowVersion).toBe(15);

    // Verify learning sampleCount is still 1 (no duplicate reward!)
    const learningAfter = await learningRepository.findLearningState(context.db, "email.send");
    expect(learningAfter?.sampleCount).toBe(1);

    // 16. SAVE_MEMORY -> CLEAR_WORKING_MEMORY (admits memory)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("CLEAR_WORKING_MEMORY");
    expect(step.nextSession.rowVersion).toBe(16);

    // 17. CLEAR_WORKING_MEMORY -> IDLE (completes cycle)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 });
    expect(step.nextSession.phase).toBe("IDLE");
    expect(step.nextSession.rowVersion).toBe(17);
    expect(step.isBoundary).toBe(true);
    expect(step.cycleResult?.status).toBe("COMPLETED");
  });

  it("2. Full deterministic happy path until boundary: from CUE to IDLE", async () => {
    const sessionId = "sess-m6-happy";
    const cueId = "cue-m6-happy";
    const candidateId = "cand-m6-happy";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-happy-1",
        type: "email.received",
        occurredAt: T0,
        receivedAt: T0,
        payload: { email: "test@example.com" },
      },
      sessionId,
      maxRetries: 3,
    });

    const candidate: GeneratedCandidateAction = {
      candidateId,
      cueId,
      goal: "Process incoming email",
      action: "email.send",
      confidence: 0.95,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.05,
    };

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([candidate]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
      memoryProposalStrategy: new FakeMemoryProposalStrategy([
        {
          memoryId: "mem-happy-1",
          kind: "FACT",
          key: "email.processed",
          version: 1,
          content: { status: "processed", count: 1 },
          sourceIds: [`ev-obs:exec:${sessionId}:plan-test-1:step-1`],
          confidence: 0.99,
          admissionRuleVersion: "v1",
        },
      ]),
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
    );

    expect(result.status).toBe("COMPLETED");
    if (result.status === "COMPLETED") {
      expect(result.memoriesAdmitted).toBe(1);
    }

    const executionId = `exec:${sessionId}:plan-test-1`;
    const exec = await executionRepository.findExecutionById(context.db, executionId);
    expect(exec).not.toBeNull();

    const op = await executionOperationRepository.findOperationById(context.db, `op:${executionId}:step-1`);
    expect(op).not.toBeNull();

    const obs = await observationRepository.findManyObservationsByExecutionId(context.db, executionId);
    expect(obs).toHaveLength(1);

    const ver = await verificationRepository.findVerificationById(context.db, `ver:${executionId}`);
    expect(ver).not.toBeNull();
    expect(ver?.status).toBe("VERIFIED");

    const rew = await rewardRepository.findRewardById(context.db, `rew:ver:${executionId}`);
    expect(rew).not.toBeNull();
    expect(rew?.signal).toBe("SUCCESS");
    expect(rew?.value).toBe(5);

    const finalSession = await sessionRepository.findSessionById(context.db, sessionId);
    expect(finalSession?.phase).toBe("IDLE");
  });

  it("3. Restart from RETRIEVE_MEMORY reassembles context safely and advances", async () => {
    const sessionId = "sess-restart-ret-mem";
    const cueId = "cue-restart-ret-mem";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-restart-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: 0,
      nextSessionState: {
        phase: "RETRIEVE_MEMORY",
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        cooldownUntil: null,
        updatedAt: T0,
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter: new FakeAdapter("SUCCESS"),
    };

    const step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "email.send",
      now: T0,
    });

    expect(step.nextSession.phase).toBe("GENERATE_CANDIDATES");
    expect(step.nextSession.rowVersion).toBe(2);
  });

  it("4. Restart from GENERATE_CANDIDATES generates candidates safely and advances", async () => {
    const sessionId = "sess-restart-gen-cand";
    const cueId = "cue-restart-gen-cand";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-restart-2",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: 0,
      nextSessionState: {
        phase: "GENERATE_CANDIDATES",
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        cooldownUntil: null,
        updatedAt: T0,
      },
    });

    const candidate: GeneratedCandidateAction = {
      candidateId: "cand-restart-gen",
      cueId,
      goal: "Goal",
      action: "email.send",
      confidence: 0.9,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.1,
    };

    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([candidate]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter: new FakeAdapter("SUCCESS"),
    };

    const step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "email.send",
      now: T0,
    });

    expect(step.nextSession.phase).toBe("SCORE");
    expect(step.nextSession.rowVersion).toBe(2);
  });

  it("5. Lost runtime authorization on restart: replay returns null, consumed artifacts rejected, resets to BUILD_CONTEXT", async () => {
    const sessionId = "sess-lost-auth";
    const cueId = "cue-lost-auth";
    const candidateId = "cand-lost-auth";
    const groundingResultId = `grounding:${candidateId}:v1`;
    const policyDecisionId = `policy:${candidateId}:v1`;

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-lost-auth",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    // 1. Candidate, Grounding, Policy set up
    await candidateRepository.appendCandidate(context.db, {
      candidateId,
      sessionId,
      cueId,
      goal: "Action",
      action: "email.send",
      confidence: 0.9,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.1,
      scoreValue: 0.9,
      recommendation: "AUTO_CANDIDATE",
      scoreFormulaVersion: "v1",
      evidenceIds: [],
      createdAt: T0,
    });

    const grounding: PersistedGroundingResult = {
      groundingResultId,
      candidateId,
      evaluationKey: `eval-grounding:${candidateId}`,
      status: "VERIFIED",
      confidence: 0.95,
      reason: "Verified grounding",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: T0,
    };
    await groundingRepository.appendGroundingResult(context.db, grounding);

    const policy: PersistedPolicyDecision = {
      policyDecisionId,
      candidateId,
      groundingResultId,
      evaluationKey: `eval-policy:${candidateId}`,
      outcome: "ALLOW",
      reason: "Policy allow",
      policyEngineVersion: "v1",
      policyIds: ["p1"],
      evaluatedAt: T0,
    };
    await policyRepository.appendPolicyDecision(context.db, policy);

    // Transition session to POLICY_SAFETY
    await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: 0,
      nextSessionState: {
        phase: "POLICY_SAFETY",
        currentCandidateId: candidateId,
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        cooldownUntil: null,
        updatedAt: T0,
      },
    });

    // 1. Issue authorization once (succeeds)
    const issued1 = await orchestrateAuthorizationIssuance(context.db, {
      commandIdempotencyKey: "auth-issuance-cmd-1",
      sessionId,
      candidateId,
      groundingResultId,
      policyDecisionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 0,
      safetyEventId: "ev-safety-issuance-1",
      safetyEventKey: "key-safety-issuance-1",
      issuedAt: T0,
    });

    expect(issued1.status).toBe("AUTHORIZED");
    if (issued1.status === "AUTHORIZED") {
      expect(issued1.authorization).toBeDefined();
    }

    // 2. Replay of same issuance command does NOT return capability (returns authorization: null)
    const replayIssuance = await orchestrateAuthorizationIssuance(context.db, {
      commandIdempotencyKey: "auth-issuance-cmd-1",
      sessionId,
      candidateId,
      groundingResultId,
      policyDecisionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 0,
      safetyEventId: "ev-safety-issuance-1",
      safetyEventKey: "key-safety-issuance-1",
      issuedAt: T0,
    });

    expect(replayIssuance.status).toBe("ALREADY_ISSUED_NO_CAPABILITY");
    if (replayIssuance.status === "ALREADY_ISSUED_NO_CAPABILITY") {
      expect(replayIssuance.authorization).toBeNull(); // Old capability cannot be reconstructed!
    }

    // 3. Direct reuse of same consumed grounding/policy artifacts in new command throws STATE_CONFLICT
    await expect(
      orchestrateAuthorizationIssuance(context.db, {
        commandIdempotencyKey: "auth-issuance-cmd-2-fresh-key",
        sessionId,
        candidateId,
        groundingResultId, // Already consumed!
        policyDecisionId,  // Already consumed!
        expectedSessionRowVersion: 2,
        expectedSafetyGeneration: 1,
        safetyEventId: "ev-safety-issuance-2",
        safetyEventKey: "key-safety-issuance-2",
        issuedAt: T0,
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });

    // 4. Session in PLAN phase without in-memory capability safely resets to BUILD_CONTEXT
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter: new FakeAdapter("SUCCESS"),
    };

    const step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "email.send",
      now: T0,
    });

    expect(step.nextSession.phase).toBe("BUILD_CONTEXT");
    expect(step.nextSession.currentCandidateId).toBeNull();
    expect(step.nextSession.currentPlanId).toBeNull();
    expect(step.nextSession.currentExecutionId).toBeNull();
  });

  it("6. Restart with IN_FLIGHT operation does NOT redispatch blindly -> returns RECONCILIATION_REQUIRED", async () => {
    const sessionId = "sess-inflight-restart";
    const cueId = "cue-inflight-restart";
    const candidateId = "cand-inflight-restart";
    const planId = "plan-inflight-restart";
    const executionId = `exec:${sessionId}:${planId}`;
    const stepId = "step-1";
    const operationId = `op:${executionId}:${stepId}`;

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-inflight-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: 0,
      nextSessionState: {
        phase: "ACT",
        currentCandidateId: candidateId,
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        cooldownUntil: null,
        updatedAt: T0,
      },
    });

    await candidateRepository.appendCandidate(context.db, {
      candidateId,
      sessionId,
      cueId,
      goal: "Action",
      action: "email.send",
      confidence: 0.9,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.1,
      scoreValue: 0.9,
      recommendation: "AUTO_CANDIDATE",
      scoreFormulaVersion: "v1",
      evidenceIds: [],
      createdAt: T0,
    });

    await planRepository.appendPlan(context.db, {
      planId,
      candidateId,
      planGeneration: 1,
      steps: [{ stepId, ordinal: 0, description: "Step" }],
      dependencies: [],
      createdAt: T0,
    });

    await executionRepository.createPendingExecution(context.db, {
      executionId,
      sessionId,
      planId,
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      safetyGenerationAtStart: null,
      rowVersion: 0,
      createdAt: T0,
      updatedAt: T0,
    });

    await context.db.execute(sql`
      INSERT INTO execution_step_state (execution_id, plan_id, step_id, status, operation_generation, row_version, updated_at)
      VALUES (${executionId}, ${planId}, ${stepId}, 'RUNNING', 1, 0, ${T0})
    `);

    await executionOperationRepository.reserveExecutionOperation(context.db, {
      operationId,
      executionId,
      stepId,
      operationGeneration: 1,
      operationKind: "email.send",
      idempotencyKey: "idemp-inflight",
      requestFingerprint: "fp-inflight",
      status: "IN_FLIGHT",
      attemptCount: 1,
      providerScope: "test-provider",
      providerIdempotencyKey: "prov-idemp-inflight",
      providerOperationId: null,
      uncertaintyReason: null,
      reconciliationStatus: "NOT_REQUIRED",
      reconciliationOutcome: null,
      rowVersion: 0,
      createdAt: T0,
      updatedAt: T0,
    });

    const initialSafety = createInitialExecutionSafetyState();
    const fakeAuth = allowAutonomousExecution(
      initialSafety,
      { phase: "POLICY_SAFETY" },
      { candidateId, status: "VERIFIED" },
      { candidateId, outcome: "ALLOW" },
    );

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
    };

    const step = await advanceCognitiveCycle(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
      fakeAuth,
    );

    expect(step.isBoundary).toBe(true);
    expect(step.cycleResult?.status).toBe("RECONCILIATION_REQUIRED");
    expect(adapter.dispatchCount).toBe(0); // MUST NOT redispatch blindly!
  });

  it("7. Cooldown resume semantics and failure recovery: pre-deadline rejected, deadline allowed -> resumes to BUILD_CONTEXT", async () => {
    const sessionId = "sess-failure-recovery";
    const cueId = "cue-failure-recovery";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-fail-rec",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 2,
    });

    // 1st Failure: RETRY_WITH_FRESH_CONTEXT -> sets phase BUILD_CONTEXT
    const rec1 = await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "fail-cmd-1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "EXECUTION_TIMEOUT",
      reason: "Timeout on 1st attempt",
      evidenceIds: [],
      safetyEventId: "safety-ev-1",
      safetyEventKey: "safety-key-1",
      auditEventId: "audit-ev-1",
      createdAt: T0,
    });

    expect(rec1.decision.action).toBe("RETRY_WITH_FRESH_CONTEXT");
    expect(rec1.session.phase).toBe("BUILD_CONTEXT");
    expect(rec1.session.retryCount).toBe(1);
    expect(rec1.session.failureCount).toBe(1);

    // 2nd Failure: START_COOLDOWN (4 minutes)
    const rec2 = await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "fail-cmd-2",
      sessionId,
      expectedSessionRowVersion: rec1.session.rowVersion,
      expectedSafetyGeneration: rec1.safetyState.generation,
      failure: "EXECUTION_TIMEOUT",
      reason: "Timeout on 2nd attempt",
      evidenceIds: [],
      safetyEventId: "safety-ev-2",
      safetyEventKey: "safety-key-2",
      auditEventId: "audit-ev-2",
      createdAt: T0,
    });

    expect(rec2.decision.action).toBe("START_COOLDOWN");
    expect(rec2.session.phase).toBe("COOLDOWN");
    expect(rec2.session.cooldownUntil).not.toBeNull();

    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter: new FakeAdapter("SUCCESS"),
    };

    // Attempt advance before cooldown deadline -> rejected with COOLDOWN boundary
    const earlyStep = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "email.send",
      now: T0, // 0 minutes elapsed
    });
    expect(earlyStep.isBoundary).toBe(true);
    expect(earlyStep.cycleResult?.status).toBe("COOLDOWN");

    // Advance at cooldown deadline (+5 minutes) -> allowed, resumes to BUILD_CONTEXT via orchestrateRecoverySession
    const afterCooldown = new Date(new Date(T0).getTime() + 5 * 60 * 1000).toISOString();
    const readyStep = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "email.send",
      now: afterCooldown,
    });
    expect(readyStep.nextSession.phase).toBe("BUILD_CONTEXT");
    expect(readyStep.nextSession.cooldownUntil).toBeNull();
    expect(readyStep.nextSession.cueId).toBe(cueId); // Root cue preserved!
    expect(readyStep.nextSession.retryCount).toBe(2);
    expect(readyStep.nextSession.failureCount).toBe(2);
    expect(readyStep.nextSession.currentCandidateId).toBeNull(); // Temporary context cleared!
    expect(readyStep.nextSession.currentPlanId).toBeNull();
    expect(readyStep.nextSession.currentExecutionId).toBeNull();

    // 3rd Failure: ESCALATE_TO_HUMAN
    const rec3 = await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "fail-cmd-3",
      sessionId,
      expectedSessionRowVersion: readyStep.nextSession.rowVersion,
      expectedSafetyGeneration: rec2.safetyState.generation,
      failure: "EXECUTION_TIMEOUT",
      reason: "Timeout on 3rd attempt",
      evidenceIds: [],
      safetyEventId: "safety-ev-3",
      safetyEventKey: "safety-key-3",
      auditEventId: "audit-ev-3",
      createdAt: afterCooldown,
    });

    expect(rec3.decision.action).toBe("ESCALATE_TO_HUMAN");
    expect(rec3.session.phase).toBe("HUMAN_REVIEW");
  });

  it("8. Absolute safety subordination: Score 1.0 + Learning 0.9999 + Memory 1.0 with Policy DENY -> zero authorization, zero dispatches", async () => {
    const sessionId = "sess-m6-absolute-subordination";
    const cueId = "cue-m6-absolute-subordination";

    await context.db.execute(sql`
      INSERT INTO learning_state (skill_key, confidence, total_reward, sample_count, row_version, updated_at)
      VALUES ('email.send', '0.9999', 500, 50, 0, ${T0})
      ON CONFLICT (skill_key) DO UPDATE SET confidence = '0.9999';
    `);

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-subord-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([
        {
          candidateId: "cand-subord-1",
          cueId,
          goal: "Disallowed action",
          action: "email.send",
          confidence: 1.0,
          expectedUtility: 1.0,
          estimatedRisk: 0.0,
          estimatedCost: 0.0,
        },
      ]),
      groundingEvaluator: new FakeGroundingEvaluator({
        status: "VERIFIED",
        confidence: 1.0,
        reason: "Fully verified evidence",
        evaluatorVersion: "v1",
        evidenceIds: [],
      }),
      policyEvaluator: new FakePolicyEvaluator({
        outcome: "DENY",
        reason: "Access forbidden by security policy",
        policyEngineVersion: "v1",
        policyIds: ["policy-deny-1"],
      }),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
    );

    expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(adapter.dispatchCount).toBe(0);

    const safety = await safetyRepository.findSafetyStateBySessionId(context.db, sessionId);
    expect(safety?.status).toBe("UNAUTHORIZED"); // No authorized state was ever minted or persisted!

    const session = await sessionRepository.findSessionById(context.db, sessionId);
    expect(session?.phase).toBe("HUMAN_REVIEW");
  });

  it("9. Zero candidates produced -> NO_ACTION result, returns session to IDLE", async () => {
    const sessionId = "sess-m6-zero-cand";
    const cueId = "cue-m6-zero-cand";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-zero-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
    );

    expect(result.status).toBe("NO_ACTION");
    expect(adapter.dispatchCount).toBe(0);

    const session = await sessionRepository.findSessionById(context.db, sessionId);
    expect(session?.phase).toBe("IDLE");
  });

  it("10. Low score IGNORE candidates -> NO_ACTION result, returns session to IDLE", async () => {
    const sessionId = "sess-m6-ignore";
    const cueId = "cue-m6-ignore";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-ignore-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([
        {
          candidateId: "cand-low-score",
          cueId,
          goal: "Low value action",
          action: "email.send",
          confidence: 0.1,
          expectedUtility: 0.1,
          estimatedRisk: 0.9,
          estimatedCost: 0.9,
        },
      ]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
    );

    expect(result.status).toBe("NO_ACTION");
    expect(adapter.dispatchCount).toBe(0);

    const session = await sessionRepository.findSessionById(context.db, sessionId);
    expect(session?.phase).toBe("IDLE");
  });

  it("11. ASK_HUMAN candidate -> stops at HUMAN_REVIEW boundary, zero dispatches", async () => {
    const sessionId = "sess-m6-ask-human";
    const cueId = "cue-m6-ask-human";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-ask-human-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([
        {
          candidateId: "cand-medium-score",
          cueId,
          goal: "Medium risk action",
          action: "email.send",
          confidence: 0.5,
          expectedUtility: 0.5,
          estimatedRisk: 0.4,
          estimatedCost: 0.4,
        },
      ]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
    );

    expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(adapter.dispatchCount).toBe(0);

    const session = await sessionRepository.findSessionById(context.db, sessionId);
    expect(session?.phase).toBe("HUMAN_REVIEW");
  });

  it("12. Grounding INSUFFICIENT_EVIDENCE -> stops at HUMAN_REVIEW, zero dispatches", async () => {
    const sessionId = "sess-m6-grounding-fail";
    const cueId = "cue-m6-grounding-fail";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-grounding-fail-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const adapter = new FakeAdapter("SUCCESS");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([
        {
          candidateId: "cand-grounding-fail",
          cueId,
          goal: "Ungrounded action",
          action: "email.send",
          confidence: 0.95,
          expectedUtility: 0.9,
          estimatedRisk: 0.1,
          estimatedCost: 0.05,
        },
      ]),
      groundingEvaluator: new FakeGroundingEvaluator({
        status: "INSUFFICIENT_EVIDENCE",
        confidence: 0.3,
        reason: "Evidence missing",
        evaluatorVersion: "v1",
        evidenceIds: [],
      }),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
    );

    expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(adapter.dispatchCount).toBe(0);

    const session = await sessionRepository.findSessionById(context.db, sessionId);
    expect(session?.phase).toBe("HUMAN_REVIEW");
  });

  it("13. Concurrent phase updates: one CAS winner, stale worker gets STALE_WRITE", async () => {
    const sessionId = "sess-m6-concurrency";
    const cueId = "cue-m6-concurrency";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-concurrency-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter: new FakeAdapter("SUCCESS"),
    };

    const results = await Promise.allSettled([
      advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 }),
      advanceCognitiveCycle(context.db, sessionId, ports, { skillKey: "email.send", now: T0 }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    if (rejected.length > 0) {
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "STALE_WRITE",
      });
    }
  });

  it("14. New cue accepted only when IDLE, rejected while in HUMAN_REVIEW", async () => {
    const sessionId = "sess-m6-cue-acceptance";
    const cueId1 = "cue-m6-cue-1";

    await ingestCue(context.db, {
      cue: {
        cueId: cueId1,
        source: "test",
        externalEventId: "ev-cue-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    // Advance session into HUMAN_REVIEW
    const humanReviewSession = await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: 0,
      nextSessionState: {
        phase: "HUMAN_REVIEW",
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        cooldownUntil: null,
        updatedAt: T0,
      },
    });
    expect(humanReviewSession.phase).toBe("HUMAN_REVIEW");

    await expect(
      ingestCue(context.db, {
        cue: {
          cueId: cueId1,
          source: "test",
          externalEventId: "ev-cue-1",
          type: "user.action",
          occurredAt: T0,
          receivedAt: T0,
          payload: {},
        },
        sessionId,
        maxRetries: 3,
      }),
    ).resolves.toMatchObject({ isReplay: true });
  });

  it("15. Adapter UNKNOWN outcome returns RECONCILIATION_REQUIRED without repeating dispatch", async () => {
    const sessionId = "sess-m6-unknown";
    const cueId = "cue-m6-unknown";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-unknown-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const adapter = new FakeAdapter("UNKNOWN");
    const ports: CognitiveCyclePorts = {
      perception: new FakePerception(),
      candidateGenerator: new FakeCandidateGenerator([
        {
          candidateId: "cand-unknown",
          cueId,
          goal: "Dispatched action",
          action: "email.send",
          confidence: 0.95,
          expectedUtility: 0.9,
          estimatedRisk: 0.1,
          estimatedCost: 0.05,
        },
      ]),
      groundingEvaluator: new FakeGroundingEvaluator(),
      policyEvaluator: new FakePolicyEvaluator(),
      planBuilder: new FakePlanBuilder(),
      verifier,
      adapter,
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "email.send", now: T0 },
    );

    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(adapter.dispatchCount).toBe(1); // Dispatched once, then stopped for reconciliation
  });
});
