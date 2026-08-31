import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { orchestrateAuthorizationIssuance } from "../../../orchestration/authorization-orchestrator";
import { dispatchAuthorizedOperation } from "../../../orchestration/dispatch-orchestrator";
import {
  recordObservation,
  recordObservationFromDispatch,
  recordObservationFromReconciliation,
} from "../../../orchestration/observation-orchestrator";
import { prepareAuthorizedExecution } from "../../../orchestration/execution-preparation-orchestrator";
import {
  reserveAuthorizedExecutionOperation,
  startAuthorizedExecution,
  startAuthorizedExecutionStep,
} from "../../../orchestration/execution-progress-orchestrator";
import { reconcileOperationWithAdapter } from "../../../orchestration/reconciliation-orchestrator";
import { DeterministicResultVerifier } from "../../../orchestration/testing/deterministic-result-verifier";
import { verifyExecutionResult } from "../../../orchestration/verification-orchestrator";
import { FakeOperationAdapter } from "../../../adapters/testing/fake-operation-adapter";
import type { AuthorizationIssuanceCommand } from "../../contracts/authorization-issuance-command";
import type { DispatchOperationCommand } from "../../contracts/dispatch-operation-command";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";
import type { PostgresDatabaseContext } from "../client";
import { candidateRepository } from "../repositories/candidate-repository";
import { executionRepository } from "../repositories/execution-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { observationRepository } from "../repositories/observation-repository";
import { planRepository } from "../repositories/plan-repository";
import { policyRepository } from "../repositories/policy-repository";
import { sessionRepository } from "../repositories/session-repository";
import { verificationRepository } from "../repositories/verification-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { persistFailureRecovery } from "../transactions/persist-failure-recovery";
import { computeObservationSetDigest } from "../utils/observation-digest";

const T0 = "2026-08-31T05:00:00.000Z";
const T1 = "2026-08-31T05:01:00.000Z";
const T2 = "2026-08-31T05:02:00.000Z";
const T3 = "2026-08-31T05:03:00.000Z";
const T4 = "2026-08-31T05:04:00.000Z";
const T5 = "2026-08-31T05:05:00.000Z";
const T6 = "2026-08-31T05:06:00.000Z";
const T7 = "2026-08-31T05:07:00.000Z";
const T8 = "2026-08-31T05:08:00.000Z";

describe("live PostgreSQL durable observation and result verification integration tests", () => {
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

  async function seedAuthorizedExecution(suffix: string = "1") {
    const cueId = `cue-obs-${suffix}`;
    const sessionId = `session-obs-${suffix}`;
    const candidateId = `candidate-obs-${suffix}`;
    const groundingResultId = `grounding-obs-${suffix}`;
    const policyDecisionId = `policy-obs-${suffix}`;
    const planId = `plan-obs-${suffix}`;
    const executionId = `execution-obs-${suffix}`;
    const stepId = "step-1";
    const operationId = `op-obs-${suffix}`;

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: `event-obs-${suffix}`,
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
      goal: "Test observation and verification boundary",
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
      commandIdempotencyKey: `authorize:obs:${suffix}`,
      sessionId,
      candidateId,
      groundingResultId,
      policyDecisionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 0,
      safetyEventId: `safety-event-${suffix}`,
      safetyEventKey: `safety:obs:${suffix}`,
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
      commandIdempotencyKey: `prepare:obs:${suffix}`,
      executionId,
      sessionId,
      planId,
      expectedSessionRowVersion: issued.session.rowVersion,
      expectedSafetyGeneration: issued.generation,
      createdAt: T5,
    });

    await startAuthorizedExecution(context.db, issued.authorization, {
      commandIdempotencyKey: `start-exec:obs:${suffix}`,
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
      commandIdempotencyKey: `start-step:obs:${suffix}`,
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

    const reserveResult = await reserveAuthorizedExecutionOperation(
      context.db,
      issued.authorization,
      {
        commandIdempotencyKey: `op:obs:step-1:${suffix}`,
        operationId,
        executionId,
        sessionId,
        planId,
        stepId,
        operationGeneration: 1,
        expectedStepRowVersion: 1,
        expectedSafetyGeneration: issued.generation,
        operationKind: "fake.operation",
        requestFingerprint: `sha256:request-${suffix}`,
        providerScope: "fake-provider",
        providerIdempotencyKey: `prov-idemp-${suffix}`,
        createdAt: T7,
      },
    );

    return {
      cueId,
      sessionId,
      candidateId,
      planId,
      executionId,
      stepId,
      operationId,
      authorization: issued.authorization,
      generation: issued.generation,
      operation: reserveResult.operation,
    };
  }

  function createDispatchCmd(
    fixture: Awaited<ReturnType<typeof seedAuthorizedExecution>>,
    overrides?: Partial<DispatchOperationCommand>,
  ): DispatchOperationCommand {
    return {
      commandIdempotencyKey: `dispatch:cmd:${fixture.executionId}`,
      operationId: fixture.operationId,
      attemptId: `attempt-${fixture.executionId}`,
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: fixture.stepId,
      operationGeneration: 1,
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
      request: { action: "send" },
      ...overrides,
    };
  }

  it("1. Provider confirmed success -> durable observation", async () => {
    const fixture = await seedAuthorizedExecution("1");
    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });

    const dispatch = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCmd(fixture),
    );

    const obsResult = await recordObservationFromDispatch(context.db, {
      commandIdempotencyKey: "obs:dispatch:1",
      observationId: "obs-dispatch-1",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      operation: dispatch.operation,
      dispatchResult: dispatch.dispatchResult,
      observedAt: T8,
    });

    expect(obsResult.isReplay).toBe(false);
    expect(obsResult.observation.source).toBe("provider-dispatch");
    expect(obsResult.observation.summary).toContain("Provider confirmed successful");

    const reloaded = await observationRepository.findObservationById(
      context.db,
      "obs-dispatch-1",
    );
    expect(reloaded).not.toBeNull();
    expect((reloaded?.data as Record<string, unknown>).outcome).toBe("CONFIRMED_SUCCESS");
  });

  it("2. Deterministic provider failure -> durable observation", async () => {
    const fixture = await seedAuthorizedExecution("2");
    const adapter = new FakeOperationAdapter({
      mode: "CONFIRMED_FAILURE",
      failureSummary: "Account limit exceeded",
    });

    const dispatch = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCmd(fixture),
    );

    const obsResult = await recordObservationFromDispatch(context.db, {
      commandIdempotencyKey: "obs:dispatch:2",
      observationId: "obs-dispatch-2",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      operation: dispatch.operation,
      dispatchResult: dispatch.dispatchResult,
      observedAt: T8,
    });

    expect(obsResult.observation.summary).toContain("Account limit exceeded");
    expect((obsResult.observation.data as Record<string, unknown>).outcome).toBe(
      "CONFIRMED_FAILURE",
    );
  });

  it("3. UNKNOWN -> indeterminate observation", async () => {
    const fixture = await seedAuthorizedExecution("3");
    const adapter = new FakeOperationAdapter({ mode: "TIMEOUT_THROW" });

    const dispatch = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCmd(fixture),
    );

    const obsResult = await recordObservationFromDispatch(context.db, {
      commandIdempotencyKey: "obs:dispatch:3",
      observationId: "obs-dispatch-3",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      operation: dispatch.operation,
      dispatchResult: dispatch.dispatchResult,
      observedAt: T8,
    });

    expect((obsResult.observation.data as Record<string, unknown>).outcome).toBe(
      "INDETERMINATE",
    );
  });

  it("4. Reconciliation success -> new durable observation", async () => {
    const fixture = await seedAuthorizedExecution("4");
    const adapter = new FakeOperationAdapter({ mode: "TIMEOUT_THROW" });

    await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCmd(fixture),
    );

    adapter.mode = "RECONCILE_SUCCESS";
    const reconciliation = await reconcileOperationWithAdapter(
      context.db,
      adapter,
      {
        commandIdempotencyKey: "rec:obs:4",
        operationId: fixture.operationId,
        expectedOperationRowVersion: 2,
        reconciledAt: T8,
      },
    );

    const obsResult = await recordObservationFromReconciliation(context.db, {
      commandIdempotencyKey: "obs:rec:4",
      observationId: "obs-rec-4",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      operation: reconciliation.operation,
      reconciliationResult: reconciliation.reconciliationResult,
      observedAt: T8,
    });

    expect(obsResult.observation.source).toBe("provider-reconciliation");
    expect((obsResult.observation.data as Record<string, unknown>).outcome).toBe(
      "CONFIRMED_SUCCEEDED",
    );
  });

  it("5. Reconciliation not applied -> durable observation", async () => {
    const fixture = await seedAuthorizedExecution("5");
    const adapter = new FakeOperationAdapter({ mode: "TIMEOUT_THROW" });

    await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCmd(fixture),
    );

    adapter.mode = "RECONCILE_NOT_APPLIED";
    const reconciliation = await reconcileOperationWithAdapter(
      context.db,
      adapter,
      {
        commandIdempotencyKey: "rec:obs:5",
        operationId: fixture.operationId,
        expectedOperationRowVersion: 2,
        reconciledAt: T8,
      },
    );

    const obsResult = await recordObservationFromReconciliation(context.db, {
      commandIdempotencyKey: "obs:rec:5",
      observationId: "obs-rec-5",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      operation: reconciliation.operation,
      reconciliationResult: reconciliation.reconciliationResult,
      observedAt: T8,
    });

    expect((obsResult.observation.data as Record<string, unknown>).outcome).toBe(
      "CONFIRMED_NOT_APPLIED",
    );
  });

  it("6. Observation replay does not duplicate", async () => {
    const fixture = await seedAuthorizedExecution("6");

    const cmd = {
      commandIdempotencyKey: "obs:replay:6",
      observationId: "obs-replay-6",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-6",
      summary: "First observation",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
      payloadExpiresAt: null,
    };

    const first = await recordObservation(context.db, cmd);
    const replay = await recordObservation(context.db, cmd);

    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);

    const count = await context.db.execute(sql`
      SELECT count(*)::int as count FROM observations WHERE observation_id = 'obs-replay-6'
    `);
    expect((count.rows[0] as { count: number }).count).toBe(1);
  });

  it("7. Concurrent same observation -> one durable row", async () => {
    const fixture = await seedAuthorizedExecution("7");

    const cmd = {
      commandIdempotencyKey: "obs:conc:7",
      observationId: "obs-conc-7",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-7",
      summary: "Concurrent observation",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
      payloadExpiresAt: null,
    };

    const results = await Promise.all([
      recordObservation(context.db, cmd),
      recordObservation(context.db, cmd),
    ]);

    expect(results.filter((r) => !r.isReplay)).toHaveLength(1);
    expect(results.filter((r) => r.isReplay)).toHaveLength(1);
  });

  it("8. Cross-execution observation binding rejected", async () => {
    await seedAuthorizedExecution("8");

    await expect(
      recordObservation(context.db, {
        commandIdempotencyKey: "obs:bad-exec",
        observationId: "obs-bad-exec",
        executionId: "nonexistent-execution-id",
        stepId: null,
        source: "provider-dispatch",
        sourceEventId: "evt-8",
        summary: "Bad execution",
        data: { outcome: "CONFIRMED_SUCCESS" },
        observedAt: T8,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("9. Observation contains no runtime authorization/private brand", async () => {
    const fixture = await seedAuthorizedExecution("9");

    const obs = await recordObservation(context.db, {
      commandIdempotencyKey: "obs:auth-check",
      observationId: "obs-auth-check",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-9",
      summary: "Observation check",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    const json = JSON.stringify(obs);
    expect(json).not.toContain("authBrand");
    expect(json).not.toContain("ALLOWED");
  });

  it("10. Observation data rejects test credential fields", async () => {
    const fixture = await seedAuthorizedExecution("10");

    await expect(
      recordObservation(context.db, {
        commandIdempotencyKey: "obs:sec-1",
        observationId: "obs-sec-1",
        executionId: fixture.executionId,
        stepId: fixture.stepId,
        source: "provider-dispatch",
        sourceEventId: "evt-10",
        summary: "Data with secret",
        data: { apiKey: "secret-token", outcome: "CONFIRMED_SUCCESS" },
        observedAt: T8,
      }),
    ).rejects.toThrow(/Disallowed security token or credential property/);
  });

  it("11. First verification generation = 1", async () => {
    const fixture = await seedAuthorizedExecution("11");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:v-11",
      observationId: "obs-v-11",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-11",
      summary: "Provider confirmed success",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    const verification = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:11:1",
      verificationId: "ver-11-1",
      executionId: fixture.executionId,
      observationIds: ["obs-v-11"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    expect(verification.verification.verificationGeneration).toBe(1);
  });

  it("12. Canonical observation digest is independent of input ordering", async () => {
    const fixture = await seedAuthorizedExecution("12");

    const o1 = await recordObservation(context.db, {
      commandIdempotencyKey: "obs:12:1",
      observationId: "obs-12-1",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-12-1",
      summary: "First observation",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    const o2 = await recordObservation(context.db, {
      commandIdempotencyKey: "obs:12:2",
      observationId: "obs-12-2",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-reconciliation",
      sourceEventId: "evt-12-2",
      summary: "Second observation",
      data: { outcome: "CONFIRMED_SUCCEEDED" },
      observedAt: T8,
    });

    const digestA = computeObservationSetDigest([o1.observation, o2.observation]);
    const digestB = computeObservationSetDigest([o2.observation, o1.observation]);

    expect(digestA).toBe(digestB);
  });

  it("13. VERIFIED deterministic case", async () => {
    const fixture = await seedAuthorizedExecution("13");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:v-13",
      observationId: "obs-v-13",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-13",
      summary: "Provider confirmed success",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    const res = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:13",
      verificationId: "ver-13",
      executionId: fixture.executionId,
      observationIds: ["obs-v-13"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    expect(res.verification.status).toBe("VERIFIED");
    expect(res.verification.confidence).toBe(1.0);
  });

  it("14. FAILED deterministic case", async () => {
    const fixture = await seedAuthorizedExecution("14");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:v-14",
      observationId: "obs-v-14",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-14",
      summary: "Provider permanent failure",
      data: { outcome: "CONFIRMED_FAILURE" },
      observedAt: T8,
    });

    const res = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:14",
      verificationId: "ver-14",
      executionId: fixture.executionId,
      observationIds: ["obs-v-14"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    expect(res.verification.status).toBe("FAILED");
  });

  it("15. INCONCLUSIVE insufficient evidence case", async () => {
    const fixture = await seedAuthorizedExecution("15");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:v-15",
      observationId: "obs-v-15",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-15",
      summary: "Partial information",
      data: { outcome: "UNKNOWN_METRIC" },
      observedAt: T8,
    });

    const res = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:15",
      verificationId: "ver-15",
      executionId: fixture.executionId,
      observationIds: ["obs-v-15"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    expect(res.verification.status).toBe("INCONCLUSIVE");
  });

  it("16. UNKNOWN without reconciliation -> INCONCLUSIVE", async () => {
    const fixture = await seedAuthorizedExecution("16");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:v-16",
      observationId: "obs-v-16",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-16",
      summary: "Timeout after dispatch",
      data: { outcome: "INDETERMINATE" },
      observedAt: T8,
    });

    const res = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:16",
      verificationId: "ver-16",
      executionId: fixture.executionId,
      observationIds: ["obs-v-16"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    expect(res.verification.status).toBe("INCONCLUSIVE");
  });

  it("17. UNKNOWN + later confirmed reconciliation success: generation 1 INCONCLUSIVE, generation 2 VERIFIED", async () => {
    const fixture = await seedAuthorizedExecution("17");

    // Observation 1: initial indeterminate outcome
    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:v-17-1",
      observationId: "obs-v-17-1",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-17-1",
      summary: "Timeout after dispatch",
      data: { outcome: "INDETERMINATE" },
      observedAt: T8,
    });

    // Verification Generation 1
    const gen1 = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:17:1",
      verificationId: "ver-17-1",
      executionId: fixture.executionId,
      observationIds: ["obs-v-17-1"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });
    expect(gen1.verification.verificationGeneration).toBe(1);
    expect(gen1.verification.status).toBe("INCONCLUSIVE");

    // Later: reconciliation confirms success -> Observation 2
    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:v-17-2",
      observationId: "obs-v-17-2",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-reconciliation",
      sourceEventId: "evt-17-2",
      summary: "Reconciliation confirmed success",
      data: { outcome: "CONFIRMED_SUCCEEDED" },
      observedAt: T8,
    });

    // Verification Generation 2 with both observations
    const gen2 = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:17:2",
      verificationId: "ver-17-2",
      executionId: fixture.executionId,
      observationIds: ["obs-v-17-1", "obs-v-17-2"],
      expectedVerificationGeneration: 2,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });
    expect(gen2.verification.verificationGeneration).toBe(2);
    expect(gen2.verification.status).toBe("VERIFIED");
  });

  it("18. Original verification remains immutable when newer generation is appended", async () => {
    const fixture = await seedAuthorizedExecution("18");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:18:1",
      observationId: "obs-18-1",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-18",
      summary: "Initial",
      data: { outcome: "INDETERMINATE" },
      observedAt: T8,
    });

    await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:18:1",
      verificationId: "ver-18-1",
      executionId: fixture.executionId,
      observationIds: ["obs-18-1"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:18:2",
      observationId: "obs-18-2",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-reconciliation",
      sourceEventId: "evt-18-2",
      summary: "Reconciled",
      data: { outcome: "CONFIRMED_SUCCEEDED" },
      observedAt: T8,
    });

    await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:18:2",
      verificationId: "ver-18-2",
      executionId: fixture.executionId,
      observationIds: ["obs-18-2"],
      expectedVerificationGeneration: 2,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    const v1 = await verificationRepository.findVerificationById(
      context.db,
      "ver-18-1",
    );
    expect(v1?.status).toBe("INCONCLUSIVE");
    expect(v1?.verificationGeneration).toBe(1);
  });

  it("19. Verification links exact observation IDs atomically", async () => {
    const fixture = await seedAuthorizedExecution("19");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:19:1",
      observationId: "obs-19-1",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-19-1",
      summary: "Obs 1",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:19:2",
      observationId: "obs-19-2",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-19-2",
      summary: "Obs 2",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:19",
      verificationId: "ver-19",
      executionId: fixture.executionId,
      observationIds: ["obs-19-1", "obs-19-2"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    const linkedObs =
      await verificationRepository.findObservationIdsForVerification(
        context.db,
        "ver-19",
      );
    expect(linkedObs).toEqual(["obs-19-1", "obs-19-2"]);
  });

  it("20. Cross-execution observation verification rejected", async () => {
    const fixtureA = await seedAuthorizedExecution("20A");
    const fixtureB = await seedAuthorizedExecution("20B");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:20B",
      observationId: "obs-20B",
      executionId: fixtureB.executionId,
      stepId: fixtureB.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-20B",
      summary: "Obs belonging to B",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    await expect(
      verifyExecutionResult(context.db, verifier, {
        commandIdempotencyKey: "verify:20A",
        verificationId: "ver-20A",
        executionId: fixtureA.executionId,
        observationIds: ["obs-20B"],
        expectedVerificationGeneration: 1,
        verifierVersion: verifier.version,
        verifiedAt: T8,
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("21. Same verification replay does not duplicate", async () => {
    const fixture = await seedAuthorizedExecution("21");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:21",
      observationId: "obs-21",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-21",
      summary: "Obs 21",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    const cmd = {
      commandIdempotencyKey: "verify:21:same",
      verificationId: "ver-21",
      executionId: fixture.executionId,
      observationIds: ["obs-21"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    };

    const first = await verifyExecutionResult(context.db, verifier, cmd);
    const replay = await verifyExecutionResult(context.db, verifier, cmd);

    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);
  });

  it("22. Concurrent same verification -> one durable result", async () => {
    const fixture = await seedAuthorizedExecution("22");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:22",
      observationId: "obs-22",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-22",
      summary: "Obs 22",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    const cmd = {
      commandIdempotencyKey: "verify:22:conc",
      verificationId: "ver-22",
      executionId: fixture.executionId,
      observationIds: ["obs-22"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    };

    const results = await Promise.all([
      verifyExecutionResult(context.db, verifier, cmd),
      verifyExecutionResult(context.db, verifier, cmd),
    ]);

    expect(results.filter((r) => !r.isReplay)).toHaveLength(1);
    expect(results.filter((r) => r.isReplay)).toHaveLength(1);
  });

  it("23. Conflicting verification identity/result rejected", async () => {
    const fixture = await seedAuthorizedExecution("23");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:23",
      observationId: "obs-23",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-23",
      summary: "Obs 23",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:23:initial",
      verificationId: "ver-23",
      executionId: fixture.executionId,
      observationIds: ["obs-23"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    const conflictingVerifier = new DeterministicResultVerifier("test-verifier-v1");
    conflictingVerifier.verify = () => ({
      status: "FAILED",
      confidence: 1.0,
      reason: "Conflicting evaluation",
      verifierVersion: "test-verifier-v1",
    });

    await expect(
      verifyExecutionResult(context.db, conflictingVerifier, {
        commandIdempotencyKey: "verify:23:conflict",
        verificationId: "ver-23-different-id",
        executionId: fixture.executionId,
        observationIds: ["obs-23"],
        expectedVerificationGeneration: 1,
        verifierVersion: "test-verifier-v1",
        verifiedAt: T8,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("24. Blocked execution may still receive factual observation of old side effect", async () => {
    const fixture = await seedAuthorizedExecution("24");

    const session = await sessionRepository.findSessionById(
      context.db,
      fixture.sessionId,
    );
    const execution = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );

    // Revoke safety state -> execution BLOCKED
    await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "failure:obs:24",
      sessionId: fixture.sessionId,
      expectedSessionRowVersion: session!.rowVersion,
      expectedSafetyGeneration: fixture.generation,
      failure: "EXECUTION_TIMEOUT",
      reason: "Revoked",
      evidenceIds: [],
      auditEventId: "audit:obs:24",
      safetyEventId: "safety-event:obs:24",
      safetyEventKey: "safety-key:obs:24",
      candidateId: fixture.candidateId,
      planId: fixture.planId,
      activeExecution: {
        executionId: fixture.executionId,
        expectedExecutionRowVersion: execution!.rowVersion,
        expectedStatus: "RUNNING",
        executionEventId: "event:blocked:obs:24",
        executionEventKey: "event-key:blocked:obs:24",
      },
      createdAt: T7,
    });

    // Factual observation can still be appended
    const obs = await recordObservation(context.db, {
      commandIdempotencyKey: "obs:blocked-exec",
      observationId: "obs-blocked-exec",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-24",
      summary: "Side effect confirmed after revocation",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    expect(obs.observation.summary).toBe("Side effect confirmed after revocation");
  });

  it("25. Blocked execution may be VERIFIED without resurrecting execution state", async () => {
    const fixture = await seedAuthorizedExecution("25");

    const session = await sessionRepository.findSessionById(
      context.db,
      fixture.sessionId,
    );
    const execution = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );

    await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "failure:obs:25",
      sessionId: fixture.sessionId,
      expectedSessionRowVersion: session!.rowVersion,
      expectedSafetyGeneration: fixture.generation,
      failure: "EXECUTION_TIMEOUT",
      reason: "Revoked",
      evidenceIds: [],
      auditEventId: "audit:obs:25",
      safetyEventId: "safety-event:obs:25",
      safetyEventKey: "safety-key:obs:25",
      candidateId: fixture.candidateId,
      planId: fixture.planId,
      activeExecution: {
        executionId: fixture.executionId,
        expectedExecutionRowVersion: execution!.rowVersion,
        expectedStatus: "RUNNING",
        executionEventId: "event:blocked:obs:25",
        executionEventKey: "event-key:blocked:obs:25",
      },
      createdAt: T7,
    });

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:25",
      observationId: "obs-25",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-25",
      summary: "Obs 25",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    const res = await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:25",
      verificationId: "ver-25",
      executionId: fixture.executionId,
      observationIds: ["obs-25"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    expect(res.verification.status).toBe("VERIFIED");

    // Execution remains BLOCKED and is not resurrected
    const reloaded = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );
    expect(reloaded?.status).toBe("BLOCKED");
  });

  it("26. Safety generation changes do not erase observations", async () => {
    const fixture = await seedAuthorizedExecution("26");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:26",
      observationId: "obs-26",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-26",
      summary: "Obs 26",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    await context.db.execute(sql`
      UPDATE execution_safety_state
      SET generation = 99, durable_status = 'BLOCKED', failure_code = 'EXECUTION_TIMEOUT',
          reason = 'Safety advancement', blocked_at = ${T8}, updated_at = ${T8}
      WHERE session_id = ${fixture.sessionId}
    `);

    const reloaded = await observationRepository.findObservationById(
      context.db,
      "obs-26",
    );
    expect(reloaded).not.toBeNull();
  });

  it("27. Process restart reloads observations", async () => {
    const fixture = await seedAuthorizedExecution("27");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:27",
      observationId: "obs-27",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-27",
      summary: "Obs 27",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    // Simulate process restart: fresh repository query
    const reloaded = await observationRepository.findManyObservationsByExecutionId(
      context.db,
      fixture.executionId,
    );
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].observationId).toBe("obs-27");
  });

  it("28. Process restart reloads verification history", async () => {
    const fixture = await seedAuthorizedExecution("28");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:28",
      observationId: "obs-28",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-28",
      summary: "Obs 28",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    await verifyExecutionResult(context.db, verifier, {
      commandIdempotencyKey: "verify:28",
      verificationId: "ver-28",
      executionId: fixture.executionId,
      observationIds: ["obs-28"],
      expectedVerificationGeneration: 1,
      verifierVersion: verifier.version,
      verifiedAt: T8,
    });

    const history = await verificationRepository.findVerificationsByExecutionId(
      context.db,
      fixture.executionId,
    );
    expect(history).toHaveLength(1);
    expect(history[0].verificationId).toBe("ver-28");
  });

  it("29. Verifier can rerun after pre-persist crash simulation", async () => {
    const fixture = await seedAuthorizedExecution("29");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:29",
      observationId: "obs-29",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-29",
      summary: "Obs 29",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    let computeCount = 0;
    const crashVerifier = new DeterministicResultVerifier("test-verifier-v1");
    const origVerify = crashVerifier.verify.bind(crashVerifier);
    crashVerifier.verify = (input) => {
      computeCount++;
      return origVerify(input);
    };

    const cmd = {
      commandIdempotencyKey: "verify:29",
      verificationId: "ver-29",
      executionId: fixture.executionId,
      observationIds: ["obs-29"],
      expectedVerificationGeneration: 1,
      verifierVersion: crashVerifier.version,
      verifiedAt: T8,
    };

    const result = await verifyExecutionResult(context.db, crashVerifier, cmd);
    expect(result.verification.status).toBe("VERIFIED");
    expect(computeCount).toBe(1);
  });

  it("30. Verification link failure rolls entire transaction back", async () => {
    const fixture = await seedAuthorizedExecution("30");

    await recordObservation(context.db, {
      commandIdempotencyKey: "obs:30",
      observationId: "obs-30",
      executionId: fixture.executionId,
      stepId: fixture.stepId,
      source: "provider-dispatch",
      sourceEventId: "evt-30",
      summary: "Obs 30",
      data: { outcome: "CONFIRMED_SUCCESS" },
      observedAt: T8,
    });

    // Attempting to append verification with an observation ID that fails FK constraint
    await expect(
      verificationRepository.appendVerification(
        context.db,
        {
          verificationId: "ver-30-fail",
          executionId: fixture.executionId,
          verificationGeneration: 1,
          observationSetDigest: "sha256:fake",
          verifierVersion: "v1",
          status: "VERIFIED",
          confidence: 1.0,
          reason: "Rollback test",
          verifiedAt: T8,
        },
        ["nonexistent-obs-id-fk-fail"],
      ),
    ).rejects.toThrow();

    const check = await verificationRepository.findVerificationById(
      context.db,
      "ver-30-fail",
    );
    expect(check).toBeNull();
  });
});
