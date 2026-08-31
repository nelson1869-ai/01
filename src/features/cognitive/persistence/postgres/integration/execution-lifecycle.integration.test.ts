import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createInitialExecutionSafetyState,
  isAllowedExecutionSafetyState,
  type ExecutionSafetyState,
} from "../../../domain/execution-safety";
import { assertLiveExecutionAuthorization } from "../../../orchestration/execution-authorization-guard";
import { orchestrateAuthorizationIssuance } from "../../../orchestration/authorization-orchestrator";
import {
  completeExecutionStep,
  failExecutionStep,
  finalizeExecutionFailure,
  finalizeExecutionIfComplete,
  recordOperationFailed,
  recordOperationSucceeded,
  recordOperationUnknown,
} from "../../../orchestration/execution-outcome-orchestrator";
import { prepareAuthorizedExecution } from "../../../orchestration/execution-preparation-orchestrator";
import {
  beginAuthorizedOperationAttempt,
  findReadyExecutionSteps,
  reserveAuthorizedExecutionOperation,
  startAuthorizedExecution,
  startAuthorizedExecutionStep,
} from "../../../orchestration/execution-progress-orchestrator";
import type { AuthorizationIssuanceCommand } from "../../contracts/authorization-issuance-command";
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

const T0 = "2026-08-31T02:00:00.000Z";
const T1 = "2026-08-31T02:01:00.000Z";
const T2 = "2026-08-31T02:02:00.000Z";
const T3 = "2026-08-31T02:03:00.000Z";
const T4 = "2026-08-31T02:04:00.000Z";
const T5 = "2026-08-31T02:05:00.000Z";
const T6 = "2026-08-31T02:06:00.000Z";
const T7 = "2026-08-31T02:07:00.000Z";

describe("live PostgreSQL durable execution lifecycle integration tests", () => {
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

  async function seedAuthorizedPlan(params?: {
    readonly steps?: readonly {
      stepId: string;
      ordinal: number;
      description: string;
    }[];
    readonly dependencies?: readonly {
      stepId: string;
      dependsOnStepId: string;
    }[];
    readonly mismatchedPlanCandidate?: boolean;
  }) {
    const cueId = "cue-lifecycle";
    const sessionId = "session-lifecycle";
    const candidateId = "candidate-lifecycle";
    const planCandidateId = params?.mismatchedPlanCandidate
      ? "candidate-other"
      : candidateId;
    const groundingResultId = "grounding-lifecycle";
    const policyDecisionId = "policy-lifecycle";
    const planId = "plan-lifecycle";
    const executionId = "execution-lifecycle";
    const steps = params?.steps ?? [
      { stepId: "step-1", ordinal: 0, description: "Synthetic step one" },
    ];
    const dependencies = params?.dependencies ?? [];

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "event-lifecycle",
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
      goal: "Exercise durable execution state",
      action: "synthetic.operation",
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

    if (planCandidateId !== candidateId) {
      await candidateRepository.appendCandidate(context.db, {
        ...candidate,
        candidateId: planCandidateId,
        scoreFormulaVersion: "v1-other",
      });
    }

    const grounding: PersistedGroundingResult = {
      groundingResultId,
      candidateId,
      evaluationKey: "grounding-evaluation-lifecycle",
      status: "VERIFIED",
      confidence: 0.98,
      reason: "Synthetic evidence is verified for the test boundary.",
      evaluatorVersion: "v1",
      evidenceIds: [],
      evaluatedAt: T2,
    };
    await groundingRepository.appendGroundingResult(context.db, grounding);

    const policy: PersistedPolicyDecision = {
      policyDecisionId,
      candidateId,
      groundingResultId,
      evaluationKey: "policy-evaluation-lifecycle",
      outcome: "ALLOW",
      reason: "Synthetic operation is allowed by test policy.",
      policyEngineVersion: "v1",
      policyIds: ["policy-test"],
      evaluatedAt: T3,
    };
    await policyRepository.appendPolicyDecision(context.db, policy);

    await planRepository.appendPlan(context.db, {
      planId,
      candidateId: planCandidateId,
      planGeneration: 1,
      steps,
      dependencies,
      createdAt: T3,
    });

    const authorizationCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "authorize:lifecycle:1",
      sessionId,
      candidateId,
      groundingResultId,
      policyDecisionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 0,
      safetyEventId: "safety-event-authorize-lifecycle",
      safetyEventKey: "safety:authorize:lifecycle:1",
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

  async function prepare(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
    overrides?: Partial<Parameters<typeof prepareAuthorizedExecution>[2]>,
  ) {
    return await prepareAuthorizedExecution(context.db, fixture.authorization, {
      commandIdempotencyKey: "prepare:lifecycle:1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      expectedSessionRowVersion: fixture.session.rowVersion,
      expectedSafetyGeneration: fixture.generation,
      createdAt: T5,
      ...overrides,
    });
  }

  async function startExecution(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
    overrides?: Partial<Parameters<typeof startAuthorizedExecution>[2]>,
  ) {
    return await startAuthorizedExecution(context.db, fixture.authorization, {
      commandIdempotencyKey: "start-execution:lifecycle:1",
      executionEventId: "execution-event-start-lifecycle",
      eventKey: "execution:start:lifecycle:1",
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      planId: fixture.planId,
      expectedExecutionRowVersion: 0,
      expectedSafetyGeneration: fixture.generation,
      startedAt: T6,
      reason: "Synthetic authorized execution start.",
      ...overrides,
    });
  }

  async function prepareAndStart(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
  ) {
    await prepare(fixture);
    return await startExecution(fixture);
  }

  async function startStep(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
    params?: {
      readonly stepId?: string;
      readonly expectedExecutionRowVersion?: number;
      readonly expectedStepRowVersion?: number;
      readonly commandKey?: string;
      readonly eventId?: string;
      readonly eventKey?: string;
    },
  ) {
    const stepId = params?.stepId ?? fixture.steps[0].stepId;
    return await startAuthorizedExecutionStep(
      context.db,
      fixture.authorization,
      {
        commandIdempotencyKey:
          params?.commandKey ?? `start-step:${stepId}:lifecycle:1`,
        executionEventId: params?.eventId ?? `execution-event-start-${stepId}`,
        eventKey: params?.eventKey ?? `execution:start:${stepId}:1`,
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        stepId,
        expectedExecutionRowVersion: params?.expectedExecutionRowVersion ?? 1,
        expectedStepRowVersion: params?.expectedStepRowVersion ?? 0,
        expectedSafetyGeneration: fixture.generation,
        startedAt: T7,
        reason: `Synthetic authorized start for ${stepId}.`,
      },
    );
  }

  async function reserve(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
    overrides?: Partial<
      Parameters<typeof reserveAuthorizedExecutionOperation>[2]
    >,
  ) {
    return await reserveAuthorizedExecutionOperation(
      context.db,
      fixture.authorization,
      {
        commandIdempotencyKey: "operation:lifecycle:step-1:1",
        operationId: "operation-lifecycle",
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        stepId: fixture.steps[0].stepId,
        operationGeneration: 1,
        expectedStepRowVersion: 1,
        expectedSafetyGeneration: fixture.generation,
        operationKind: "synthetic.operation",
        requestFingerprint: "sha256:synthetic-request-v1",
        providerScope: null,
        providerIdempotencyKey: null,
        createdAt: T7,
        ...overrides,
      },
    );
  }

  async function prepareStartStepAndReserve(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
  ) {
    await prepareAndStart(fixture);
    await startStep(fixture);
    return await reserve(fixture);
  }

  async function beginAttempt(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
    overrides?: Partial<Parameters<typeof beginAuthorizedOperationAttempt>[2]>,
  ) {
    return await beginAuthorizedOperationAttempt(
      context.db,
      fixture.authorization,
      {
        commandIdempotencyKey: "begin-attempt:lifecycle:1",
        attemptId: "attempt-lifecycle-1",
        operationId: "operation-lifecycle",
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        stepId: fixture.steps[0].stepId,
        expectedOperationRowVersion: 0,
        expectedSafetyGeneration: fixture.generation,
        workerId: "worker-synthetic",
        startedAt: T7,
        ...overrides,
      },
    );
  }

  async function fullInFlight(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
  ) {
    await prepareStartStepAndReserve(fixture);
    return await beginAttempt(fixture);
  }

  it("1. prepares one PENDING execution, all PENDING steps, and advances session", async () => {
    const fixture = await seedAuthorizedPlan({
      steps: [
        { stepId: "step-1", ordinal: 0, description: "First" },
        { stepId: "step-2", ordinal: 1, description: "Second" },
      ],
    });
    const result = await prepare(fixture);
    const session = await sessionRepository.findSessionById(
      context.db,
      fixture.sessionId,
    );
    expect(result.execution.status).toBe("PENDING");
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((step) => step.status === "PENDING")).toBe(true);
    expect(session).toMatchObject({
      phase: "DURABLE_EXECUTION",
      currentPlanId: fixture.planId,
      currentExecutionId: fixture.executionId,
    });
  });

  it("2. rejects a plan candidate mismatch without creating execution", async () => {
    const fixture = await seedAuthorizedPlan({ mismatchedPlanCandidate: true });
    await expect(prepare(fixture)).rejects.toThrow(PersistenceError);
    expect(
      await executionRepository.findExecutionById(
        context.db,
        fixture.executionId,
      ),
    ).toBeNull();
  });

  it("3. rejects forged authorization without creating execution", async () => {
    const fixture = await seedAuthorizedPlan();
    const forged = {
      status: "ALLOWED",
      generation: fixture.generation,
      candidateId: fixture.candidateId,
      failure: null,
      reason: null,
      blockedAt: null,
    } as unknown as ExecutionSafetyState;
    await expect(
      prepareAuthorizedExecution(context.db, forged, {
        commandIdempotencyKey: "prepare:forged",
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        expectedSessionRowVersion: fixture.session.rowVersion,
        expectedSafetyGeneration: fixture.generation,
        createdAt: T5,
      }),
    ).rejects.toThrow(PersistenceError);
    expect(
      await executionRepository.findExecutionById(
        context.db,
        fixture.executionId,
      ),
    ).toBeNull();
  });

  it("4. rejects stale safety generation without creating execution", async () => {
    const fixture = await seedAuthorizedPlan();
    await context.db.execute(sql`
      UPDATE execution_safety_state
      SET generation = ${fixture.generation + 1}, durable_status = 'BLOCKED',
          failure_code = 'HALLUCINATION_DETECTED', reason = 'Revoked',
          blocked_at = ${T5}, updated_at = ${T5}
      WHERE session_id = ${fixture.sessionId}
    `);
    await expect(prepare(fixture)).rejects.toThrow(PersistenceError);
    expect(
      await executionRepository.findExecutionById(
        context.db,
        fixture.executionId,
      ),
    ).toBeNull();
  });

  it("5. replays preparation without duplicate execution, steps, or session update", async () => {
    const fixture = await seedAuthorizedPlan();
    const first = await prepare(fixture);
    const replay = await prepare(fixture);
    const session = await sessionRepository.findSessionById(
      context.db,
      fixture.sessionId,
    );
    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);
    expect(replay).not.toHaveProperty("authorization");
    expect(session?.rowVersion).toBe(fixture.session.rowVersion + 1);
    const counts = await context.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM executions) AS executions,
        (SELECT count(*)::int FROM execution_step_state) AS steps
    `);
    expect(counts.rows[0]).toMatchObject({ executions: 1, steps: 1 });
  });

  it("6. concurrent same preparation creates exactly one durable preparation", async () => {
    const fixture = await seedAuthorizedPlan();
    const results = await Promise.all([prepare(fixture), prepare(fixture)]);
    expect(results.filter((result) => !result.isReplay)).toHaveLength(1);
    expect(results.filter((result) => result.isReplay)).toHaveLength(1);
  });

  it("7. starts PENDING execution with exact safetyGenerationAtStart", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepare(fixture);
    const result = await startExecution(fixture);
    expect(result.execution).toMatchObject({
      status: "RUNNING",
      rowVersion: 1,
      safetyGenerationAtStart: fixture.generation,
    });
  });

  it("8. rejects execution start with stale runtime generation", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepare(fixture);
    await context.db.execute(sql`
      UPDATE execution_safety_state
      SET generation = ${fixture.generation + 1}, durable_status = 'BLOCKED',
          failure_code = 'EXECUTION_TIMEOUT', reason = 'Revoked',
          blocked_at = ${T6}, updated_at = ${T6}
      WHERE session_id = ${fixture.sessionId}
    `);
    await expect(startExecution(fixture)).rejects.toThrow(PersistenceError);
  });

  it("9. cannot start through trusted API without a live capability", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepare(fixture);
    await expect(
      startAuthorizedExecution(
        context.db,
        createInitialExecutionSafetyState(),
        {
          commandIdempotencyKey: "start:no-capability",
          executionEventId: "event:no-capability",
          eventKey: "event-key:no-capability",
          executionId: fixture.executionId,
          sessionId: fixture.sessionId,
          planId: fixture.planId,
          expectedExecutionRowVersion: 0,
          expectedSafetyGeneration: fixture.generation,
          startedAt: T6,
          reason: "Must fail closed.",
        },
      ),
    ).rejects.toThrow(PersistenceError);
  });

  it("10. concurrent execution start produces one RUNNING transition", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepare(fixture);
    const outcomes = await Promise.allSettled([
      startExecution(fixture, {
        commandIdempotencyKey: "start:worker-a",
        executionEventId: "event:start:worker-a",
        eventKey: "event-key:start:worker-a",
      }),
      startExecution(fixture, {
        commandIdempotencyKey: "start:worker-b",
        executionEventId: "event:start:worker-b",
        eventKey: "event-key:start:worker-b",
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const events = await context.db.execute(
      sql`SELECT count(*)::int AS count FROM execution_events`,
    );
    expect(events.rows[0]).toMatchObject({ count: 1 });
  });

  it("11. finds a dependency-free PENDING step ready", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepare(fixture);
    const ready = await findReadyExecutionSteps(context.db, fixture);
    expect(ready.map((step) => step.stepId)).toEqual(["step-1"]);
  });

  it("12. does not ready a step with an unsatisfied dependency", async () => {
    const fixture = await seedAuthorizedPlan({
      steps: [
        { stepId: "parent", ordinal: 0, description: "Parent" },
        { stepId: "child", ordinal: 1, description: "Child" },
      ],
      dependencies: [{ stepId: "child", dependsOnStepId: "parent" }],
    });
    await prepare(fixture);
    const ready = await findReadyExecutionSteps(context.db, fixture);
    expect(ready.map((step) => step.stepId)).toEqual(["parent"]);
  });

  it("13. readies dependent step after dependency becomes SUCCEEDED", async () => {
    const fixture = await seedAuthorizedPlan({
      steps: [
        { stepId: "parent", ordinal: 0, description: "Parent" },
        { stepId: "child", ordinal: 1, description: "Child" },
      ],
      dependencies: [{ stepId: "child", dependsOnStepId: "parent" }],
    });
    await prepare(fixture);
    await context.db.execute(sql`
      UPDATE execution_step_state
      SET status = 'SUCCEEDED', started_at = ${T6}, completed_at = ${T7},
          row_version = 2, updated_at = ${T7}
      WHERE execution_id = ${fixture.executionId} AND step_id = 'parent'
    `);
    const ready = await findReadyExecutionSteps(context.db, fixture);
    expect(ready.map((step) => step.stepId)).toEqual(["child"]);
  });

  it("14. starts a ready PENDING step", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    const result = await startStep(fixture);
    expect(result.step).toMatchObject({ status: "RUNNING", rowVersion: 1 });
    expect(result.execution.currentStepId).toBeNull();
  });

  it("15. concurrent start of the same step has exactly one winner", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    const outcomes = await Promise.allSettled([
      startStep(fixture, {
        commandKey: "start-step:worker-a",
        eventId: "event:step:worker-a",
        eventKey: "event-key:step:worker-a",
      }),
      startStep(fixture, {
        commandKey: "start-step:worker-b",
        eventId: "event:step:worker-b",
        eventKey: "event-key:step:worker-b",
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
  });

  it("16. rejects stale capability after safety revocation before step start", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await context.db.execute(sql`
      UPDATE execution_safety_state
      SET generation = ${fixture.generation + 1}, durable_status = 'BLOCKED',
          failure_code = 'EXECUTION_TIMEOUT', reason = 'Revoked before step',
          blocked_at = ${T7}, updated_at = ${T7}
      WHERE session_id = ${fixture.sessionId}
    `);
    await expect(startStep(fixture)).rejects.toThrow(PersistenceError);
  });

  it("17. reserves one PENDING operation for a RUNNING step", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await startStep(fixture);
    const result = await reserve(fixture);
    expect(result.operation).toMatchObject({
      status: "PENDING",
      operationGeneration: 1,
      attemptCount: 0,
    });
  });

  it("18. rejects operation generation mismatch", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await startStep(fixture);
    await expect(reserve(fixture, { operationGeneration: 2 })).rejects.toThrow(
      PersistenceError,
    );
  });

  it("19. replays identical operation reservation as one logical operation", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await startStep(fixture);
    const first = await reserve(fixture);
    const replay = await reserve(fixture);
    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);
    const rows = await context.db.execute(
      sql`SELECT count(*)::int AS count FROM execution_operations`,
    );
    expect(rows.rows[0]).toMatchObject({ count: 1 });
  });

  it("20. rejects different request on the same logical operation identity", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await startStep(fixture);
    await reserve(fixture);
    await expect(
      reserve(fixture, {
        commandIdempotencyKey: "operation:different-key",
        operationId: "operation-different-id",
        requestFingerprint: "sha256:different-request",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("21. begins attempt #1 and moves PENDING operation to IN_FLIGHT", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartStepAndReserve(fixture);
    const result = await beginAttempt(fixture);
    expect(result.operation).toMatchObject({
      status: "IN_FLIGHT",
      attemptCount: 1,
      rowVersion: 1,
    });
    expect(result.attempt).toMatchObject({
      status: "IN_FLIGHT",
      attemptNumber: 1,
    });
  });

  it("22. concurrent begin-attempt has exactly one winner", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartStepAndReserve(fixture);
    const outcomes = await Promise.allSettled([
      beginAttempt(fixture, {
        commandIdempotencyKey: "begin:worker-a",
        attemptId: "attempt-worker-a",
      }),
      beginAttempt(fixture, {
        commandIdempotencyKey: "begin:worker-b",
        attemptId: "attempt-worker-b",
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rows = await context.db.execute(
      sql`SELECT count(*)::int AS count FROM execution_operation_attempts`,
    );
    expect(rows.rows[0]).toMatchObject({ count: 1 });
  });

  it("23. records deterministic SUCCEEDED operation and finished attempt", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    const result = await recordOperationSucceeded(context.db, {
      commandIdempotencyKey: "outcome:success",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "SUCCEEDED",
      finishedAt: T7,
    });
    expect(result.operation.status).toBe("SUCCEEDED");
    expect(result.attempt.status).toBe("SUCCEEDED");
  });

  it("24. records deterministic FAILED operation with durable error", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    const result = await recordOperationFailed(context.db, {
      commandIdempotencyKey: "outcome:failed",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "FAILED",
      errorSummary: "Synthetic deterministic failure.",
      finishedAt: T7,
    });
    expect(result.operation.status).toBe("FAILED");
    expect(result.attempt.errorSummary).toBe(
      "Synthetic deterministic failure.",
    );
  });

  it("25. records UNKNOWN with uncertainty and reconciliation REQUIRED", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    const result = await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:unknown",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason:
        "Synthetic response was lost after possible acceptance.",
      finishedAt: T7,
    });
    expect(result.operation).toMatchObject({
      status: "UNKNOWN",
      reconciliationStatus: "REQUIRED",
      uncertaintyReason:
        "Synthetic response was lost after possible acceptance.",
    });
  });

  it("26. UNKNOWN operation does not mark its step FAILED", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:unknown",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Outcome requires reconciliation.",
      finishedAt: T7,
    });
    const step = await executionStepRepository.findStep(
      context.db,
      fixture.executionId,
      "step-1",
    );
    expect(step?.status).toBe("RUNNING");
  });

  it("27. completes step SUCCEEDED only after current operation SUCCEEDED", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    await recordOperationSucceeded(context.db, {
      commandIdempotencyKey: "outcome:success",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "SUCCEEDED",
      finishedAt: T7,
    });
    const result = await completeExecutionStep(context.db, {
      commandIdempotencyKey: "complete-step:1",
      executionEventId: "event:complete-step:1",
      eventKey: "event-key:complete-step:1",
      executionId: fixture.executionId,
      planId: fixture.planId,
      stepId: "step-1",
      operationGeneration: 1,
      expectedExecutionRowVersion: 2,
      expectedStepRowVersion: 1,
      completedAt: T7,
      reason: "Synthetic operation verified successful.",
    });
    expect(result.step.status).toBe("SUCCEEDED");
  });

  it("28. cannot complete step SUCCEEDED after operation FAILED", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    await recordOperationFailed(context.db, {
      commandIdempotencyKey: "outcome:failed",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "FAILED",
      errorSummary: "Deterministic failure.",
      finishedAt: T7,
    });
    await expect(
      completeExecutionStep(context.db, {
        commandIdempotencyKey: "complete-step:invalid",
        executionEventId: "event:complete-step:invalid",
        eventKey: "event-key:complete-step:invalid",
        executionId: fixture.executionId,
        planId: fixture.planId,
        stepId: "step-1",
        operationGeneration: 1,
        expectedExecutionRowVersion: 2,
        expectedStepRowVersion: 1,
        completedAt: T7,
        reason: "Must fail closed.",
      }),
    ).rejects.toThrow(PersistenceError);
  });

  it("29. marks step FAILED only after deterministic FAILED operation", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    await recordOperationFailed(context.db, {
      commandIdempotencyKey: "outcome:failed",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "FAILED",
      errorSummary: "Deterministic failure.",
      finishedAt: T7,
    });
    const result = await failExecutionStep(context.db, {
      commandIdempotencyKey: "fail-step:1",
      executionEventId: "event:fail-step:1",
      eventKey: "event-key:fail-step:1",
      executionId: fixture.executionId,
      planId: fixture.planId,
      stepId: "step-1",
      operationGeneration: 1,
      expectedExecutionRowVersion: 2,
      expectedStepRowVersion: 1,
      completedAt: T7,
      errorSummary: "Deterministic operation failure.",
    });
    expect(result.step).toMatchObject({
      status: "FAILED",
      error: "Deterministic operation failure.",
    });
  });

  it("30. finalizes execution SUCCEEDED only when every step SUCCEEDED", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    await recordOperationSucceeded(context.db, {
      commandIdempotencyKey: "outcome:success",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "SUCCEEDED",
      finishedAt: T7,
    });
    const completed = await completeExecutionStep(context.db, {
      commandIdempotencyKey: "complete-step:1",
      executionEventId: "event:complete-step:1",
      eventKey: "event-key:complete-step:1",
      executionId: fixture.executionId,
      planId: fixture.planId,
      stepId: "step-1",
      operationGeneration: 1,
      expectedExecutionRowVersion: 2,
      expectedStepRowVersion: 1,
      completedAt: T7,
      reason: "Successful operation.",
    });
    const result = await finalizeExecutionIfComplete(context.db, {
      commandIdempotencyKey: "finalize:success",
      executionEventId: "event:finalize:success",
      eventKey: "event-key:finalize:success",
      executionId: fixture.executionId,
      expectedExecutionRowVersion: completed.execution.rowVersion,
      completedAt: T7,
      reason: "All steps succeeded.",
    });
    expect(result.execution.status).toBe("SUCCEEDED");
  });

  it("31. finalizes execution FAILED when at least one step FAILED", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    await recordOperationFailed(context.db, {
      commandIdempotencyKey: "outcome:failed",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "FAILED",
      errorSummary: "Deterministic failure.",
      finishedAt: T7,
    });
    const failed = await failExecutionStep(context.db, {
      commandIdempotencyKey: "fail-step:1",
      executionEventId: "event:fail-step:1",
      eventKey: "event-key:fail-step:1",
      executionId: fixture.executionId,
      planId: fixture.planId,
      stepId: "step-1",
      operationGeneration: 1,
      expectedExecutionRowVersion: 2,
      expectedStepRowVersion: 1,
      completedAt: T7,
      errorSummary: "Deterministic operation failure.",
    });
    const result = await finalizeExecutionFailure(context.db, {
      commandIdempotencyKey: "finalize:failed",
      executionEventId: "event:finalize:failed",
      eventKey: "event-key:finalize:failed",
      executionId: fixture.executionId,
      expectedExecutionRowVersion: failed.execution.rowVersion,
      completedAt: T7,
      errorSummary: "Execution contains a failed step.",
    });
    expect(result.execution).toMatchObject({
      status: "FAILED",
      error: "Execution contains a failed step.",
    });
  });

  it("32. execution events use unique monotonically ordered row-version sequences", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await startStep(fixture);
    const events = await context.db.execute(sql`
      SELECT transition_sequence FROM execution_events
      WHERE execution_id = ${fixture.executionId}
      ORDER BY transition_sequence
    `);
    expect(events.rows.map((row) => Number(row.transition_sequence))).toEqual([
      1, 2,
    ]);
  });

  it("33. event insert conflict rolls back its parent step transition", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await expect(
      startStep(fixture, { eventKey: "execution:start:lifecycle:1" }),
    ).rejects.toThrow();
    const [step, execution] = await Promise.all([
      executionStepRepository.findStep(
        context.db,
        fixture.executionId,
        "step-1",
      ),
      executionRepository.findExecutionById(context.db, fixture.executionId),
    ]);
    expect(step?.status).toBe("PENDING");
    expect(execution?.rowVersion).toBe(1);
  });

  it("34. stale execution rowVersion rolls back start", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepare(fixture);
    await expect(
      startExecution(fixture, { expectedExecutionRowVersion: 99 }),
    ).rejects.toThrow(PersistenceError);
    expect(
      (
        await executionRepository.findExecutionById(
          context.db,
          fixture.executionId,
        )
      )?.status,
    ).toBe("PENDING");
  });

  it("35. stale step rowVersion rolls back step start", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await expect(
      startStep(fixture, { expectedStepRowVersion: 99 }),
    ).rejects.toThrow(PersistenceError);
    expect(
      (
        await executionStepRepository.findStep(
          context.db,
          fixture.executionId,
          "step-1",
        )
      )?.status,
    ).toBe("PENDING");
  });

  it("36. stale operation rowVersion rolls back outcome", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);
    await expect(
      recordOperationSucceeded(context.db, {
        commandIdempotencyKey: "outcome:stale",
        operationId: "operation-lifecycle",
        attemptId: "attempt-lifecycle-1",
        expectedOperationRowVersion: 99,
        outcome: "SUCCEEDED",
        finishedAt: T7,
      }),
    ).rejects.toThrow(PersistenceError);
    expect(
      (
        await executionOperationRepository.findOperationById(
          context.db,
          "operation-lifecycle",
        )
      )?.status,
    ).toBe("IN_FLIGHT");
  });

  async function blockRunningExecution(
    fixture: Awaited<ReturnType<typeof seedAuthorizedPlan>>,
  ) {
    const session = await sessionRepository.findSessionById(
      context.db,
      fixture.sessionId,
    );
    const execution = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );
    if (!session || !execution) {
      throw new Error("Expected durable session and execution before failure.");
    }
    return await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "failure:lifecycle:1",
      sessionId: fixture.sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: fixture.generation,
      failure: "EXECUTION_TIMEOUT",
      reason: "Synthetic timeout during durable execution.",
      evidenceIds: [],
      auditEventId: "audit:lifecycle:1",
      safetyEventId: "safety-event:failure:lifecycle:1",
      safetyEventKey: "safety-key:failure:lifecycle:1",
      candidateId: fixture.candidateId,
      planId: fixture.planId,
      activeExecution: {
        executionId: fixture.executionId,
        expectedExecutionRowVersion: execution.rowVersion,
        expectedStatus: "RUNNING",
        executionEventId: "execution-event:blocked:lifecycle:1",
        executionEventKey: "execution-key:blocked:lifecycle:1",
      },
      createdAt: T7,
    });
  }

  it("37. failure recovery BLOCKS running execution and preserves prior event history", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    const result = await blockRunningExecution(fixture);
    expect(result.blockedExecution?.status).toBe("BLOCKED");
    const events = await context.db.execute(sql`
      SELECT to_status FROM execution_events
      WHERE execution_id = ${fixture.executionId}
      ORDER BY transition_sequence
    `);
    expect(events.rows.map((row) => row.to_status)).toEqual([
      "RUNNING",
      "BLOCKED",
    ]);
  });

  it("38. no new step starts after execution is BLOCKED", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await blockRunningExecution(fixture);
    await expect(
      startStep(fixture, { expectedExecutionRowVersion: 2 }),
    ).rejects.toThrow(PersistenceError);
  });

  it("39. restart reloads durable state but cannot reconstruct authorization", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartStepAndReserve(fixture);
    const [execution, step, operation, safety] = await Promise.all([
      executionRepository.findExecutionById(context.db, fixture.executionId),
      executionStepRepository.findStep(
        context.db,
        fixture.executionId,
        "step-1",
      ),
      executionOperationRepository.findOperationById(
        context.db,
        "operation-lifecycle",
      ),
      safetyRepository.findSafetyStateBySessionId(
        context.db,
        fixture.sessionId,
      ),
    ]);
    expect(execution?.status).toBe("RUNNING");
    expect(step?.status).toBe("RUNNING");
    expect(operation?.status).toBe("PENDING");
    expect(safety?.status).toBe("UNAUTHORIZED");
    if (!safety) {
      throw new Error("Expected stored safety state.");
    }
    const restored = mapStoredSafetyToDomain(safety);
    expect(isAllowedExecutionSafetyState(restored)).toBe(false);
    expect(() =>
      assertLiveExecutionAuthorization(restored, safety.generation),
    ).toThrow();
  });

  it("40. fresh process without capability cannot progress operation toward side effect", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareStartStepAndReserve(fixture);
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      fixture.sessionId,
    );
    if (!safety) {
      throw new Error("Expected stored safety state.");
    }
    await expect(
      beginAuthorizedOperationAttempt(
        context.db,
        mapStoredSafetyToDomain(safety),
        {
          commandIdempotencyKey: "begin:no-capability",
          attemptId: "attempt:no-capability",
          operationId: "operation-lifecycle",
          executionId: fixture.executionId,
          sessionId: fixture.sessionId,
          planId: fixture.planId,
          stepId: "step-1",
          expectedOperationRowVersion: 0,
          expectedSafetyGeneration: fixture.generation,
          workerId: null,
          startedAt: T7,
        },
      ),
    ).rejects.toThrow(PersistenceError);
    expect(
      (
        await executionOperationRepository.findOperationById(
          context.db,
          "operation-lifecycle",
        )
      )?.status,
    ).toBe("PENDING");
  });

  it("41. composite foreign key rejects an operation not bound to durable step state", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);
    await expect(
      context.db.execute(sql`
        INSERT INTO execution_operations (
          operation_id, execution_id, step_id, operation_generation,
          operation_kind, operation_idempotency_key, request_fingerprint,
          status, attempt_count, reconciliation_status, row_version,
          created_at, updated_at
        ) VALUES (
          'operation-unbound', ${fixture.executionId}, 'step-not-in-execution', 1,
          'synthetic.operation', 'operation:unbound', 'sha256:unbound',
          'PENDING', 0, 'NOT_REQUIRED', 0, ${T7}, ${T7}
        )
      `),
    ).rejects.toThrow();
  });

  it("42. records operation outcome after safety revocation and execution BLOCKED without initiating new actions", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);

    // Safety is revoked and execution is BLOCKED while operation is in flight
    await blockRunningExecution(fixture);

    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      fixture.sessionId,
    );
    const execution = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );
    expect(safety?.status).toBe("BLOCKED");
    expect(execution?.status).toBe("BLOCKED");

    // Provider response arrives with factual outcome (e.g. SUCCEEDED or UNKNOWN)
    const result = await recordOperationSucceeded(context.db, {
      commandIdempotencyKey: "outcome:after-revocation",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "SUCCEEDED",
      finishedAt: T7,
    });

    expect(result.operation.status).toBe("SUCCEEDED");
    expect(result.attempt.status).toBe("SUCCEEDED");

    // Verifies that outcome recording did not resurrect execution or allow new progression
    const reloadedExec = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );
    expect(reloadedExec?.status).toBe("BLOCKED");

    // Step completion is blocked because execution is not RUNNING
    await expect(
      completeExecutionStep(context.db, {
        commandIdempotencyKey: "complete:after-revocation",
        executionEventId: "event:complete:after-revocation",
        eventKey: "event-key:complete:after-revocation",
        executionId: fixture.executionId,
        planId: fixture.planId,
        stepId: "step-1",
        operationGeneration: 1,
        expectedExecutionRowVersion: 2,
        expectedStepRowVersion: 1,
        completedAt: T7,
        reason: "Must fail closed.",
      }),
    ).rejects.toThrow(PersistenceError);
  });

  it("43. parallel DAG steps serialize event sequence and permit unblocked worker retry", async () => {
    const fixture = await seedAuthorizedPlan({
      steps: [
        { stepId: "step-parallel-a", ordinal: 0, description: "Parallel A" },
        { stepId: "step-parallel-b", ordinal: 1, description: "Parallel B" },
      ],
    });
    await prepareAndStart(fixture);

    // Both steps are dependency-free and ready
    const ready = await findReadyExecutionSteps(context.db, fixture);
    expect(ready.map((s) => s.stepId)).toEqual([
      "step-parallel-a",
      "step-parallel-b",
    ]);

    // Worker 1 starts step-parallel-a at execution rowVersion 1
    const startA = await startStep(fixture, {
      stepId: "step-parallel-a",
      expectedExecutionRowVersion: 1,
      expectedStepRowVersion: 0,
      commandKey: "start-step:parallel-a",
      eventId: "event:parallel-a",
      eventKey: "event-key:parallel-a",
    });
    expect(startA.step.status).toBe("RUNNING");
    expect(startA.execution.rowVersion).toBe(2);

    // Worker 2 attempting step-parallel-b with stale execution rowVersion 1 fails with STALE_WRITE
    await expect(
      startStep(fixture, {
        stepId: "step-parallel-b",
        expectedExecutionRowVersion: 1,
        expectedStepRowVersion: 0,
        commandKey: "start-step:parallel-b-stale",
        eventId: "event:parallel-b-stale",
        eventKey: "event-key:parallel-b-stale",
      }),
    ).rejects.toMatchObject({ code: "STALE_WRITE" });

    // Step B remains uncorrupted and PENDING
    const stepB = await executionStepRepository.findStep(
      context.db,
      fixture.executionId,
      "step-parallel-b",
    );
    expect(stepB?.status).toBe("PENDING");
    expect(stepB?.rowVersion).toBe(0);

    // Worker 2 retries with refreshed execution rowVersion 2
    const startB = await startStep(fixture, {
      stepId: "step-parallel-b",
      expectedExecutionRowVersion: 2,
      expectedStepRowVersion: 0,
      commandKey: "start-step:parallel-b",
      eventId: "event:parallel-b",
      eventKey: "event-key:parallel-b",
    });
    expect(startB.step.status).toBe("RUNNING");
    expect(startB.execution.rowVersion).toBe(3);

    // Both steps are RUNNING and events are linearized monotonically
    const events = await context.db.execute(sql`
      SELECT transition_sequence, step_id, to_status FROM execution_events
      WHERE execution_id = ${fixture.executionId}
      ORDER BY transition_sequence
    `);
    expect(
      events.rows.map((row) => ({
        transitionSequence: Number(row.transition_sequence),
        stepId: row.step_id,
        toStatus: row.to_status,
      })),
    ).toEqual([
      { transitionSequence: 1, stepId: null, toStatus: "RUNNING" },
      {
        transitionSequence: 2,
        stepId: "step-parallel-a",
        toStatus: "RUNNING",
      },
      {
        transitionSequence: 3,
        stepId: "step-parallel-b",
        toStatus: "RUNNING",
      },
    ]);
  });

  it("44. composite foreign key rejects step state referencing mismatched execution plan", async () => {
    const fixture = await seedAuthorizedPlan();
    await prepareAndStart(fixture);

    // Insert an alternate candidate and action plan
    await candidateRepository.appendCandidate(context.db, {
      candidateId: "candidate-other",
      sessionId: fixture.sessionId,
      cueId: fixture.cueId,
      evaluationGeneration: 1,
      goal: "Other goal",
      action: "synthetic.other",
      confidence: 0.9,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.1,
      scoreValue: 0.9,
      recommendation: "PROCEED",
      scoreFormulaVersion: "v1-other",
      evidenceIds: [],
      createdAt: T4,
    });
    await planRepository.appendPlan(context.db, {
      planId: "plan-other",
      candidateId: "candidate-other",
      planGeneration: 1,
      steps: [{ stepId: "step-other", ordinal: 0, description: "Other step" }],
      dependencies: [],
      createdAt: T4,
    });

    // Attempt to insert execution_step_state with executionId and mismatched planId
    await expect(
      context.db.execute(sql`
        INSERT INTO execution_step_state (
          execution_id, plan_id, step_id, status, operation_generation,
          row_version, updated_at
        ) VALUES (
          ${fixture.executionId}, 'plan-other', 'step-other', 'PENDING', 1,
          0, ${T7}
        )
      `),
    ).rejects.toThrow();
  });

  it("45. concurrent outcome recording provides exactly one winner and idempotent replay", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);

    // Concurrent outcome recording with the SAME idempotency key
    const replayOutcomes = await Promise.all([
      recordOperationSucceeded(context.db, {
        commandIdempotencyKey: "outcome:conc-same",
        operationId: "operation-lifecycle",
        attemptId: "attempt-lifecycle-1",
        expectedOperationRowVersion: 1,
        outcome: "SUCCEEDED",
        finishedAt: T7,
      }),
      recordOperationSucceeded(context.db, {
        commandIdempotencyKey: "outcome:conc-same",
        operationId: "operation-lifecycle",
        attemptId: "attempt-lifecycle-1",
        expectedOperationRowVersion: 1,
        outcome: "SUCCEEDED",
        finishedAt: T7,
      }),
    ]);
    expect(replayOutcomes.filter((r) => !r.isReplay)).toHaveLength(1);
    expect(replayOutcomes.filter((r) => r.isReplay)).toHaveLength(1);

    // Another caller with DIFFERENT idempotency key gets rejected (operation is already terminal, rowVersion 2)
    await expect(
      recordOperationFailed(context.db, {
        commandIdempotencyKey: "outcome:conc-different",
        operationId: "operation-lifecycle",
        attemptId: "attempt-lifecycle-1",
        expectedOperationRowVersion: 1,
        outcome: "FAILED",
        errorSummary: "Late failure report.",
        finishedAt: T7,
      }),
    ).rejects.toMatchObject({ code: "STALE_WRITE" });
  });

  it("46. client restart can record in-flight outcome without capability but blocks new progression", async () => {
    const fixture = await seedAuthorizedPlan();
    await fullInFlight(fixture);

    // Simulate complete client restart: all in-memory capabilities lost.
    // Durable state reloaded from database.
    const storedSafety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      fixture.sessionId,
    );
    expect(storedSafety).not.toBeNull();
    const unauthenticatedDomainSafety = mapStoredSafetyToDomain(storedSafety!);

    // Rehydrated domain safety is UNAUTHORIZED and has no private brand
    expect(isAllowedExecutionSafetyState(unauthenticatedDomainSafety)).toBe(
      false,
    );

    // Attempting any NEW progression (e.g. reserve another operation) fails closed
    await expect(
      reserveAuthorizedExecutionOperation(
        context.db,
        unauthenticatedDomainSafety,
        {
          commandIdempotencyKey: "op:restart:new",
          operationId: "operation-restart-new",
          executionId: fixture.executionId,
          sessionId: fixture.sessionId,
          planId: fixture.planId,
          stepId: fixture.steps[0].stepId,
          operationGeneration: 1,
          expectedStepRowVersion: 1,
          expectedSafetyGeneration: fixture.generation,
          operationKind: "synthetic.operation",
          requestFingerprint: "sha256:restart-req",
          providerScope: null,
          providerIdempotencyKey: null,
          createdAt: T7,
        },
      ),
    ).rejects.toThrow(PersistenceError);

    // BUT recording the in-flight outcome from the provider response succeeds without capability
    const recorded = await recordOperationUnknown(context.db, {
      commandIdempotencyKey: "outcome:restart:unknown",
      operationId: "operation-lifecycle",
      attemptId: "attempt-lifecycle-1",
      expectedOperationRowVersion: 1,
      outcome: "UNKNOWN",
      uncertaintyReason: "Provider connection dropped across client restart.",
      finishedAt: T7,
    });
    expect(recorded.operation.status).toBe("UNKNOWN");
    expect(recorded.operation.reconciliationStatus).toBe("REQUIRED");
  });
});
