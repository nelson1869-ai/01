import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedEvidence } from "../../contracts/persisted-evidence";
import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import type { PersistedActionPlan } from "../../contracts/persisted-action-plan";
import type { PersistedObservation } from "../../contracts/persisted-observation";
import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";
import type { PersistedResultVerification } from "../../contracts/result-verification";
import type { PersistedRewardEvent } from "../../contracts/reward-event";
import type { PersistedVerifiedMemory } from "../../contracts/verified-memory";
import type { PostgresDatabaseContext } from "../client";
import { PersistenceError } from "../errors/persistence-errors";
import { candidateRepository } from "../repositories/candidate-repository";
import { evidenceRepository } from "../repositories/evidence-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { memoryRepository } from "../repositories/memory-repository";
import { observationRepository } from "../repositories/observation-repository";
import { planRepository } from "../repositories/plan-repository";
import { policyRepository } from "../repositories/policy-repository";
import { rewardRepository } from "../repositories/reward-repository";
import { verificationRepository } from "../repositories/verification-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";

describe("live PostgreSQL cognitive ledger repositories integration tests", () => {
  let context: PostgresDatabaseContext;

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

  async function seedSessionAndCue(
    sessionId = "session-test-1",
    cueId = "cue-test-1",
  ) {
    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "github",
        externalEventId: `evt-${cueId}`,
        type: "github.issue.created",
        occurredAt: "2026-08-30T00:00:00.000Z",
        receivedAt: "2026-08-30T00:00:01.000Z",
        payload: { title: "Fix bug" },
      },
      sessionId,
    });
  }

  async function seedPlanAndExecution(
    sessionId: string,
    cueId: string,
    candidateId: string,
    planId: string,
    executionId: string,
  ) {
    await seedSessionAndCue(sessionId, cueId);

    await context.db.execute(sql`
      INSERT INTO candidate_actions (
        candidate_id, session_id, cue_id, goal, action, confidence, expected_utility,
        estimated_risk, estimated_cost, score_value, recommendation, score_formula_version, created_at
      ) VALUES (
        ${candidateId}, ${sessionId}, ${cueId}, 'Goal', 'Action', '0.9000', '0.9000',
        '0.1000', '0.1000', '0.8000', 'PROCEED', 'v1', NOW()
      )
    `);

    await context.db.execute(sql`
      INSERT INTO action_plans (plan_id, candidate_id, plan_generation, created_at)
      VALUES (${planId}, ${candidateId}, 1, NOW())
    `);

    await context.db.execute(sql`
      INSERT INTO action_plan_steps (plan_id, step_id, ordinal, description)
      VALUES (${planId}, 'step-1', 0, 'Initial step')
    `);

    await context.db.execute(sql`
      INSERT INTO executions (execution_id, session_id, plan_id, status, started_at, safety_generation_at_start, row_version, created_at, updated_at)
      VALUES (${executionId}, ${sessionId}, ${planId}, 'RUNNING', NOW(), 0, 0, NOW(), NOW())
    `);
  }

  it("1. EvidenceRepository: appends immutable evidence, replays on identical, rejects conflicting claim", async () => {
    const evidence: PersistedEvidence = {
      evidenceId: "ev-1",
      source: "git",
      sourceId: "commit-12345",
      claim: "Repo is clean",
      observedAt: "2026-08-30T00:00:00.000Z",
      createdAt: "2026-08-30T00:00:01.000Z",
      providerMetadata: { commit: "12345" },
    };

    const first = await evidenceRepository.appendEvidence(context.db, evidence);
    expect(first.isReplay).toBe(false);
    expect(first.evidence.evidenceId).toBe("ev-1");

    // Identical append -> replay
    const second = await evidenceRepository.appendEvidence(
      context.db,
      evidence,
    );
    expect(second.isReplay).toBe(true);

    // Conflicting claim -> IDEMPOTENCY_CONFLICT
    const conflicting: PersistedEvidence = {
      ...evidence,
      claim: "Different conflicting claim",
    };

    await expect(
      evidenceRepository.appendEvidence(context.db, conflicting),
    ).rejects.toThrow(PersistenceError);
  });

  it("2. CandidateRepository: atomically persists candidate action and evidence associations", async () => {
    await seedSessionAndCue("session-cand-1", "cue-cand-1");

    const ev: PersistedEvidence = {
      evidenceId: "ev-cand-1",
      source: "docs",
      sourceId: "doc-1",
      claim: "Documentation exists",
      observedAt: "2026-08-30T00:00:00.000Z",
      createdAt: "2026-08-30T00:00:01.000Z",
      providerMetadata: null,
    };
    await evidenceRepository.appendEvidence(context.db, ev);

    const candidate: PersistedCandidateAction = {
      candidateId: "cand-1",
      sessionId: "session-cand-1",
      cueId: "cue-cand-1",
      goal: "Update docs",
      action: "Write markdown file",
      confidence: 0.95,
      expectedUtility: 0.9,
      estimatedRisk: 0.05,
      estimatedCost: 0.02,
      scoreValue: 0.88,
      recommendation: "PROCEED",
      scoreFormulaVersion: "score-v1",
      evidenceIds: ["ev-cand-1"],
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const result = await candidateRepository.appendCandidate(
      context.db,
      candidate,
    );
    expect(result.isReplay).toBe(false);
    expect(result.candidate.candidateId).toBe("cand-1");
    expect(result.candidate.evidenceIds).toEqual(["ev-cand-1"]);

    const fetched = await candidateRepository.findCandidateById(
      context.db,
      "cand-1",
    );
    expect(fetched).not.toBeNull();
    expect(fetched?.evidenceIds).toEqual(["ev-cand-1"]);
    expect(fetched?.confidence).toBe(0.95);
  });

  it("3. GroundingRepository: persists grounding and evidence atomically, checks candidate uniqueness", async () => {
    await seedSessionAndCue("session-ground-1", "cue-ground-1");

    const ev: PersistedEvidence = {
      evidenceId: "ev-ground-1",
      source: "logs",
      sourceId: "log-1",
      claim: "Log verified",
      observedAt: "2026-08-30T00:00:00.000Z",
      createdAt: "2026-08-30T00:00:01.000Z",
      providerMetadata: null,
    };
    await evidenceRepository.appendEvidence(context.db, ev);

    const candidate: PersistedCandidateAction = {
      candidateId: "cand-ground-1",
      sessionId: "session-ground-1",
      cueId: "cue-ground-1",
      goal: "Run test",
      action: "vitest run",
      confidence: 0.9,
      expectedUtility: 0.85,
      estimatedRisk: 0.1,
      estimatedCost: 0.05,
      scoreValue: 0.8,
      recommendation: "PROCEED",
      scoreFormulaVersion: "score-v1",
      evidenceIds: ["ev-ground-1"],
      createdAt: "2026-08-30T00:01:00.000Z",
    };
    await candidateRepository.appendCandidate(context.db, candidate);

    const grounding: PersistedGroundingResult = {
      groundingResultId: "ground-1",
      candidateId: "cand-ground-1",
      evaluationKey: "ground:cand-ground-1:eval-1",
      status: "VERIFIED",
      confidence: 0.98,
      reason: "Grounded by log-1",
      evaluatorVersion: "v1",
      evidenceIds: ["ev-ground-1"],
      evaluatedAt: "2026-08-30T00:02:00.000Z",
    };

    const result = await groundingRepository.appendGroundingResult(
      context.db,
      grounding,
    );
    expect(result.isReplay).toBe(false);
    expect(result.grounding.evidenceIds).toEqual(["ev-ground-1"]);

    const fetched =
      await groundingRepository.findGroundingResultByCandidateAndKey(
        context.db,
        "cand-ground-1",
        "ground:cand-ground-1:eval-1",
      );
    expect(fetched?.groundingResultId).toBe("ground-1");
  });

  it("4. PolicyRepository: persists policy decision with policy refs atomically", async () => {
    await seedSessionAndCue("session-pol-1", "cue-pol-1");

    const candidate: PersistedCandidateAction = {
      candidateId: "cand-pol-1",
      sessionId: "session-pol-1",
      cueId: "cue-pol-1",
      goal: "Run test",
      action: "npm test",
      confidence: 0.9,
      expectedUtility: 0.85,
      estimatedRisk: 0.1,
      estimatedCost: 0.05,
      scoreValue: 0.8,
      recommendation: "PROCEED",
      scoreFormulaVersion: "score-v1",
      evidenceIds: [],
      createdAt: "2026-08-30T00:01:00.000Z",
    };
    await candidateRepository.appendCandidate(context.db, candidate);

    const grounding: PersistedGroundingResult = {
      groundingResultId: "ground-pol-1",
      candidateId: "cand-pol-1",
      evaluationKey: "ground:cand-pol-1:1",
      status: "VERIFIED",
      confidence: 0.95,
      reason: "Grounded",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: "2026-08-30T00:02:00.000Z",
    };
    await groundingRepository.appendGroundingResult(context.db, grounding);

    const policy: PersistedPolicyDecision = {
      policyDecisionId: "pol-dec-1",
      candidateId: "cand-pol-1",
      groundingResultId: "ground-pol-1",
      evaluationKey: "pol:cand-pol-1:1",
      outcome: "ALLOW",
      reason: "Allowed by security rule",
      policyEngineVersion: "v1",
      policyIds: ["sec-rule-read", "sec-rule-exec"],
      evaluatedAt: "2026-08-30T00:03:00.000Z",
    };

    const result = await policyRepository.appendPolicyDecision(
      context.db,
      policy,
    );
    expect(result.isReplay).toBe(false);
    expect(result.decision.policyIds.length).toBe(2);

    const fetched = await policyRepository.findPolicyDecisionById(
      context.db,
      "pol-dec-1",
    );
    expect(fetched?.policyIds).toContain("sec-rule-read");
    expect(fetched?.policyIds).toContain("sec-rule-exec");
  });

  it("5. PlanRepository: persists plan, steps, and dependencies atomically in single transaction", async () => {
    await seedSessionAndCue("session-plan-1", "cue-plan-1");

    const candidate: PersistedCandidateAction = {
      candidateId: "cand-plan-1",
      sessionId: "session-plan-1",
      cueId: "cue-plan-1",
      goal: "Deploy build",
      action: "Execute plan",
      confidence: 0.9,
      expectedUtility: 0.85,
      estimatedRisk: 0.1,
      estimatedCost: 0.05,
      scoreValue: 0.8,
      recommendation: "PROCEED",
      scoreFormulaVersion: "score-v1",
      evidenceIds: [],
      createdAt: "2026-08-30T00:01:00.000Z",
    };
    await candidateRepository.appendCandidate(context.db, candidate);

    const plan: PersistedActionPlan = {
      planId: "plan-1",
      candidateId: "cand-plan-1",
      planGeneration: 1,
      steps: [
        { stepId: "step-build", ordinal: 0, description: "Run build" },
        { stepId: "step-test", ordinal: 1, description: "Run test" },
        { stepId: "step-deploy", ordinal: 2, description: "Run deploy" },
      ],
      dependencies: [
        { stepId: "step-test", dependsOnStepId: "step-build" },
        { stepId: "step-deploy", dependsOnStepId: "step-test" },
      ],
      createdAt: "2026-08-30T00:02:00.000Z",
    };

    const result = await planRepository.appendPlan(context.db, plan);
    expect(result.isReplay).toBe(false);
    expect(result.plan.steps.length).toBe(3);
    expect(result.plan.dependencies.length).toBe(2);

    const fetched = await planRepository.findPlanById(context.db, "plan-1");
    expect(fetched?.steps.map((s) => s.stepId)).toEqual([
      "step-build",
      "step-test",
      "step-deploy",
    ]);
    expect(fetched?.dependencies.length).toBe(2);
  });

  it("6. ObservationRepository: saves observation and deduplicates by sourceEventId", async () => {
    await seedPlanAndExecution(
      "session-obs-1",
      "cue-obs-1",
      "cand-obs-1",
      "plan-obs-1",
      "exec-obs-1",
    );

    const obs: PersistedObservation = {
      observationId: "obs-1",
      executionId: "exec-obs-1",
      stepId: null,
      source: "stdout",
      sourceEventId: "chunk-101",
      summary: "Service started on port 3000",
      data: { port: 3000 },
      observedAt: "2026-08-30T00:05:00.000Z",
      payloadExpiresAt: null,
    };

    const first = await observationRepository.appendObservation(
      context.db,
      obs,
    );
    expect(first.isReplay).toBe(false);

    // Replay
    const second = await observationRepository.appendObservation(
      context.db,
      obs,
    );
    expect(second.isReplay).toBe(true);

    const found = await observationRepository.findObservationBySourceEvent(
      context.db,
      "exec-obs-1",
      "stdout",
      "chunk-101",
    );
    expect(found?.observationId).toBe("obs-1");
  });

  it("7. VerificationRepository: saves verification and observation links atomically", async () => {
    await seedPlanAndExecution(
      "session-ver-1",
      "cue-ver-1",
      "cand-ver-1",
      "plan-ver-1",
      "exec-ver-1",
    );

    const obs: PersistedObservation = {
      observationId: "obs-ver-1",
      executionId: "exec-ver-1",
      stepId: null,
      source: "stdout",
      sourceEventId: "event-1",
      summary: "Done",
      data: { success: true },
      observedAt: "2026-08-30T00:01:00.000Z",
      payloadExpiresAt: null,
    };
    await observationRepository.appendObservation(context.db, obs);

    const verification: PersistedResultVerification = {
      verificationId: "ver-1",
      executionId: "exec-ver-1",
      verificationGeneration: 1,
      observationSetDigest: "sha256:obs-ver-1",
      verifierVersion: "v1",
      status: "VERIFIED",
      confidence: 0.99,
      reason: "Confirmed output",
      verifiedAt: "2026-08-30T00:02:00.000Z",
    };

    const result = await verificationRepository.appendVerification(
      context.db,
      verification,
      ["obs-ver-1"],
    );
    expect(result.isReplay).toBe(false);
    expect(result.verification.status).toBe("VERIFIED");

    const obsIds =
      await verificationRepository.findObservationIdsForVerification(
        context.db,
        "ver-1",
      );
    expect(obsIds).toEqual(["obs-ver-1"]);
  });

  it("8. RewardRepository: enforces idempotency barrier on (verificationId, rewardRuleId)", async () => {
    await seedPlanAndExecution(
      "session-rew-1",
      "cue-rew-1",
      "cand-rew-1",
      "plan-rew-1",
      "exec-rew-1",
    );

    const verification: PersistedResultVerification = {
      verificationId: "ver-rew-1",
      executionId: "exec-rew-1",
      verificationGeneration: 1,
      observationSetDigest: "sha256:digest",
      verifierVersion: "v1",
      status: "VERIFIED",
      confidence: 0.95,
      reason: "Good",
      verifiedAt: "2026-08-30T00:02:00.000Z",
    };
    await verificationRepository.appendVerification(context.db, verification);

    const reward: PersistedRewardEvent = {
      rewardEventId: "rew-1",
      executionId: "exec-rew-1",
      verificationId: "ver-rew-1",
      rewardRuleId: "rule-correctness-v1",
      rewardIdempotencyKey: "rew:ver-rew-1:rule-1",
      signal: "SUCCESS",
      value: 10,
      reason: "Execution verified correct",
      createdAt: "2026-08-30T00:03:00.000Z",
    };

    const first = await rewardRepository.appendReward(context.db, reward);
    expect(first.isReplay).toBe(false);

    const second = await rewardRepository.appendReward(context.db, reward);
    expect(second.isReplay).toBe(true);

    const conflicting: PersistedRewardEvent = {
      ...reward,
      value: 5,
    };
    await expect(
      rewardRepository.appendReward(context.db, conflicting),
    ).rejects.toThrow(PersistenceError);
  });

  it("9. MemoryRepository: saves memory version, source links, and advances head optimistically", async () => {
    const ev: PersistedEvidence = {
      evidenceId: "ev-mem-1",
      source: "human",
      sourceId: "user-1",
      claim: "User requested dark mode",
      observedAt: "2026-08-30T00:00:00.000Z",
      createdAt: "2026-08-30T00:00:01.000Z",
      providerMetadata: null,
    };
    await evidenceRepository.appendEvidence(context.db, ev);

    const memV1: PersistedVerifiedMemory = {
      memoryId: "mem-v1",
      kind: "FACT",
      key: "theme:mode",
      version: 1,
      content: { mode: "dark" },
      sourceIds: ["ev-mem-1"],
      confidence: 0.99,
      admissionRuleVersion: "v1",
      supersedesMemoryId: null,
      verifiedAt: "2026-08-30T00:01:00.000Z",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const res1 = await memoryRepository.appendVerifiedMemoryVersion(
      context.db,
      memV1,
    );
    expect(res1.isReplay).toBe(false);
    expect(res1.headRowVersion).toBe(0);

    const head1 = await memoryRepository.findMemoryHead(
      context.db,
      "FACT",
      "theme:mode",
    );
    expect(head1?.memoryId).toBe("mem-v1");
    expect(head1?.memoryVersion).toBe(1);
    expect(head1?.rowVersion).toBe(0);

    // Advance to V2 with CAS expectedHeadRowVersion = 0
    const memV2: PersistedVerifiedMemory = {
      memoryId: "mem-v2",
      kind: "FACT",
      key: "theme:mode",
      version: 2,
      content: { mode: "system" },
      sourceIds: ["ev-mem-1"],
      confidence: 0.99,
      admissionRuleVersion: "v1",
      supersedesMemoryId: "mem-v1",
      verifiedAt: "2026-08-30T00:02:00.000Z",
      createdAt: "2026-08-30T00:02:00.000Z",
    };

    const res2 = await memoryRepository.appendVerifiedMemoryVersion(
      context.db,
      memV2,
      { expectedHeadRowVersion: 0 },
    );
    expect(res2.isReplay).toBe(false);
    expect(res2.headRowVersion).toBe(1);

    const head2 = await memoryRepository.findMemoryHead(
      context.db,
      "FACT",
      "theme:mode",
    );
    expect(head2?.memoryId).toBe("mem-v2");
    expect(head2?.memoryVersion).toBe(2);
    expect(head2?.rowVersion).toBe(1);
  });

  it("10. MemoryRepository: rejects stale head row version CAS advance", async () => {
    const ev: PersistedEvidence = {
      evidenceId: "ev-mem-stale",
      source: "human",
      sourceId: "user-1",
      claim: "Facts",
      observedAt: "2026-08-30T00:00:00.000Z",
      createdAt: "2026-08-30T00:00:01.000Z",
      providerMetadata: null,
    };
    await evidenceRepository.appendEvidence(context.db, ev);

    const memV1: PersistedVerifiedMemory = {
      memoryId: "mem-stale-v1",
      kind: "FACT",
      key: "config:timeout",
      version: 1,
      content: { timeoutMs: 5000 },
      sourceIds: ["ev-mem-stale"],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      supersedesMemoryId: null,
      verifiedAt: "2026-08-30T00:01:00.000Z",
      createdAt: "2026-08-30T00:01:00.000Z",
    };
    await memoryRepository.appendVerifiedMemoryVersion(context.db, memV1);

    const memV2: PersistedVerifiedMemory = {
      memoryId: "mem-stale-v2",
      kind: "FACT",
      key: "config:timeout",
      version: 2,
      content: { timeoutMs: 10000 },
      sourceIds: ["ev-mem-stale"],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      supersedesMemoryId: "mem-stale-v1",
      verifiedAt: "2026-08-30T00:02:00.000Z",
      createdAt: "2026-08-30T00:02:00.000Z",
    };

    // Passing stale expectedHeadRowVersion = 99 -> should throw STALE_WRITE
    await expect(
      memoryRepository.appendVerifiedMemoryVersion(context.db, memV2, {
        expectedHeadRowVersion: 99,
      }),
    ).rejects.toThrow(PersistenceError);
  });
});
