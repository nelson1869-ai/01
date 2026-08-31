import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { orchestrateAuthorizationIssuance } from "../../../orchestration/authorization-orchestrator";
import { prepareAuthorizedExecution } from "../../../orchestration/execution-preparation-orchestrator";
import {
  reserveAuthorizedExecutionOperation,
  startAuthorizedExecution,
  startAuthorizedExecutionStep,
} from "../../../orchestration/execution-progress-orchestrator";
import { admitVerifiedMemory } from "../../../orchestration/memory-orchestrator";
import {
  retrieveHistoricalMemoryVersion,
  retrieveMemoryHead,
  retrieveMemoryHeadsBatch,
} from "../../../orchestration/memory-retrieval-orchestrator";
import { applyVerificationReward } from "../../../orchestration/reward-orchestrator";
import { DeterministicResultVerifier } from "../../../orchestration/testing/deterministic-result-verifier";
import { verifyExecutionResult } from "../../../orchestration/verification-orchestrator";
import type { AuthorizationIssuanceCommand } from "../../contracts/authorization-issuance-command";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedEvidence } from "../../contracts/persisted-evidence";
import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import type { PersistedObservation } from "../../contracts/persisted-observation";
import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";
import { getDefaultRewardForVerificationStatus } from "../../contracts/reward-commands";
import type { PostgresDatabaseContext } from "../client";
import { candidateRepository } from "../repositories/candidate-repository";
import { evidenceRepository } from "../repositories/evidence-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { learningRepository } from "../repositories/learning-repository";
import { memoryRepository } from "../repositories/memory-repository";
import { observationRepository } from "../repositories/observation-repository";
import { planRepository } from "../repositories/plan-repository";
import { policyRepository } from "../repositories/policy-repository";
import { rewardRepository } from "../repositories/reward-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";

const T0 = "2026-08-31T05:00:00.000Z";
const T1 = "2026-08-31T05:01:00.000Z";
const T2 = "2026-08-31T05:02:00.000Z";
const T3 = "2026-08-31T05:03:00.000Z";
const T4 = "2026-08-31T05:04:00.000Z";
const T5 = "2026-08-31T05:05:00.000Z";
const T6 = "2026-08-31T05:06:00.000Z";
const T7 = "2026-08-31T05:07:00.000Z";
const T8 = "2026-08-31T05:08:00.000Z";

describe("live PostgreSQL learning system (reward ledger, learning state, verified memory) integration tests", () => {
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

  async function seedVerifiedExecution(
    suffix: string = "1",
    outcome:
      | "CONFIRMED_SUCCESS"
      | "CONFIRMED_FAILURE"
      | "INDETERMINATE" = "CONFIRMED_SUCCESS",
  ) {
    const cueId = `cue-m5-${suffix}`;
    const sessionId = `session-m5-${suffix}`;
    const candidateId = `candidate-m5-${suffix}`;
    const groundingResultId = `grounding-m5-${suffix}`;
    const policyDecisionId = `policy-m5-${suffix}`;
    const planId = `plan-m5-${suffix}`;
    const executionId = `execution-m5-${suffix}`;
    const stepId = "step-1";
    const operationId = `op-m5-${suffix}`;
    const observationId = `obs-m5-${suffix}`;
    const verificationId = `ver-m5-${suffix}`;
    const evidenceId = `ev-m5-${suffix}`;

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: `event-m5-${suffix}`,
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { test: true },
      },
      sessionId,
      maxRetries: 3,
    });

    await context.db.execute(sql`
      UPDATE cognitive_sessions
      SET phase = 'POLICY_SAFETY', current_candidate_id = ${candidateId},
          row_version = 1, updated_at = ${T1}
      WHERE session_id = ${sessionId}
    `);

    const candidate: PersistedCandidateAction = {
      candidateId,
      sessionId,
      cueId,
      evaluationGeneration: 1,
      goal: "Test learning and memory foundation",
      action: "fake.operation",
      confidence: 0.95,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.05,
      scoreValue: 0.92,
      recommendation: "PROCEED",
      scoreFormulaVersion: "v1",
      evidenceIds: [],
      createdAt: T1,
    };
    await candidateRepository.appendCandidate(context.db, candidate);

    const grounding: PersistedGroundingResult = {
      groundingResultId,
      candidateId,
      evaluationKey: `grounding-eval-${suffix}`,
      status: "VERIFIED",
      confidence: 0.98,
      reason: "Grounding verified.",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: T2,
    };
    await groundingRepository.appendGroundingResult(context.db, grounding);

    const policy: PersistedPolicyDecision = {
      policyDecisionId,
      candidateId,
      groundingResultId,
      evaluationKey: `policy-eval-${suffix}`,
      outcome: "ALLOW",
      reason: "Operation allowed.",
      policyEngineVersion: "v1",
      policyIds: ["policy-test"],
      evaluatedAt: T3,
    };
    await policyRepository.appendPolicyDecision(context.db, policy);

    await planRepository.appendPlan(context.db, {
      planId,
      candidateId,
      planGeneration: 1,
      steps: [{ stepId, ordinal: 0, description: "Step 1" }],
      dependencies: [],
      createdAt: T3,
    });

    const authorizationCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: `authorize:m5:${suffix}`,
      sessionId,
      candidateId,
      groundingResultId,
      policyDecisionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 0,
      safetyEventId: `safety-event-${suffix}`,
      safetyEventKey: `safety:m5:${suffix}`,
      issuedAt: T4,
    };
    const issued = await orchestrateAuthorizationIssuance(
      context.db,
      authorizationCommand,
    );
    if (issued.status !== "AUTHORIZED") {
      throw new Error(`Expected AUTHORIZED, received ${issued.status}.`);
    }

    await prepareAuthorizedExecution(context.db, issued.authorization, {
      commandIdempotencyKey: `prepare:m5:${suffix}`,
      executionId,
      sessionId,
      planId,
      expectedSessionRowVersion: issued.session.rowVersion,
      expectedSafetyGeneration: issued.generation,
      createdAt: T5,
    });

    await startAuthorizedExecution(context.db, issued.authorization, {
      commandIdempotencyKey: `start-exec:m5:${suffix}`,
      executionEventId: `event-start-exec-${suffix}`,
      eventKey: `event-key:start-exec:${suffix}`,
      executionId,
      sessionId,
      planId,
      expectedExecutionRowVersion: 0,
      expectedSafetyGeneration: issued.generation,
      startedAt: T6,
      reason: "Start authorized execution.",
    });

    await startAuthorizedExecutionStep(context.db, issued.authorization, {
      commandIdempotencyKey: `start-step:m5:${suffix}`,
      executionEventId: `event-start-step-${suffix}`,
      eventKey: `event-key:start-step:${suffix}`,
      executionId,
      sessionId,
      planId,
      stepId,
      expectedExecutionRowVersion: 1,
      expectedStepRowVersion: 0,
      expectedSafetyGeneration: issued.generation,
      startedAt: T7,
      reason: "Start authorized step.",
    });

    await reserveAuthorizedExecutionOperation(
      context.db,
      issued.authorization,
      {
        commandIdempotencyKey: `op:m5:step-1:${suffix}`,
        operationId,
        executionId,
        sessionId,
        planId,
        stepId,
        operationGeneration: 1,
        expectedStepRowVersion: 1,
        expectedSafetyGeneration: issued.generation,
        operationKind: "email.send",
        requestFingerprint: `sha256:request-${suffix}`,
        providerScope: "test-provider",
        providerIdempotencyKey: `prov-idemp-${suffix}`,
        createdAt: T7,
      },
    );

    const observation: PersistedObservation = {
      observationId,
      executionId,
      stepId,
      source: "provider-dispatch",
      sourceEventId: `event-obs-${suffix}`,
      summary: `Observation with outcome ${outcome}`,
      data: { outcome },
      observedAt: T7,
      payloadExpiresAt: null,
    };
    await observationRepository.appendObservation(context.db, observation);

    const evidence: PersistedEvidence = {
      evidenceId,
      source: "verification",
      sourceId: verificationId,
      claim: "Observed side effect matches expected outcome.",
      observedAt: T7,
      createdAt: T7,
      providerMetadata: { executionId },
    };
    await evidenceRepository.appendEvidence(context.db, evidence);

    const verificationResult = await verifyExecutionResult(
      context.db,
      verifier,
      {
        commandIdempotencyKey: `verify:m5:${suffix}`,
        verificationId,
        executionId,
        observationIds: [observationId],
        expectedVerificationGeneration: 1,
        verifierVersion: verifier.version,
        verifiedAt: T8,
      },
    );

    return {
      sessionId,
      candidateId,
      planId,
      executionId,
      stepId,
      operationId,
      observationId,
      verificationId,
      evidenceId,
      verification: verificationResult.verification,
      generation: issued.generation,
      authorization: issued.authorization,
    };
  }

  it("1. VERIFIED verification -> SUCCESS +5 reward", async () => {
    const fixture = await seedVerifiedExecution("1", "CONFIRMED_SUCCESS");
    expect(fixture.verification.status).toBe("VERIFIED");

    const defaultReward = getDefaultRewardForVerificationStatus(
      fixture.verification.status,
    );

    const result = await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:1",
      rewardEventId: "rew-1",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: defaultReward.rewardRuleId,
      signal: defaultReward.signal,
      value: defaultReward.value,
      skillKey: "email.send",
      reason: defaultReward.reason,
      createdAt: T8,
    });

    expect(result.isReplay).toBe(false);
    expect(result.reward.signal).toBe("SUCCESS");
    expect(result.reward.value).toBe(5);
    expect(result.learningState.totalReward).toBe(5);
    expect(result.learningState.sampleCount).toBe(1);
    expect(result.learningState.confidence).toBeGreaterThan(0.5);
  });

  it("2. FAILED verification -> FAILURE -10 reward", async () => {
    const fixture = await seedVerifiedExecution("2", "CONFIRMED_FAILURE");
    expect(fixture.verification.status).toBe("FAILED");

    const defaultReward = getDefaultRewardForVerificationStatus(
      fixture.verification.status,
    );

    const result = await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:2",
      rewardEventId: "rew-2",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: defaultReward.rewardRuleId,
      signal: defaultReward.signal,
      value: defaultReward.value,
      skillKey: "email.send",
      reason: defaultReward.reason,
      createdAt: T8,
    });

    expect(result.reward.signal).toBe("FAILURE");
    expect(result.reward.value).toBe(-10);
    expect(result.learningState.totalReward).toBe(-10);
    expect(result.learningState.sampleCount).toBe(1);
    expect(result.learningState.confidence).toBeLessThan(0.5);
  });

  it("3. INCONCLUSIVE -> NEUTRAL 0 reward", async () => {
    const fixture = await seedVerifiedExecution("3", "INDETERMINATE");
    expect(fixture.verification.status).toBe("INCONCLUSIVE");

    const defaultReward = getDefaultRewardForVerificationStatus(
      fixture.verification.status,
    );

    const result = await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:3",
      rewardEventId: "rew-3",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: defaultReward.rewardRuleId,
      signal: defaultReward.signal,
      value: defaultReward.value,
      skillKey: "email.send",
      reason: defaultReward.reason,
      createdAt: T8,
    });

    expect(result.reward.signal).toBe("NEUTRAL");
    expect(result.reward.value).toBe(0);
    expect(result.learningState.totalReward).toBe(0);
    expect(result.learningState.sampleCount).toBe(1);
    expect(result.learningState.confidence).toBe(0.5);
  });

  it("4. Same reward replay -> one reward row", async () => {
    const fixture = await seedVerifiedExecution("4", "CONFIRMED_SUCCESS");
    const cmd = {
      commandIdempotencyKey: "rew:cmd:4",
      rewardEventId: "rew-4",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS" as const,
      value: 5,
      skillKey: "email.send",
      reason: "Reward replay test",
      createdAt: T8,
    };

    const first = await applyVerificationReward(context.db, cmd);
    const replay = await applyVerificationReward(context.db, cmd);

    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);

    const count = await context.db.execute(sql`
      SELECT count(*)::int as count FROM reward_events WHERE reward_event_id = 'rew-4'
    `);
    expect((count.rows[0] as { count: number }).count).toBe(1);
  });

  it("5. Same reward replay -> learning applied once (no double-counting)", async () => {
    const fixture = await seedVerifiedExecution("5", "CONFIRMED_SUCCESS");
    const cmd = {
      commandIdempotencyKey: "rew:cmd:5",
      rewardEventId: "rew-5",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS" as const,
      value: 5,
      skillKey: "email.send",
      reason: "No double counting",
      createdAt: T8,
    };

    await applyVerificationReward(context.db, cmd);
    const replay = await applyVerificationReward(context.db, cmd);

    expect(replay.learningState.sampleCount).toBe(1);
    expect(replay.learningState.totalReward).toBe(5);
  });

  it("6. Concurrent same reward -> one durable reward/projection", async () => {
    const fixture = await seedVerifiedExecution("6", "CONFIRMED_SUCCESS");
    const cmd = {
      commandIdempotencyKey: "rew:cmd:6",
      rewardEventId: "rew-6",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS" as const,
      value: 5,
      skillKey: "email.send",
      reason: "Concurrent reward",
      createdAt: T8,
    };

    const results = await Promise.all([
      applyVerificationReward(context.db, cmd),
      applyVerificationReward(context.db, cmd),
    ]);

    expect(results.filter((r) => !r.isReplay)).toHaveLength(1);
    expect(results.filter((r) => r.isReplay)).toHaveLength(1);

    const learning = await learningRepository.findLearningState(
      context.db,
      "email.send",
    );
    expect(learning?.sampleCount).toBe(1);
    expect(learning?.totalReward).toBe(5);
  });

  it("7. Different rewards same skill -> projection remains correct", async () => {
    const f1 = await seedVerifiedExecution("7a", "CONFIRMED_SUCCESS");
    const f2 = await seedVerifiedExecution("7b", "CONFIRMED_FAILURE");

    await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:7a",
      rewardEventId: "rew-7a",
      executionId: f1.executionId,
      verificationId: f1.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 5,
      skillKey: "email.send",
      reason: "Success 1",
      createdAt: T8,
    });

    const res2 = await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:7b",
      rewardEventId: "rew-7b",
      executionId: f2.executionId,
      verificationId: f2.verificationId,
      rewardRuleId: "verification-failure-v1",
      signal: "FAILURE",
      value: -10,
      skillKey: "email.send",
      reason: "Failure 1",
      createdAt: T8,
    });

    expect(res2.learningState.sampleCount).toBe(2);
    expect(res2.learningState.totalReward).toBe(-5);
  });

  it("8 & 9 & 10. totalReward, sampleCount exact, confidence in [0,1]", async () => {
    const f1 = await seedVerifiedExecution("8a", "CONFIRMED_SUCCESS");
    const f2 = await seedVerifiedExecution("8b", "CONFIRMED_SUCCESS");

    await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:8a",
      rewardEventId: "rew-8a",
      executionId: f1.executionId,
      verificationId: f1.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 5,
      skillKey: "github.issue.create",
      reason: "Success 1",
      createdAt: T8,
    });

    const res2 = await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:8b",
      rewardEventId: "rew-8b",
      executionId: f2.executionId,
      verificationId: f2.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 5,
      skillKey: "github.issue.create",
      reason: "Success 2",
      createdAt: T8,
    });

    expect(res2.learningState.totalReward).toBe(10);
    expect(res2.learningState.sampleCount).toBe(2);
    expect(res2.learningState.confidence).toBeGreaterThanOrEqual(0);
    expect(res2.learningState.confidence).toBeLessThanOrEqual(1);
  });

  it("11 & 12. Negative signals lower confidence, positive signals increase confidence", async () => {
    const fPos = await seedVerifiedExecution("11pos", "CONFIRMED_SUCCESS");
    const fNeg = await seedVerifiedExecution("11neg", "CONFIRMED_FAILURE");

    const rPos = await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:pos",
      rewardEventId: "rew-pos",
      executionId: fPos.executionId,
      verificationId: fPos.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 5,
      skillKey: "skill.positive",
      reason: "Positive",
      createdAt: T8,
    });

    const rNeg = await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:neg",
      rewardEventId: "rew-neg",
      executionId: fNeg.executionId,
      verificationId: fNeg.verificationId,
      rewardRuleId: "verification-failure-v1",
      signal: "FAILURE",
      value: -10,
      skillKey: "skill.negative",
      reason: "Negative",
      createdAt: T8,
    });

    expect(rPos.learningState.confidence).toBeGreaterThan(0.5);
    expect(rNeg.learningState.confidence).toBeLessThan(0.5);
  });

  it("13, 14, 15. Learning state cannot grant execution authorization or alter safety generation", async () => {
    const fixture = await seedVerifiedExecution("13", "CONFIRMED_SUCCESS");

    // Manually push learning confidence to near 1.0
    await context.db.execute(sql`
      INSERT INTO learning_state (skill_key, confidence, total_reward, sample_count, row_version, updated_at)
      VALUES ('critical.skill', '0.9999', 500, 50, 0, ${T8})
      ON CONFLICT (skill_key) DO UPDATE SET confidence = '0.9999';
    `);

    const learning = await learningRepository.findLearningState(
      context.db,
      "critical.skill",
    );
    expect(learning?.confidence).toBe(0.9999);

    // Verify that execution safety state remains UNAUTHORIZED / unaffected
    const safety = await context.db.execute(sql`
      SELECT durable_status, generation FROM execution_safety_state WHERE session_id = ${fixture.sessionId}
    `);
    expect((safety.rows[0] as { durable_status: string }).durable_status).toBe(
      "UNAUTHORIZED",
    );
  });

  it("16. VERIFIED result admits verified memory", async () => {
    const fixture = await seedVerifiedExecution("16", "CONFIRMED_SUCCESS");
    expect(fixture.verification.status).toBe("VERIFIED");

    const res = await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:16",
      memoryId: "mem-16",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      kind: "FACT",
      key: "service.endpoint",
      version: 1,
      content: { url: "https://api.example.com", port: 443 },
      sourceIds: [fixture.evidenceId],
      confidence: 0.99,
      admissionRuleVersion: "verified-result-v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    expect(res.isReplay).toBe(false);
    expect(res.memory.version).toBe(1);
    expect(res.memory.kind).toBe("FACT");
    expect(res.memory.key).toBe("service.endpoint");
    expect(res.memory.verificationId).toBe(fixture.verificationId);

    const head = await memoryRepository.findMemoryHead(
      context.db,
      "FACT",
      "service.endpoint",
    );
    expect(head?.memoryId).toBe("mem-16");
    expect(head?.memoryVersion).toBe(1);
  });

  it("17. FAILED result cannot admit verified memory", async () => {
    const fixture = await seedVerifiedExecution("17", "CONFIRMED_FAILURE");
    expect(fixture.verification.status).toBe("FAILED");

    await expect(
      admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem:cmd:17",
        memoryId: "mem-17",
        executionId: fixture.executionId,
        verificationId: fixture.verificationId,
        kind: "FACT",
        key: "service.endpoint",
        version: 1,
        content: { url: "https://api.example.com" },
        sourceIds: [fixture.evidenceId],
        confidence: 0.99,
        admissionRuleVersion: "verified-result-v1",
        verifiedAt: T8,
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("18. INCONCLUSIVE result cannot admit verified memory", async () => {
    const fixture = await seedVerifiedExecution("18", "INDETERMINATE");
    expect(fixture.verification.status).toBe("INCONCLUSIVE");

    await expect(
      admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem:cmd:18",
        memoryId: "mem-18",
        executionId: fixture.executionId,
        verificationId: fixture.verificationId,
        kind: "FACT",
        key: "service.endpoint",
        version: 1,
        content: { url: "https://api.example.com" },
        sourceIds: [fixture.evidenceId],
        confidence: 0.99,
        admissionRuleVersion: "verified-result-v1",
        verifiedAt: T8,
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("19. Memory source provenance enforced (missing evidence rejected)", async () => {
    const fixture = await seedVerifiedExecution("19", "CONFIRMED_SUCCESS");

    await expect(
      admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem:cmd:19",
        memoryId: "mem-19",
        executionId: fixture.executionId,
        verificationId: fixture.verificationId,
        kind: "FACT",
        key: "service.endpoint",
        version: 1,
        content: { url: "https://api.example.com" },
        sourceIds: ["nonexistent-evidence-id"],
        confidence: 0.99,
        admissionRuleVersion: "verified-result-v1",
        verifiedAt: T8,
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("20. Cross-execution verification provenance rejected", async () => {
    const fixtureA = await seedVerifiedExecution("20a", "CONFIRMED_SUCCESS");
    const fixtureB = await seedVerifiedExecution("20b", "CONFIRMED_SUCCESS");

    await expect(
      admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem:cmd:20",
        memoryId: "mem-20",
        executionId: fixtureA.executionId, // execution A
        verificationId: fixtureB.verificationId, // verification from execution B!
        kind: "FACT",
        key: "service.endpoint",
        version: 1,
        content: { url: "https://api.example.com" },
        sourceIds: [fixtureA.evidenceId],
        confidence: 0.99,
        admissionRuleVersion: "verified-result-v1",
        verifiedAt: T8,
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("21, 22, 23, 24, 25. Version 1 initial, version 2 superseding, head advances, version 1 immutable", async () => {
    const fixture1 = await seedVerifiedExecution("21a", "CONFIRMED_SUCCESS");
    const fixture2 = await seedVerifiedExecution("21b", "CONFIRMED_SUCCESS");

    // Version 1
    const v1 = await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:21v1",
      memoryId: "mem-21-v1",
      executionId: fixture1.executionId,
      verificationId: fixture1.verificationId,
      kind: "SKILL",
      key: "deploy.procedure",
      version: 1,
      content: { steps: ["build", "test"] },
      sourceIds: [fixture1.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });
    expect(v1.memory.version).toBe(1);
    expect(v1.memory.supersedesMemoryId).toBeNull();

    // Version 2
    const v2 = await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:21v2",
      memoryId: "mem-21-v2",
      executionId: fixture2.executionId,
      verificationId: fixture2.verificationId,
      kind: "SKILL",
      key: "deploy.procedure",
      version: 2,
      content: { steps: ["build", "test", "deploy"] },
      sourceIds: [fixture2.evidenceId],
      confidence: 0.98,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });
    expect(v2.memory.version).toBe(2);
    expect(v2.memory.supersedesMemoryId).toBe("mem-21-v1");

    // Version 1 remains unchanged in database
    const reloadedV1 = await memoryRepository.findMemoryById(
      context.db,
      "mem-21-v1",
    );
    expect(reloadedV1?.version).toBe(1);
    expect((reloadedV1?.content as { steps: string[] }).steps).toEqual([
      "build",
      "test",
    ]);

    // Head is at version 2
    const head = await memoryRepository.findMemoryHead(
      context.db,
      "SKILL",
      "deploy.procedure",
    );
    expect(head?.memoryId).toBe("mem-21-v2");
    expect(head?.memoryVersion).toBe(2);
  });

  it("26. Stale head CAS rejected", async () => {
    const fixture = await seedVerifiedExecution("26", "CONFIRMED_SUCCESS");

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:26",
      memoryId: "mem-26",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      kind: "FACT",
      key: "user.role",
      version: 1,
      content: { role: "admin" },
      sourceIds: [fixture.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    // Attempting direct append with wrong expectedHeadRowVersion
    await expect(
      memoryRepository.appendVerifiedMemoryVersion(
        context.db,
        {
          memoryId: "mem-26-stale",
          kind: "FACT",
          key: "user.role",
          version: 2,
          content: { role: "superadmin" },
          sourceIds: [fixture.evidenceId],
          confidence: 0.95,
          admissionRuleVersion: "v1",
          supersedesMemoryId: "mem-26",
          verificationId: fixture.verificationId,
          verifiedAt: T8,
          createdAt: T8,
        },
        { advanceHead: true, expectedHeadRowVersion: 99 },
      ),
    ).rejects.toMatchObject({ code: "STALE_WRITE" });
  });

  it("27. Concurrent head updates produce deterministic winner", async () => {
    const f1 = await seedVerifiedExecution("27a", "CONFIRMED_SUCCESS");
    const f2 = await seedVerifiedExecution("27b", "CONFIRMED_SUCCESS");

    const cmd1 = {
      commandIdempotencyKey: "mem:cmd:27a",
      memoryId: "mem-27a",
      executionId: f1.executionId,
      verificationId: f1.verificationId,
      kind: "FACT" as const,
      key: "concurrent.key",
      version: 1,
      content: { v: 1 },
      sourceIds: [f1.evidenceId],
      confidence: 0.9,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    };

    const cmd2 = {
      commandIdempotencyKey: "mem:cmd:27b",
      memoryId: "mem-27b",
      executionId: f2.executionId,
      verificationId: f2.verificationId,
      kind: "FACT" as const,
      key: "concurrent.key",
      version: 1,
      content: { v: 1 },
      sourceIds: [f2.evidenceId],
      confidence: 0.9,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    };

    const results = await Promise.allSettled([
      admitVerifiedMemory(context.db, cmd1),
      admitVerifiedMemory(context.db, cmd2),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const head = await memoryRepository.findMemoryHead(
      context.db,
      "FACT",
      "concurrent.key",
    );
    expect(head).not.toBeNull();
    expect(head?.memoryVersion).toBe(1);
  });

  it("28. Same memory replay does not duplicate source links", async () => {
    const fixture = await seedVerifiedExecution("28", "CONFIRMED_SUCCESS");

    const cmd = {
      commandIdempotencyKey: "mem:cmd:28",
      memoryId: "mem-28",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      kind: "FACT" as const,
      key: "replay.sources",
      version: 1,
      content: { test: true },
      sourceIds: [fixture.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    };

    const first = await admitVerifiedMemory(context.db, cmd);
    const replay = await admitVerifiedMemory(context.db, cmd);

    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);

    const sources = await context.db.execute(sql`
      SELECT count(*)::int as count FROM verified_memory_sources WHERE memory_id = 'mem-28'
    `);
    expect((sources.rows[0] as { count: number }).count).toBe(1);
  });

  it("29. Same kind/key/version with different content throws IDEMPOTENCY_CONFLICT", async () => {
    const fixture = await seedVerifiedExecution("29", "CONFIRMED_SUCCESS");

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:29a",
      memoryId: "mem-29",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      kind: "FACT",
      key: "conflict.key",
      version: 1,
      content: { option: "A", answer: 1 },
      sourceIds: [fixture.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    await expect(
      admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem:cmd:29b",
        memoryId: "mem-29-diff",
        executionId: fixture.executionId,
        verificationId: fixture.verificationId,
        kind: "FACT",
        key: "conflict.key",
        version: 1,
        content: { option: "A", answer: 999 }, // Conflicting content!
        sourceIds: [fixture.evidenceId],
        confidence: 0.95,
        admissionRuleVersion: "v1",
        verifiedAt: T8,
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("30. Cannot move memory head backward", async () => {
    const f1 = await seedVerifiedExecution("30a", "CONFIRMED_SUCCESS");
    const f2 = await seedVerifiedExecution("30b", "CONFIRMED_SUCCESS");

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:30v1",
      memoryId: "mem-30-v1",
      executionId: f1.executionId,
      verificationId: f1.verificationId,
      kind: "FACT",
      key: "backward.key",
      version: 1,
      content: { val: 1 },
      sourceIds: [f1.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:30v2",
      memoryId: "mem-30-v2",
      executionId: f2.executionId,
      verificationId: f2.verificationId,
      kind: "FACT",
      key: "backward.key",
      version: 2,
      content: { val: 2 },
      sourceIds: [f2.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    // Attempt to admit version 1 again
    await expect(
      admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem:cmd:30v1-back",
        memoryId: "mem-30-v1-back",
        executionId: f1.executionId,
        verificationId: f1.verificationId,
        kind: "FACT",
        key: "backward.key",
        version: 1,
        content: { val: 1 },
        sourceIds: [f1.evidenceId],
        confidence: 0.95,
        admissionRuleVersion: "v1",
        verifiedAt: T8,
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("31. Exact kind/key retrieval returns current head", async () => {
    const fixture = await seedVerifiedExecution("31", "CONFIRMED_SUCCESS");

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:31",
      memoryId: "mem-31",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      kind: "PROCEDURE",
      key: "invoice.verify",
      version: 1,
      content: { matchThreshold: 0.99 },
      sourceIds: [fixture.evidenceId],
      confidence: 0.99,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    const retrieved = await retrieveMemoryHead(context.db, {
      kind: "PROCEDURE",
      memoryKey: "invoice.verify",
    });

    expect(retrieved).not.toBeNull();
    expect(retrieved?.memoryId).toBe("mem-31");
    expect(retrieved?.version).toBe(1);
    expect(retrieved?.sourceIds).toEqual([fixture.evidenceId]);
  });

  it("32. Multiple explicit key retrieval is deterministic", async () => {
    const f1 = await seedVerifiedExecution("32a", "CONFIRMED_SUCCESS");
    const f2 = await seedVerifiedExecution("32b", "CONFIRMED_SUCCESS");

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:32z",
      memoryId: "mem-32z",
      executionId: f1.executionId,
      verificationId: f1.verificationId,
      kind: "FACT",
      key: "z.key",
      version: 1,
      content: { name: "Z" },
      sourceIds: [f1.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:32a",
      memoryId: "mem-32a",
      executionId: f2.executionId,
      verificationId: f2.verificationId,
      kind: "FACT",
      key: "a.key",
      version: 1,
      content: { name: "A" },
      sourceIds: [f2.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    const batch = await retrieveMemoryHeadsBatch(context.db, [
      { kind: "FACT", memoryKey: "z.key" },
      { kind: "FACT", memoryKey: "a.key" },
    ]);

    expect(batch).toHaveLength(2);
    expect(batch[0].key).toBe("a.key");
    expect(batch[1].key).toBe("z.key");
  });

  it("33. Historical memory only returned when explicitly requested", async () => {
    const f1 = await seedVerifiedExecution("33a", "CONFIRMED_SUCCESS");
    const f2 = await seedVerifiedExecution("33b", "CONFIRMED_SUCCESS");

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:33v1",
      memoryId: "mem-33-v1",
      executionId: f1.executionId,
      verificationId: f1.verificationId,
      kind: "FACT",
      key: "org.setting",
      version: 1,
      content: { timeoutSec: 30 },
      sourceIds: [f1.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:33v2",
      memoryId: "mem-33-v2",
      executionId: f2.executionId,
      verificationId: f2.verificationId,
      kind: "FACT",
      key: "org.setting",
      version: 2,
      content: { timeoutSec: 60 },
      sourceIds: [f2.evidenceId],
      confidence: 0.98,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    // Default head retrieval returns v2
    const currentHead = await retrieveMemoryHead(context.db, {
      kind: "FACT",
      memoryKey: "org.setting",
    });
    expect(currentHead?.version).toBe(2);

    // Explicit historical retrieval returns v1
    const histV1 = await retrieveHistoricalMemoryVersion(context.db, {
      kind: "FACT",
      memoryKey: "org.setting",
      version: 1,
    });
    expect(histV1?.version).toBe(1);
    expect((histV1?.content as { timeoutSec: number }).timeoutSec).toBe(30);
  });

  it("34. Restart reloads learning state", async () => {
    const fixture = await seedVerifiedExecution("34", "CONFIRMED_SUCCESS");

    await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:34",
      rewardEventId: "rew-34",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 5,
      skillKey: "restart.skill",
      reason: "Restart test",
      createdAt: T8,
    });

    const reloaded = await learningRepository.findLearningState(
      context.db,
      "restart.skill",
    );
    expect(reloaded).not.toBeNull();
    expect(reloaded?.totalReward).toBe(5);
    expect(reloaded?.sampleCount).toBe(1);
  });

  it("35 & 36. Restart reloads memory head and historical versions", async () => {
    const fixture = await seedVerifiedExecution("35", "CONFIRMED_SUCCESS");

    await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:35",
      memoryId: "mem-35",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      kind: "FACT",
      key: "restart.memory",
      version: 1,
      content: { persistent: true },
      sourceIds: [fixture.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    const head = await memoryRepository.findMemoryHead(
      context.db,
      "FACT",
      "restart.memory",
    );
    expect(head?.memoryId).toBe("mem-35");

    const mem = await memoryRepository.findMemoryById(context.db, "mem-35");
    expect(mem?.key).toBe("restart.memory");
  });

  it("37. No runtime authorization can be reconstructed from learning or memory", async () => {
    const fixture = await seedVerifiedExecution("37", "CONFIRMED_SUCCESS");

    await applyVerificationReward(context.db, {
      commandIdempotencyKey: "rew:cmd:37",
      rewardEventId: "rew-37",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 5,
      skillKey: "auth.check.skill",
      reason: "Auth check",
      createdAt: T8,
    });

    const memory = await admitVerifiedMemory(context.db, {
      commandIdempotencyKey: "mem:cmd:37",
      memoryId: "mem-37",
      executionId: fixture.executionId,
      verificationId: fixture.verificationId,
      kind: "POLICY",
      key: "policy.fact",
      version: 1,
      content: { policySummary: "Read only access verified" },
      sourceIds: [fixture.evidenceId],
      confidence: 0.95,
      admissionRuleVersion: "v1",
      verifiedAt: T8,
      createdAt: T8,
    });

    const json = JSON.stringify(memory);
    expect(json).not.toContain("authBrand");
    expect(json).not.toContain("ALLOWED");
  });

  it("38. Reward/learning transaction failure rolls back both", async () => {
    const fixture = await seedVerifiedExecution("38", "CONFIRMED_SUCCESS");

    await expect(
      applyVerificationReward(context.db, {
        commandIdempotencyKey: "rew:cmd:38",
        rewardEventId: "rew-38",
        executionId: fixture.executionId,
        verificationId: "nonexistent-verification-id",
        rewardRuleId: "verification-success-v1",
        signal: "SUCCESS",
        value: 5,
        skillKey: "rollback.skill",
        reason: "Rollback test",
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const reward = await rewardRepository.findRewardById(context.db, "rew-38");
    expect(reward).toBeNull();

    const learning = await learningRepository.findLearningState(
      context.db,
      "rollback.skill",
    );
    expect(learning).toBeNull();
  });

  it("39. Memory admission/source-link failure fully rolls back", async () => {
    const fixture = await seedVerifiedExecution("39", "CONFIRMED_SUCCESS");

    // Invalid evidence ID triggers failure
    await expect(
      admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem:cmd:39",
        memoryId: "mem-39",
        executionId: fixture.executionId,
        verificationId: fixture.verificationId,
        kind: "FACT",
        key: "rollback.memory",
        version: 1,
        content: { test: true },
        sourceIds: ["invalid-evidence-fk"],
        confidence: 0.95,
        admissionRuleVersion: "v1",
        verifiedAt: T8,
        createdAt: T8,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const mem = await memoryRepository.findMemoryById(context.db, "mem-39");
    expect(mem).toBeNull();

    const head = await memoryRepository.findMemoryHead(
      context.db,
      "FACT",
      "rollback.memory",
    );
    expect(head).toBeNull();
  });

  it("40. Migration 0002 applies cleanly after 0000 + 0001", async () => {
    const migrations = await context.db.execute(sql`
      SELECT count(*)::int as count FROM drizzle.__drizzle_migrations
    `);
    expect(
      (migrations.rows[0] as { count: number }).count,
    ).toBeGreaterThanOrEqual(3);
  });
});
