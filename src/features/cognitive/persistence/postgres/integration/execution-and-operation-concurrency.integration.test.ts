import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PersistedExecutionOperation } from "../../contracts/execution-operation";
import type { PostgresDatabaseContext } from "../client";
import { PersistenceError } from "../errors/persistence-errors";
import { executionOperationRepository } from "../repositories/execution-operation-repository";
import { executionRepository } from "../repositories/execution-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";

describe("live PostgreSQL execution and operation concurrency tests", () => {
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

  async function seedExecutionFixture(params: {
    cueId: string;
    sessionId: string;
    candidateId: string;
    groundingId: string;
    policyId: string;
    planId: string;
    executionId: string;
    safetyGeneration?: number;
  }) {
    const safetyGen = params.safetyGeneration ?? 0;

    await context.db.execute(sql`
      INSERT INTO cues (cue_id, source, external_event_id, cue_type, occurred_at, received_at, payload, payload_hash)
      VALUES (${params.cueId}, 'test', ${params.cueId}, 'user.action', NOW(), NOW(), '{}', 'hash')
    `);

    await context.db.execute(sql`
      INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
      VALUES (${params.sessionId}, ${params.cueId}, 'PLAN', 0, 0, 2, 0, NOW(), NOW())
    `);

    await context.db.execute(sql`
      INSERT INTO execution_safety_state (session_id, generation, durable_status, reason, updated_at)
      VALUES (${params.sessionId}, ${safetyGen}, 'UNAUTHORIZED', 'Ready for evaluation', NOW())
    `);

    await context.db.execute(sql`
      INSERT INTO candidate_actions (
        candidate_id, session_id, cue_id, goal, action, confidence, expected_utility,
        estimated_risk, estimated_cost, score_value, recommendation, score_formula_version, created_at
      ) VALUES (
        ${params.candidateId}, ${params.sessionId}, ${params.cueId}, 'Execute step', 'test_action',
        0.9, 0.9, 0.1, 0.1, 0.9, 'PROCEED', 'v1', NOW()
      )
    `);

    await context.db.execute(sql`
      INSERT INTO action_plans (plan_id, candidate_id, plan_generation, created_at)
      VALUES (${params.planId}, ${params.candidateId}, 1, NOW())
    `);

    await context.db.execute(sql`
      INSERT INTO executions (execution_id, session_id, plan_id, status, row_version, created_at, updated_at)
      VALUES (${params.executionId}, ${params.sessionId}, ${params.planId}, 'PENDING', 0, NOW(), NOW())
    `);
  }

  it("Test 8: Stale Safety Generation Blocks Execution Start - database defense in depth", async () => {
    const fixture = {
      cueId: "cue-stale-safety",
      sessionId: "session-stale-safety",
      candidateId: "cand-stale-safety",
      groundingId: "ground-stale-safety",
      policyId: "policy-stale-safety",
      planId: "plan-stale-safety",
      executionId: "exec-stale-safety",
      safetyGeneration: 7,
    };

    await seedExecutionFixture(fixture);

    // Concurrently, a failure worker advances safety state to generation 8 (BLOCKED)
    await context.db.execute(sql`
      UPDATE execution_safety_state
      SET generation = 8, durable_status = 'BLOCKED', failure_code = 'EXECUTION_REJECTED', reason = 'Failure worker revoked authorization', blocked_at = NOW(), updated_at = NOW()
      WHERE session_id = ${fixture.sessionId}
    `);

    // Worker attempts to start execution believing safety generation is 7
    await expect(
      executionRepository.startExecution(context.db, {
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        expectedRowVersion: 0,
        expectedSafetyGeneration: 7,
        startedAt: "2026-08-30T11:00:00.000Z",
        commandIdempotencyKey: "start:exec:stale-test",
        reason: "Starting execution with stale token",
      }),
    ).rejects.toThrow(PersistenceError);

    try {
      await executionRepository.startExecution(context.db, {
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        expectedRowVersion: 0,
        expectedSafetyGeneration: 7,
        startedAt: "2026-08-30T11:00:00.000Z",
        commandIdempotencyKey: "start:exec:stale-test",
        reason: "Starting execution with stale token",
      });
    } catch (error) {
      expect((error as PersistenceError).code).toBe("STATE_CONFLICT");
    }

    // Verify execution remains PENDING and no execution events were created
    const execRow = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );
    expect(execRow?.status).toBe("PENDING");
    expect(execRow?.rowVersion).toBe(0);

    const eventCount = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM execution_events WHERE execution_id = ${fixture.executionId}`,
    );
    expect((eventCount.rows[0] as { count: number }).count).toBe(0);
  });

  it("Test 9: Concurrent Execution Start - exactly one worker transitions PENDING to RUNNING", async () => {
    const fixture = {
      cueId: "cue-conc-exec",
      sessionId: "session-conc-exec",
      candidateId: "cand-conc-exec",
      groundingId: "ground-conc-exec",
      policyId: "policy-conc-exec",
      planId: "plan-conc-exec",
      executionId: "exec-conc-exec",
      safetyGeneration: 0,
    };

    await seedExecutionFixture(fixture);

    const outcomes = await Promise.allSettled([
      executionRepository.startExecution(context.db, {
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        expectedRowVersion: 0,
        expectedSafetyGeneration: 0,
        startedAt: "2026-08-30T11:00:00.000Z",
        commandIdempotencyKey: "start:worker-1",
        reason: "Worker 1 starting execution",
      }),
      executionRepository.startExecution(context.db, {
        executionId: fixture.executionId,
        sessionId: fixture.sessionId,
        planId: fixture.planId,
        expectedRowVersion: 0,
        expectedSafetyGeneration: 0,
        startedAt: "2026-08-30T11:00:00.000Z",
        commandIdempotencyKey: "start:worker-2",
        reason: "Worker 2 starting execution",
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedErr = (rejected[0] as PromiseRejectedResult)
      .reason as PersistenceError;
    expect(rejectedErr.code).toBe("STALE_WRITE");

    // Verify database state: status RUNNING, row_version 1, exactly 1 RUNNING execution event
    const exec = await executionRepository.findExecutionById(
      context.db,
      fixture.executionId,
    );
    expect(exec?.status).toBe("RUNNING");
    expect(exec?.rowVersion).toBe(1);
    expect(exec?.safetyGenerationAtStart).toBe(0);

    const eventRows = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM execution_events WHERE execution_id = ${fixture.executionId} AND to_status = 'RUNNING'`,
    );
    expect((eventRows.rows[0] as { count: number }).count).toBe(1);
  });

  it("Test 10: Operation Reservation - Same Request (idempotent replay)", async () => {
    const fixture = {
      cueId: "cue-op-res",
      sessionId: "session-op-res",
      candidateId: "cand-op-res",
      groundingId: "ground-op-res",
      policyId: "policy-op-res",
      planId: "plan-op-res",
      executionId: "exec-op-res",
    };

    await seedExecutionFixture(fixture);

    // Insert step
    await context.db.execute(sql`
      INSERT INTO action_plan_steps (plan_id, step_id, ordinal, description)
      VALUES (${fixture.planId}, 'step-op-1', 0, 'Send Email')
    `);

    const op: PersistedExecutionOperation = {
      operationId: "op-res-1",
      executionId: fixture.executionId,
      stepId: "step-op-1",
      operationGeneration: 1,
      operationKind: "email.send",
      idempotencyKey: "op:exec-op-res:step-op-1:1",
      requestFingerprint: "sha256:fingerprint-match",
      status: "PENDING",
      attemptCount: 0,
      providerScope: "sendgrid",
      providerIdempotencyKey: null,
      providerOperationId: null,
      uncertaintyReason: null,
      reconciliationStatus: "NOT_REQUIRED",
      reconciliationOutcome: null,
      rowVersion: 0,
      createdAt: "2026-08-30T11:00:00.000Z",
      updatedAt: "2026-08-30T11:00:00.000Z",
    };

    const results = await Promise.all([
      executionOperationRepository.reserveExecutionOperation(context.db, op),
      executionOperationRepository.reserveExecutionOperation(context.db, op),
    ]);

    const createdCount = results.filter((r) => !r.isReplay).length;
    const replayedCount = results.filter((r) => r.isReplay).length;

    expect(createdCount).toBe(1);
    expect(replayedCount).toBe(1);

    // Verify exactly 1 execution_operations record exists
    const dbCount = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM execution_operations WHERE execution_id = ${fixture.executionId}`,
    );
    expect((dbCount.rows[0] as { count: number }).count).toBe(1);
  });

  it("Test 11: Operation Idempotency Conflict - rejects different request fingerprint", async () => {
    const fixture = {
      cueId: "cue-op-conflict",
      sessionId: "session-op-conflict",
      candidateId: "cand-op-conflict",
      groundingId: "ground-op-conflict",
      policyId: "policy-op-conflict",
      planId: "plan-op-conflict",
      executionId: "exec-op-conflict",
    };

    await seedExecutionFixture(fixture);

    await context.db.execute(sql`
      INSERT INTO action_plan_steps (plan_id, step_id, ordinal, description)
      VALUES (${fixture.planId}, 'step-op-conflict-1', 0, 'Send Email')
    `);

    const opA: PersistedExecutionOperation = {
      operationId: "op-conf-1",
      executionId: fixture.executionId,
      stepId: "step-op-conflict-1",
      operationGeneration: 1,
      operationKind: "email.send",
      idempotencyKey: "op:conflict-key:1",
      requestFingerprint: "sha256:fingerprint-original",
      status: "PENDING",
      attemptCount: 0,
      providerScope: "sendgrid",
      providerIdempotencyKey: null,
      providerOperationId: null,
      uncertaintyReason: null,
      reconciliationStatus: "NOT_REQUIRED",
      reconciliationOutcome: null,
      rowVersion: 0,
      createdAt: "2026-08-30T11:00:00.000Z",
      updatedAt: "2026-08-30T11:00:00.000Z",
    };

    const firstResult =
      await executionOperationRepository.reserveExecutionOperation(
        context.db,
        opA,
      );
    expect(firstResult.isReplay).toBe(false);

    const opB: PersistedExecutionOperation = {
      ...opA,
      operationId: "op-conf-2",
      requestFingerprint: "sha256:fingerprint-DIFFERENT",
    };

    await expect(
      executionOperationRepository.reserveExecutionOperation(context.db, opB),
    ).rejects.toThrow(PersistenceError);

    try {
      await executionOperationRepository.reserveExecutionOperation(
        context.db,
        opB,
      );
    } catch (error) {
      expect((error as PersistenceError).code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  it("Test 12: UNKNOWN is Durable - persists and decodes UNKNOWN status without becoming FAILED", async () => {
    const fixture = {
      cueId: "cue-unknown",
      sessionId: "session-unknown",
      candidateId: "cand-unknown",
      groundingId: "ground-unknown",
      policyId: "policy-unknown",
      planId: "plan-unknown",
      executionId: "exec-unknown",
    };

    await seedExecutionFixture(fixture);

    await context.db.execute(sql`
      INSERT INTO action_plan_steps (plan_id, step_id, ordinal, description)
      VALUES (${fixture.planId}, 'step-unk-1', 0, 'Charge Card')
    `);

    const unknownOp: PersistedExecutionOperation = {
      operationId: "op-unknown-1",
      executionId: fixture.executionId,
      stepId: "step-unk-1",
      operationGeneration: 1,
      operationKind: "payment.charge",
      idempotencyKey: "op:unknown:charge:1",
      requestFingerprint: "sha256:fp-unknown",
      status: "UNKNOWN",
      attemptCount: 1,
      providerScope: "stripe",
      providerIdempotencyKey: "stripe-idemp-1",
      providerOperationId: null,
      uncertaintyReason: "HTTP 504 Gateway Timeout from payment gateway",
      reconciliationStatus: "REQUIRED",
      reconciliationOutcome: null,
      rowVersion: 0,
      createdAt: "2026-08-30T11:00:00.000Z",
      updatedAt: "2026-08-30T11:00:00.000Z",
    };

    await executionOperationRepository.reserveExecutionOperation(
      context.db,
      unknownOp,
    );

    // Read back through repository
    const retrieved =
      await executionOperationRepository.findOperationByIdempotencyKey(
        context.db,
        "op:unknown:charge:1",
      );

    expect(retrieved).not.toBeNull();
    expect(retrieved?.status).toBe("UNKNOWN");
    expect(retrieved?.uncertaintyReason).toBe(
      "HTTP 504 Gateway Timeout from payment gateway",
    );
    expect(retrieved?.reconciliationStatus).toBe("REQUIRED");
    expect(retrieved?.status).not.toBe("FAILED");
  });
});
