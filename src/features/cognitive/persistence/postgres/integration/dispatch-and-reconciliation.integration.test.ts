import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  isAllowedExecutionSafetyState,
  type ExecutionSafetyState,
} from "../../../domain/execution-safety";
import { assertLiveExecutionAuthorization } from "../../../orchestration/execution-authorization-guard";
import { orchestrateAuthorizationIssuance } from "../../../orchestration/authorization-orchestrator";
import { dispatchAuthorizedOperation } from "../../../orchestration/dispatch-orchestrator";
import {
  completeExecutionStep,
  finalizeExecutionFailure,
  finalizeExecutionIfComplete,
  recordOperationFailed,
  recordOperationSucceeded,
  recordOperationUnknown,
} from "../../../orchestration/execution-outcome-orchestrator";
import { prepareAuthorizedExecution } from "../../../orchestration/execution-preparation-orchestrator";
import {
  beginAuthorizedOperationAttempt,
  reserveAuthorizedExecutionOperation,
  startAuthorizedExecution,
  startAuthorizedExecutionStep,
} from "../../../orchestration/execution-progress-orchestrator";
import {
  orchestrateMarkInFlightUnknown,
  orchestrateOperationReconciliation,
  reconcileOperationWithAdapter,
} from "../../../orchestration/reconciliation-orchestrator";
import { FakeOperationAdapter } from "../../../adapters/testing/fake-operation-adapter";
import type { AuthorizationIssuanceCommand } from "../../contracts/authorization-issuance-command";
import type { DispatchOperationCommand } from "../../contracts/dispatch-operation-command";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";
import type { PostgresDatabaseContext } from "../client";
import { PersistenceError } from "../errors/persistence-errors";
import { candidateRepository } from "../repositories/candidate-repository";
import { executionOperationRepository } from "../repositories/execution-operation-repository";
import { executionRepository } from "../repositories/execution-repository";
import { executionStepRepository } from "../repositories/execution-step-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { planRepository } from "../repositories/plan-repository";
import { policyRepository } from "../repositories/policy-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { persistFailureRecovery } from "../transactions/persist-failure-recovery";
import { mapStoredSafetyToDomain } from "../utils/enum-mappers";

const T0 = "2026-08-31T04:00:00.000Z";
const T1 = "2026-08-31T04:01:00.000Z";
const T2 = "2026-08-31T04:02:00.000Z";
const T3 = "2026-08-31T04:03:00.000Z";
const T4 = "2026-08-31T04:04:00.000Z";
const T5 = "2026-08-31T04:05:00.000Z";
const T6 = "2026-08-31T04:06:00.000Z";
const T7 = "2026-08-31T04:07:00.000Z";

describe("live PostgreSQL dispatch adapter and reconciliation integration tests", () => {
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

  async function seedAuthorizedPlan() {
    const cueId = "cue-dispatch";
    const sessionId = "session-dispatch";
    const candidateId = "candidate-dispatch";
    const groundingResultId = "grounding-dispatch";
    const policyDecisionId = "policy-dispatch";
    const planId = "plan-dispatch";
    const executionId = "execution-dispatch";
    const steps = [
      { stepId: "step-1", ordinal: 0, description: "Synthetic dispatch step" },
    ];

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "event-dispatch",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { synthetic: true },
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
      goal: "Test dispatch boundary",
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
      evaluationKey: "grounding-eval-dispatch",
      status: "VERIFIED",
      confidence: 0.98,
      reason: "Grounding verified for dispatch test.",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: T2,
    };
    await groundingRepository.appendGroundingResult(context.db, grounding);

    const policy: PersistedPolicyDecision = {
      policyDecisionId,
      candidateId,
      groundingResultId,
      evaluationKey: "policy-eval-dispatch",
      outcome: "ALLOW",
      reason: "Operation allowed by test policy.",
      policyEngineVersion: "v1",
      policyIds: ["policy-test"],
      evaluatedAt: T3,
    };
    await policyRepository.appendPolicyDecision(context.db, policy);

    await planRepository.appendPlan(context.db, {
      planId,
      candidateId,
      planGeneration: 1,
      steps,
      dependencies: [],
      createdAt: T3,
    });

    const authorizationCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "authorize:dispatch:1",
      sessionId,
      candidateId,
      groundingResultId,
      policyDecisionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 0,
      safetyEventId: "safety-event-dispatch",
      safetyEventKey: "safety:dispatch:1",
      issuedAt: T4,
    };
    const issued = await orchestrateAuthorizationIssuance(
      context.db,
      authorizationCommand,
    );
    if (issued.status !== "AUTHORIZED") {
      throw new Error(`Expected AUTHORIZED, received ${issued.status}.`);
    }

    return {
      cueId,
      sessionId,
      candidateId,
      planId,
      executionId,
      steps,
      authorization: issued.authorization,
      generation: issued.generation,
      session: issued.session,
    };
  }

  async function prepareStartAndReserve(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
  ) {
    await prepareAuthorizedExecution(context.db, fixture.authorization, {
      commandIdempotencyKey: "prepare:dispatch:1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      expectedSessionRowVersion: fixture.session.rowVersion,
      expectedSafetyGeneration: fixture.generation,
      createdAt: T5,
    });

    await startAuthorizedExecution(context.db, fixture.authorization, {
      commandIdempotencyKey: "start-execution:dispatch:1",
      executionEventId: "execution-event-start-dispatch",
      eventKey: "execution:start:dispatch:1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      expectedExecutionRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      startedAt: T6,
      reason: "Start authorized execution.",
    });

    await startAuthorizedExecutionStep(context.db, fixture.authorization, {
      commandIdempotencyKey: "start-step:dispatch:1",
      executionEventId: "execution-event-start-step-dispatch",
      eventKey: "execution:start:step:dispatch:1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedExecutionRowVersion: 1,
      expectedStepRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      startedAt: T7,
      reason: "Start authorized step 1.",
    });

    return await reserveAuthorizedExecutionOperation(
      context.db,
      fixture.authorization,
      {
        commandIdempotencyKey: "op:dispatch:step-1:1",
        operationId: "operation-dispatch-1",
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        stepId: "step-1",
        operationGeneration: 1,
        expectedStepRowVersion: 1,
        expectedSafetyGeneration: fixture.generation,
        operationKind: "fake.operation",
        requestFingerprint: "sha256:request-fingerprint-v1",
        providerScope: "fake-provider",
        providerIdempotencyKey: "prov-idemp-1",
        createdAt: T7,
      },
    );
  }

  function createDispatchCommand(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
    overrides?: Partial<DispatchOperationCommand>,
  ): DispatchOperationCommand {
    return {
      commandIdempotencyKey: "dispatch:cmd:1",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      operationGeneration: 1,
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-dispatch-1",
      startedAt: T7,
      request: { target: "user@example.com", action: "notify" },
      ...overrides,
    };
  }

  it("1. Successful fake dispatch: IN_FLIGHT -> SUCCEEDED", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });
    const command = createDispatchCommand(fixture);

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    expect(result.isReplay).toBe(false);
    expect(result.operation.status).toBe("SUCCEEDED");
    expect(result.attempt.status).toBe("SUCCEEDED");
    expect(adapter.dispatchCount).toBe(1);
  });

  it("2. Attempt finalizes atomically with operation", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });
    const command = createDispatchCommand(fixture);

    await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    const op = await executionOperationRepository.findOperationById(
      context.db,
      command.operationId,
    );
    const attempt = await executionOperationRepository.findAttemptById(
      context.db,
      command.attemptId,
    );

    expect(op?.status).toBe("SUCCEEDED");
    expect(attempt?.status).toBe("SUCCEEDED");
    expect(attempt?.finishedAt).not.toBeNull();
  });

  it("3. ProviderOperationId persists atomically on success", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({
      mode: "SUCCESS",
      simulatedProviderOperationId: "stripe-charge-999",
    });
    const command = createDispatchCommand(fixture);

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    expect(result.operation.providerOperationId).toBe("stripe-charge-999");
    const reloaded = await executionOperationRepository.findOperationById(
      context.db,
      command.operationId,
    );
    expect(reloaded?.providerOperationId).toBe("stripe-charge-999");
  });

  it("4. Deterministic fake provider failure: IN_FLIGHT -> FAILED", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({
      mode: "CONFIRMED_FAILURE",
      failureSummary: "Card declined: insufficient funds",
    });
    const command = createDispatchCommand(fixture);

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    expect(result.operation.status).toBe("FAILED");
    expect(result.attempt.status).toBe("FAILED");
    expect(result.attempt.errorSummary).toBe(
      "Card declined: insufficient funds",
    );
  });

  it("5. Timeout after possible send: -> UNKNOWN, not FAILED", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "TIMEOUT_THROW" });
    const command = createDispatchCommand(fixture);

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    expect(result.operation.status).toBe("UNKNOWN");
    expect(result.operation.status).not.toBe("FAILED");
    expect(result.attempt.status).toBe("UNKNOWN");
  });

  it("6. Connection reset after possible send: -> UNKNOWN", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "CONNECTION_RESET" });
    const command = createDispatchCommand(fixture);

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    expect(result.operation.status).toBe("UNKNOWN");
    expect(result.attempt.status).toBe("UNKNOWN");
  });

  it("7. UNKNOWN has uncertaintyReason and reconciliation REQUIRED", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({
      mode: "INDETERMINATE",
      uncertaintyReason: "Provider returned 502 Bad Gateway after 5s",
    });
    const command = createDispatchCommand(fixture);

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    expect(result.operation.status).toBe("UNKNOWN");
    expect(result.operation.uncertaintyReason).toBe(
      "Provider returned 502 Bad Gateway after 5s",
    );
    expect(result.operation.reconciliationStatus).toBe("REQUIRED");
  });

  it("8. UNKNOWN does not fail step", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "TIMEOUT_THROW" });
    await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCommand(fixture),
    );

    const step = await executionStepRepository.findStep(
      context.db,
      fixture.executionId,
      "step-1",
    );
    expect(step?.status).toBe("RUNNING");
    expect(step?.status).not.toBe("FAILED");

    // Completing or failing step is rejected
    await expect(
      completeExecutionStep(context.db, {
        commandIdempotencyKey: "complete:step-unk",
        executionEventId: "event:step-unk-succ",
        eventKey: "event-key:step-unk-succ",
        executionId: fixture.executionId,
        planId: fixture.planId,
        stepId: "step-1",
        operationGeneration: 1,
        expectedExecutionRowVersion: 2,
        expectedStepRowVersion: 1,
        completedAt: T7,
        reason: "Cannot succeed while operation is UNKNOWN",
      }),
    ).rejects.toThrow(PersistenceError);
  });

  it("9. UNKNOWN does not finalize execution failed", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "TIMEOUT_THROW" });
    await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCommand(fixture),
    );

    // Finalizing failure is rejected because no step is FAILED
    await expect(
      finalizeExecutionFailure(context.db, {
        commandIdempotencyKey: "finalize:fail-unk",
        executionEventId: "event:finalize:fail-unk",
        eventKey: "event-key:finalize:fail-unk",
        executionId: fixture.executionId,
        expectedExecutionRowVersion: 2,
        completedAt: T7,
        errorSummary: "Cannot finalize failed from UNKNOWN alone",
      }),
    ).rejects.toThrow(PersistenceError);

    // Finalizing success is rejected because step is not SUCCEEDED
    await expect(
      finalizeExecutionIfComplete(context.db, {
        commandIdempotencyKey: "finalize:succ-unk",
        executionEventId: "event:finalize:succ-unk",
        eventKey: "event-key:finalize:succ-unk",
        executionId: fixture.executionId,
        expectedExecutionRowVersion: 2,
        completedAt: T7,
        reason: "Cannot finalize success",
      }),
    ).rejects.toThrow(PersistenceError);
  });

  it("10. No automatic retry / attempt #2 is generated", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "TIMEOUT_THROW" });
    await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCommand(fixture),
    );

    const attempts = await context.db.execute(sql`
      SELECT count(*)::int as count FROM execution_operation_attempts
      WHERE operation_id = 'operation-dispatch-1'
    `);
    expect((attempts.rows[0] as { count: number }).count).toBe(1);

    const op = await executionOperationRepository.findOperationById(
      context.db,
      "operation-dispatch-1",
    );
    expect(op?.attemptCount).toBe(1);
    expect(op?.operationGeneration).toBe(1);
  });

  it("11. Provider idempotency key remains stable across attempts", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const op = await executionOperationRepository.findOperationById(
      context.db,
      "operation-dispatch-1",
    );
    expect(op?.providerIdempotencyKey).toBe("prov-idemp-1");
  });

  it("12. Same logical dispatch replay does not create duplicate provider effect", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });
    const command = createDispatchCommand(fixture);

    const first = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );
    expect(first.isReplay).toBe(false);
    expect(adapter.dispatchCount).toBe(1);

    const replay = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );
    expect(replay.isReplay).toBe(true);
    // Adapter was NOT invoked a second time!
    expect(adapter.dispatchCount).toBe(1);
  });

  it("13. Conflicting providerOperationId is rejected", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:conflict-id",
      attemptId: "attempt-conflict-id",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    // Record initial outcome with providerOperationId "prov-id-A"
    await recordOperationSucceeded(context.db, {
      commandIdempotencyKey: "outcome:prov-a",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-conflict-id",
      expectedOperationRowVersion: 1,
      outcome: "SUCCEEDED",
      providerOperationId: "prov-id-A",
      finishedAt: T7,
    });

    // Reconciling with conflicting providerOperationId "prov-id-B" throws
    await expect(
      executionOperationRepository.reconcileOperation(context.db, {
        operationId: "operation-dispatch-1",
        expectedRowVersion: 2,
        reconciliationOutcome: "CONFIRMED_SUCCEEDED",
        evidenceSummary: "Conflicting ID",
        providerOperationId: "prov-id-B",
        reconciledAt: T7,
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("14. Safety revoked during fake dispatch: provider result still records, execution remains BLOCKED", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    // Custom adapter simulating safety revocation while external call is in flight
    const adapter: FakeOperationAdapter = new FakeOperationAdapter({
      mode: "SUCCESS",
    });
    adapter.dispatch = async (input) => {
      adapter.dispatchCalls.push(input);

      // Failure recovery occurs while provider is processing
      const session = await sessionRepository.findSessionById(
        context.db,
        fixture.sessionId,
      );
      const execution = await executionRepository.findExecutionById(
        context.db,
        fixture.executionId,
      );
      await persistFailureRecovery(context.db, {
        commandIdempotencyKey: "failure:during-dispatch",
        sessionId: fixture.sessionId,
        expectedSessionRowVersion: session!.rowVersion,
        expectedSafetyGeneration: fixture.generation,
        failure: "EXECUTION_TIMEOUT",
        reason: "Revoked during in-flight external call",
        evidenceIds: [],
        auditEventId: "audit:during-dispatch",
        safetyEventId: "safety-event:during-dispatch",
        safetyEventKey: "safety-key:during-dispatch",
        candidateId: fixture.candidateId,
        planId: fixture.planId,
        activeExecution: {
          executionId: fixture.executionId,
          expectedExecutionRowVersion: execution!.rowVersion,
          expectedStatus: "RUNNING",
          executionEventId: "event:blocked:during-dispatch",
          executionEventKey: "event-key:blocked:during-dispatch",
        },
        createdAt: T7,
      });

      return {
        outcome: "CONFIRMED_SUCCESS",
        providerOperationId: "prov-succ-during-revocation",
        result: { ok: true },
        finishedAt: T7,
      };
    };

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      createDispatchCommand(fixture),
    );

    // Provider result is recorded factually
    expect(result.operation.status).toBe("SUCCEEDED");
    expect(result.attempt.status).toBe("SUCCEEDED");

    // Execution remains BLOCKED and is not resurrected
    const reloadedExec = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );
    expect(reloadedExec?.status).toBe("BLOCKED");
  });

  it("15. Restart with IN_FLIGHT operation: no automatic redispatch", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    // Operation moves to IN_FLIGHT
    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:in-flight-crash",
      attemptId: "attempt-in-flight-crash",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    // Simulate process crash: fresh adapter instance with 0 calls
    const freshAdapter = new FakeOperationAdapter({ mode: "SUCCESS" });

    // Reload operation from database
    const reloaded = await executionOperationRepository.findOperationById(
      context.db,
      "operation-dispatch-1",
    );
    expect(reloaded?.status).toBe("IN_FLIGHT");
    expect(freshAdapter.dispatchCount).toBe(0);
  });

  it("16. Restart loses runtime authorization", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const storedSafety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      fixture.sessionId,
    );
    expect(storedSafety?.status).toBe("UNAUTHORIZED");

    const rehydrated = mapStoredSafetyToDomain(storedSafety!);
    expect(isAllowedExecutionSafetyState(rehydrated)).toBe(false);
    expect(() =>
      assertLiveExecutionAuthorization(rehydrated, storedSafety!.generation),
    ).toThrow();
  });

  it("17. Reconciliation does not require runtime authorization", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    // Begin attempt and mark UNKNOWN
    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:for-reconcile",
      attemptId: "attempt-for-reconcile",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:unk-for-rec",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-for-reconcile",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Awaiting reconciliation",
      finishedAt: T7,
    });

    // Reconcile without passing any runtime capability
    const adapter = new FakeOperationAdapter({ mode: "RECONCILE_SUCCESS" });
    const result = await reconcileOperationWithAdapter(context.db, adapter, {
      commandIdempotencyKey: "rec:without-auth",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciledAt: T7,
    });

    expect(result.operation.reconciliationStatus).toBe("RECONCILED");
    expect(result.operation.reconciliationOutcome).toBe("CONFIRMED_SUCCEEDED");
  });

  it("18. Reconciliation confirmed success recorded durably", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:rec-succ",
      attemptId: "attempt-rec-succ",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:rec-succ",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-rec-succ",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Timeout",
      finishedAt: T7,
    });

    const adapter = new FakeOperationAdapter({ mode: "RECONCILE_SUCCESS" });
    const result = await reconcileOperationWithAdapter(context.db, adapter, {
      commandIdempotencyKey: "reconcile:succ:1",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciledAt: T7,
    });

    expect(result.operation.reconciliationStatus).toBe("RECONCILED");
    expect(result.operation.reconciliationOutcome).toBe("CONFIRMED_SUCCEEDED");
    expect(result.operation.status).toBe("UNKNOWN");
  });

  it("19. Reconciliation confirmed not applied recorded durably", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:rec-not-applied",
      attemptId: "attempt-rec-not-applied",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:rec-not-applied",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-rec-not-applied",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Timeout",
      finishedAt: T7,
    });

    const adapter = new FakeOperationAdapter({
      mode: "RECONCILE_NOT_APPLIED",
    });
    const result = await reconcileOperationWithAdapter(context.db, adapter, {
      commandIdempotencyKey: "reconcile:not-applied:1",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciledAt: T7,
    });

    expect(result.operation.reconciliationStatus).toBe("RECONCILED");
    expect(result.operation.reconciliationOutcome).toBe(
      "CONFIRMED_NOT_APPLIED",
    );
  });

  it("20. Reconciliation indeterminate remains unresolved safely", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:rec-indet",
      attemptId: "attempt-rec-indet",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:rec-indet",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-rec-indet",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Initial timeout",
      finishedAt: T7,
    });

    const adapter = new FakeOperationAdapter({
      mode: "RECONCILE_INDETERMINATE",
    });
    const result = await reconcileOperationWithAdapter(context.db, adapter, {
      commandIdempotencyKey: "reconcile:indet:1",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciledAt: T7,
    });

    expect(result.operation.reconciliationStatus).toBe("RECONCILED");
    expect(result.operation.reconciliationOutcome).toBe("INDETERMINATE");
  });

  it("21. Same reconciliation replay is idempotent", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:rec-replay",
      attemptId: "attempt-rec-replay",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:rec-replay",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-rec-replay",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Timeout",
      finishedAt: T7,
    });

    const cmd = {
      commandIdempotencyKey: "reconcile:replay:1",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciliationOutcome: "CONFIRMED_SUCCEEDED" as const,
      evidenceSummary: "Provider confirmed",
      reconciledAt: T7,
    };

    const first = await orchestrateOperationReconciliation(context.db, cmd);
    const replay = await orchestrateOperationReconciliation(context.db, cmd);

    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);
    expect(replay.operation.reconciliationOutcome).toBe("CONFIRMED_SUCCEEDED");
  });

  it("22. Conflicting reconciliation is rejected", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:rec-conflict",
      attemptId: "attempt-rec-conflict",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:rec-conflict",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-rec-conflict",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Timeout",
      finishedAt: T7,
    });

    await orchestrateOperationReconciliation(context.db, {
      commandIdempotencyKey: "reconcile:conf:1",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciliationOutcome: "CONFIRMED_SUCCEEDED",
      evidenceSummary: "Confirmed success",
      reconciledAt: T7,
    });

    // Attempting conflicting reconciliation outcome throws
    await expect(
      orchestrateOperationReconciliation(context.db, {
        commandIdempotencyKey: "reconcile:conf:2",
        operationId: "operation-dispatch-1",
        expectedOperationRowVersion: 3,
        reconciliationOutcome: "CONFIRMED_NOT_APPLIED",
        evidenceSummary: "Conflicting not applied",
        reconciledAt: T7,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("23. Stale operation rowVersion fails closed", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await expect(
      recordOperationSucceeded(context.db, {
        commandIdempotencyKey: "outcome:stale-test",
        operationId: "operation-dispatch-1",
        attemptId: "attempt-dispatch-1",
        expectedOperationRowVersion: 99,
        outcome: "SUCCEEDED",
        finishedAt: T7,
      }),
    ).rejects.toThrow(PersistenceError);
  });

  it("24. Concurrent outcome record: exactly one durable winner", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:conc-outcome",
      attemptId: "attempt-conc-outcome",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    const outcomes = await Promise.allSettled([
      recordOperationSucceeded(context.db, {
        commandIdempotencyKey: "outcome:conc-w1",
        operationId: "operation-dispatch-1",
        attemptId: "attempt-conc-outcome",
        expectedOperationRowVersion: 1,
        outcome: "SUCCEEDED",
        finishedAt: T7,
      }),
      recordOperationFailed(context.db, {
        commandIdempotencyKey: "outcome:conc-w2",
        operationId: "operation-dispatch-1",
        attemptId: "attempt-conc-outcome",
        expectedOperationRowVersion: 1,
        outcome: "FAILED",
        errorSummary: "Worker 2 failure",
        finishedAt: T7,
      }),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  });

  it("25. Concurrent reconciliation: deterministic winner and replay behavior", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:conc-rec",
      attemptId: "attempt-conc-rec",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:conc-rec",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-conc-rec",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Timeout",
      finishedAt: T7,
    });

    const cmd = {
      commandIdempotencyKey: "rec:conc:same",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciliationOutcome: "CONFIRMED_SUCCEEDED" as const,
      evidenceSummary: "Confirmed",
      reconciledAt: T7,
    };

    const results = await Promise.all([
      orchestrateOperationReconciliation(context.db, cmd),
      orchestrateOperationReconciliation(context.db, cmd),
    ]);

    expect(results.filter((r) => !r.isReplay)).toHaveLength(1);
    expect(results.filter((r) => r.isReplay)).toHaveLength(1);
  });

  it("26. Outcome attempt failure causes full rollback", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    // Attempting recordOutcome with invalid attemptId rolls back
    await expect(
      executionOperationRepository.recordOutcome(context.db, {
        operationId: "operation-dispatch-1",
        attemptId: "nonexistent-attempt-id",
        expectedRowVersion: 0,
        outcome: "SUCCEEDED",
        summary: null,
        finishedAt: T7,
      }),
    ).rejects.toThrow();

    const op = await executionOperationRepository.findOperationById(
      context.db,
      "operation-dispatch-1",
    );
    expect(op?.status).toBe("PENDING");
  });

  it("27. Reconciliation DB failure leaves no partial reconciliation state", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await expect(
      executionOperationRepository.reconcileOperation(context.db, {
        operationId: "nonexistent-op",
        expectedRowVersion: 0,
        reconciliationOutcome: "CONFIRMED_SUCCEEDED",
        evidenceSummary: "evidence",
        reconciledAt: T7,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("28. New dispatch after safety generation stale is rejected before fake adapter is invoked", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    // Revoke safety state to generation 2
    await context.db.execute(sql`
      UPDATE execution_safety_state
      SET generation = ${fixture.generation + 1}, durable_status = 'BLOCKED',
          failure_code = 'EXECUTION_TIMEOUT', reason = 'Revoked',
          blocked_at = ${T7}, updated_at = ${T7}
      WHERE session_id = ${fixture.sessionId}
    `);

    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });
    const command = createDispatchCommand(fixture);

    await expect(
      dispatchAuthorizedOperation(
        context.db,
        fixture.authorization,
        adapter,
        command,
      ),
    ).rejects.toThrow(PersistenceError);

    // Security invariant: fake adapter was NEVER invoked
    expect(adapter.dispatchCount).toBe(0);
  });

  it("29. Forged capability: fake adapter invocation count remains zero", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const forged = {
      status: "ALLOWED",
      generation: fixture.generation,
      candidateId: fixture.candidateId,
      failure: null,
      reason: null,
      blockedAt: null,
    } as unknown as ExecutionSafetyState;

    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });
    const command = createDispatchCommand(fixture);

    await expect(
      dispatchAuthorizedOperation(context.db, forged, adapter, command),
    ).rejects.toThrow(PersistenceError);

    expect(adapter.dispatchCount).toBe(0);
  });

  it("30. Spread-cloned capability: fake adapter invocation count remains zero", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const cloned = { ...fixture.authorization };
    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });
    const command = createDispatchCommand(fixture);

    await expect(
      dispatchAuthorizedOperation(context.db, cloned, adapter, command),
    ).rejects.toThrow(PersistenceError);

    expect(adapter.dispatchCount).toBe(0);
  });

  it("31. Pre-dispatch failure records FAILED outcome", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    const adapter = new FakeOperationAdapter({
      mode: "PRE_DISPATCH_THROW",
    });
    const command = createDispatchCommand(fixture);

    const result = await dispatchAuthorizedOperation(
      context.db,
      fixture.authorization,
      adapter,
      command,
    );

    expect(result.operation.status).toBe("FAILED");
    expect(result.attempt.status).toBe("FAILED");
    expect(result.attempt.errorSummary).toContain(
      "Local request serialization failed",
    );
  });

  it("32. orchestrateMarkInFlightUnknown recovers stranded in-flight operation", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:stranded-test",
      attemptId: "attempt-stranded-test",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    const result = await orchestrateMarkInFlightUnknown(context.db, {
      commandIdempotencyKey: "mark-unknown:stranded-1",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 1,
      uncertaintyReason: "Worker crashed before dispatch completed",
      occurredAt: T7,
    });

    expect(result.operation.status).toBe("UNKNOWN");
    expect(result.operation.uncertaintyReason).toBe(
      "Worker crashed before dispatch completed",
    );
    expect(result.operation.reconciliationStatus).toBe("REQUIRED");
  });

  it("33. Unsupported reconciliation adapter returns INDETERMINATE safely", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartAndReserve(fixture);

    await beginAuthorizedOperationAttempt(context.db, fixture.authorization, {
      commandIdempotencyKey: "begin:unsupported-rec",
      attemptId: "attempt-unsupported-rec",
      operationId: "operation-dispatch-1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      stepId: "step-1",
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      workerId: "worker-1",
      startedAt: T7,
    });

    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:unsupported-rec",
      operationId: "operation-dispatch-1",
      attemptId: "attempt-unsupported-rec",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Timeout",
      finishedAt: T7,
    });

    const adapter = new FakeOperationAdapter({
      supportsReconciliation: false,
    });
    const result = await reconcileOperationWithAdapter(context.db, adapter, {
      commandIdempotencyKey: "rec:unsupported:1",
      operationId: "operation-dispatch-1",
      expectedOperationRowVersion: 2,
      reconciledAt: T7,
    });

    expect(result.reconciliationResult.outcome).toBe("INDETERMINATE");
    expect(result.operation.reconciliationStatus).toBe("RECONCILED");
    expect(result.operation.reconciliationOutcome).toBe("INDETERMINATE");
  });
});
