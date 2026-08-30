import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { FailureRecoveryCommand } from "../../contracts/failure-recovery-command";
import type { PersistedEvidence } from "../../contracts/persisted-evidence";
import type { PostgresDatabaseContext } from "../client";
import { PersistenceError } from "../errors/persistence-errors";
import { evidenceRepository } from "../repositories/evidence-repository";
import { failureAuditRepository } from "../repositories/failure-audit-repository";
import { idempotencyRepository } from "../repositories/idempotency-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { persistFailureRecovery } from "../transactions/persist-failure-recovery";

describe("live PostgreSQL atomic failure recovery transaction integration tests", () => {
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

  async function seedSessionAndEvidence(
    sessionId = "session-fail-1",
    cueId = "cue-fail-1",
    evidenceId = "ev-fail-1",
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

    const ev: PersistedEvidence = {
      evidenceId,
      source: "diagnostics",
      sourceId: `diag-${evidenceId}`,
      claim: "Diagnostic failure evidence",
      observedAt: "2026-08-30T00:00:00.000Z",
      createdAt: "2026-08-30T00:00:01.000Z",
      providerMetadata: null,
    };
    await evidenceRepository.appendEvidence(context.db, ev);

    return { sessionId, cueId, evidenceId };
  }

  async function seedPlanAndExecution(
    sessionId: string,
    cueId: string,
    candidateId: string,
    planId: string,
    executionId: string,
    evidenceId: string,
  ) {
    const seeded = await seedSessionAndEvidence(sessionId, cueId, evidenceId);

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

    return seeded;
  }

  it("1. Failure #1 (HALLUCINATION_DETECTED): transitions session to BUILD_CONTEXT, revokes safety 0 -> 1 (BLOCKED), records audit + evidence", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-f1",
      "cue-f1",
      "ev-f1",
    );

    const command: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-f1:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "Grounded evaluation contradicted claim",
      evidenceIds: [evidenceId],
      auditEventId: "audit-f1-1",
      safetyEventId: "safety-evt-f1-1",
      safetyEventKey: "safety:session-f1:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const result = await persistFailureRecovery(context.db, command);
    expect(result.isReplay).toBe(false);
    expect(result.decision.action).toBe("RETRY_WITH_FRESH_CONTEXT");
    expect(result.decision.failureCount).toBe(1);
    expect(result.decision.retryCount).toBe(0);

    // Verify session
    expect(result.session.phase).toBe("BUILD_CONTEXT");
    expect(result.session.failureCount).toBe(1);
    expect(result.session.retryCount).toBe(1);
    expect(result.session.rowVersion).toBe(1);

    // Verify safety state
    expect(result.safetyState.generation).toBe(1);
    expect(result.safetyState.status).toBe("BLOCKED");
    expect(result.safetyState.failure).toBe("HALLUCINATION_DETECTED");

    // Verify audit
    expect(result.audit.auditEventId).toBe("audit-f1-1");
    expect(result.audit.fromSafetyGeneration).toBe(0);
    expect(result.audit.revokedSafetyGeneration).toBe(1);
    expect(result.audit.evidenceIds).toEqual([evidenceId]);
  });

  it("2. Failure #2 (EXECUTION_TIMEOUT): transitions session to COOLDOWN with cooldownUntil, revokes safety 1 -> 2 (BLOCKED)", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-f2",
      "cue-f2",
      "ev-f2",
    );

    // First failure
    await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "fail:session-f2:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "First failure",
      evidenceIds: [evidenceId],
      auditEventId: "audit-f2-1",
      safetyEventId: "safety-evt-f2-1",
      safetyEventKey: "safety:session-f2:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    });

    // Second failure
    const command2: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-f2:2",
      sessionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 1,
      failure: "EXECUTION_TIMEOUT",
      reason: "Second failure: timeout",
      evidenceIds: [evidenceId],
      auditEventId: "audit-f2-2",
      safetyEventId: "safety-evt-f2-2",
      safetyEventKey: "safety:session-f2:gen-2",
      createdAt: "2026-08-30T00:02:00.000Z",
    };

    const result2 = await persistFailureRecovery(context.db, command2);
    expect(result2.isReplay).toBe(false);
    expect(result2.decision.action).toBe("START_COOLDOWN");
    expect(result2.decision.failureCount).toBe(2);
    expect(result2.session.phase).toBe("COOLDOWN");
    expect(result2.session.cooldownUntil).not.toBeNull();
    expect(result2.safetyState.generation).toBe(2);
    expect(result2.safetyState.status).toBe("BLOCKED");
  });

  it("3. Failure #3 (UNVERIFIED_RESULT): transitions session to HUMAN_REVIEW, revokes safety 2 -> 3 (BLOCKED)", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-f3",
      "cue-f3",
      "ev-f3",
    );

    // First failure
    await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "fail:session-f3:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "First failure",
      evidenceIds: [evidenceId],
      auditEventId: "audit-f3-1",
      safetyEventId: "safety-evt-f3-1",
      safetyEventKey: "safety:session-f3:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    });

    // Second failure
    await persistFailureRecovery(context.db, {
      commandIdempotencyKey: "fail:session-f3:2",
      sessionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 1,
      failure: "EXECUTION_TIMEOUT",
      reason: "Second failure",
      evidenceIds: [evidenceId],
      auditEventId: "audit-f3-2",
      safetyEventId: "safety-evt-f3-2",
      safetyEventKey: "safety:session-f3:gen-2",
      createdAt: "2026-08-30T00:02:00.000Z",
    });

    // Third failure
    const command3: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-f3:3",
      sessionId,
      expectedSessionRowVersion: 2,
      expectedSafetyGeneration: 2,
      failure: "UNVERIFIED_RESULT",
      reason: "Third failure: result unverified",
      evidenceIds: [evidenceId],
      auditEventId: "audit-f3-3",
      safetyEventId: "safety-evt-f3-3",
      safetyEventKey: "safety:session-f3:gen-3",
      createdAt: "2026-08-30T00:03:00.000Z",
    };

    const result3 = await persistFailureRecovery(context.db, command3);
    expect(result3.isReplay).toBe(false);
    expect(result3.decision.action).toBe("ESCALATE_TO_HUMAN");
    expect(result3.decision.failureCount).toBe(3);
    expect(result3.session.phase).toBe("HUMAN_REVIEW");
    expect(result3.safetyState.generation).toBe(3);
    expect(result3.safetyState.status).toBe("BLOCKED");
  });

  it("4. POLICY_VIOLATION: immediately escalates to HUMAN_REVIEW on 1st failure", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-fpol",
      "cue-fpol",
      "ev-fpol",
    );

    const command: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-fpol:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "POLICY_VIOLATION",
      reason: "Disallowed command detected",
      evidenceIds: [evidenceId],
      auditEventId: "audit-fpol-1",
      safetyEventId: "safety-evt-fpol-1",
      safetyEventKey: "safety:session-fpol:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const result = await persistFailureRecovery(context.db, command);
    expect(result.decision.action).toBe("ESCALATE_TO_HUMAN");
    expect(result.session.phase).toBe("HUMAN_REVIEW");
    expect(result.safetyState.status).toBe("BLOCKED");
  });

  it("5. Active execution: transitions active execution to BLOCKED and records execution event", async () => {
    const { sessionId, evidenceId } = await seedPlanAndExecution(
      "session-fexec",
      "cue-fexec",
      "cand-fexec",
      "plan-fexec",
      "exec-active-1",
      "ev-fexec",
    );

    const command: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-fexec:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "EXECUTION_TIMEOUT",
      reason: "Active execution timeout",
      evidenceIds: [evidenceId],
      auditEventId: "audit-fexec-1",
      safetyEventId: "safety-evt-fexec-1",
      safetyEventKey: "safety:session-fexec:gen-1",
      activeExecution: {
        executionId: "exec-active-1",
        expectedExecutionRowVersion: 0,
        expectedStatus: "RUNNING",
        executionEventId: "exec-evt-1",
        executionEventKey: "exec-evt-key-1",
      },
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const result = await persistFailureRecovery(context.db, command);
    expect(result.blockedExecution).not.toBeNull();
    expect(result.blockedExecution?.status).toBe("BLOCKED");
    expect(result.blockedExecution?.rowVersion).toBe(1);
    expect(result.blockedExecution?.completedAt).toBe(
      "2026-08-30T00:01:00.000Z",
    );

    // Verify execution event
    const eventRows = await context.db.execute(sql`
      SELECT * FROM execution_events WHERE execution_id = 'exec-active-1'
    `);
    expect(eventRows.rows.length).toBe(1);
    expect(eventRows.rows[0].to_status).toBe("BLOCKED");
    expect(Number(eventRows.rows[0].safety_generation)).toBe(1);
  });

  it("6. Idempotent replay: identical failure recovery command returns replay without double increment", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-freplay",
      "cue-freplay",
      "ev-freplay",
    );

    const command: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-freplay:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "First hallucination",
      evidenceIds: [evidenceId],
      auditEventId: "audit-freplay-1",
      safetyEventId: "safety-evt-freplay-1",
      safetyEventKey: "safety:session-freplay:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const first = await persistFailureRecovery(context.db, command);
    expect(first.isReplay).toBe(false);
    expect(first.session.rowVersion).toBe(1);

    const second = await persistFailureRecovery(context.db, command);
    expect(second.isReplay).toBe(true);
    expect(second.session.rowVersion).toBe(1);
    expect(second.safetyState.generation).toBe(1);
  });

  it("7. Idempotency conflict: differing failure command on same key throws IDEMPOTENCY_CONFLICT", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-fconf",
      "cue-fconf",
      "ev-fconf",
    );

    const command: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-fconf:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "First hallucination",
      evidenceIds: [evidenceId],
      auditEventId: "audit-fconf-1",
      safetyEventId: "safety-evt-fconf-1",
      safetyEventKey: "safety:session-fconf:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    await persistFailureRecovery(context.db, command);

    // Different failure code with same idempotency key
    const conflicting: FailureRecoveryCommand = {
      ...command,
      failure: "EXECUTION_TIMEOUT",
    };

    await expect(
      persistFailureRecovery(context.db, conflicting),
    ).rejects.toThrow(PersistenceError);
  });

  it("8. Concurrent same-failure racing: exactly 1 succeeds and other receives replay", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-frace",
      "cue-frace",
      "ev-frace",
    );

    const command: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-frace:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "Concurrent racing failure",
      evidenceIds: [evidenceId],
      auditEventId: "audit-frace-1",
      safetyEventId: "safety-evt-frace-1",
      safetyEventKey: "safety:session-frace:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const results = await Promise.all([
      persistFailureRecovery(context.db, command),
      persistFailureRecovery(context.db, command),
    ]);

    const createdCount = results.filter((r) => !r.isReplay).length;
    const replayedCount = results.filter((r) => r.isReplay).length;

    expect(createdCount).toBe(1);
    expect(replayedCount).toBe(1);
  });

  it("9. Stale safety generation CAS: rolls back entire transaction if generation is stale", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-fstale-gen",
      "cue-fstale-gen",
      "ev-fstale-gen",
    );

    const staleCommand: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-fstale-gen:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 99, // Stale generation
      failure: "HALLUCINATION_DETECTED",
      reason: "Stale safety generation attempt",
      evidenceIds: [evidenceId],
      auditEventId: "audit-fstale-gen-1",
      safetyEventId: "safety-evt-fstale-gen-1",
      safetyEventKey: "safety:session-fstale-gen:gen-100",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    await expect(
      persistFailureRecovery(context.db, staleCommand),
    ).rejects.toThrow(PersistenceError);

    // Verify 0 side-effects: session rowVersion should still be 0, no audit written
    const session = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(session?.rowVersion).toBe(0);

    const audit =
      await failureAuditRepository.findFailureAuditBySessionAndLogicalKey(
        context.db,
        sessionId,
        "fail:session-fstale-gen:1",
      );
    expect(audit).toBeNull();
  });

  it("10. Stale session row version CAS: rolls back entire transaction if session rowVersion is stale", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-fstale-sess",
      "cue-fstale-sess",
      "ev-fstale-sess",
    );

    const staleCommand: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-fstale-sess:1",
      sessionId,
      expectedSessionRowVersion: 99, // Stale session row version
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "Stale session version attempt",
      evidenceIds: [evidenceId],
      auditEventId: "audit-fstale-sess-1",
      safetyEventId: "safety-evt-fstale-sess-1",
      safetyEventKey: "safety:session-fstale-sess:gen-1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    await expect(
      persistFailureRecovery(context.db, staleCommand),
    ).rejects.toThrow(PersistenceError);

    // Verify safety generation is still 0
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(safety?.generation).toBe(0);
  });

  it("11. Stale execution row version CAS: rolls back entire transaction if active execution rowVersion is stale", async () => {
    const { sessionId, evidenceId } = await seedPlanAndExecution(
      "session-fstale-exec",
      "cue-fstale-exec",
      "cand-fstale-exec",
      "plan-fstale-exec",
      "exec-stale-1",
      "ev-fstale-exec",
    );

    const staleCommand: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:session-fstale-exec:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "EXECUTION_TIMEOUT",
      reason: "Stale execution attempt",
      evidenceIds: [evidenceId],
      auditEventId: "audit-fstale-exec-1",
      safetyEventId: "safety-evt-fstale-exec-1",
      safetyEventKey: "safety:session-fstale-exec:gen-1",
      activeExecution: {
        executionId: "exec-stale-1",
        expectedExecutionRowVersion: 99, // Stale execution row version
        expectedStatus: "RUNNING",
        executionEventId: "exec-evt-stale-1",
        executionEventKey: "exec-evt-key-stale-1",
      },
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    await expect(
      persistFailureRecovery(context.db, staleCommand),
    ).rejects.toThrow(PersistenceError);

    // Verify execution remains RUNNING with row_version 0
    const execRows = await context.db.execute(sql`
      SELECT status, row_version FROM executions WHERE execution_id = 'exec-stale-1'
    `);
    expect(execRows.rows[0].status).toBe("RUNNING");
    expect(Number(execRows.rows[0].row_version)).toBe(0);

    // Session and safety also untouched
    const session = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(session?.rowVersion).toBe(0);
  });

  it("12. Different failures / same safety generation race: exactly 1 commits, the other fails with STALE_WRITE", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-fdiff-race",
      "cue-fdiff-race",
      "ev-fdiff-race",
    );

    const commandA: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:race:hallucination:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "Worker A observed hallucination",
      evidenceIds: [evidenceId],
      auditEventId: "audit-race-a",
      safetyEventId: "safety-evt-race-a",
      safetyEventKey: "safety:race:a:1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const commandB: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:race:timeout:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "EXECUTION_TIMEOUT",
      reason: "Worker B observed timeout",
      evidenceIds: [evidenceId],
      auditEventId: "audit-race-b",
      safetyEventId: "safety-evt-race-b",
      safetyEventKey: "safety:race:b:1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    const results = await Promise.allSettled([
      persistFailureRecovery(context.db, commandA),
      persistFailureRecovery(context.db, commandB),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Rejected worker failed closed due to stale write (CAS mismatch on safety generation or session rowVersion)
    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectionReason).toBeInstanceOf(PersistenceError);
    expect((rejectionReason as PersistenceError).code).toBe("STALE_WRITE");

    // Verify durable DB state:
    // 1. Safety generation advanced exactly once (0 -> 1)
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(safety?.generation).toBe(1);
    expect(safety?.status).toBe("BLOCKED");

    // 2. Exactly one failure audit committed
    const auditRows = await context.db.execute(sql`
      SELECT COUNT(*)::int as count FROM failure_audit_events WHERE session_id = ${sessionId}
    `);
    expect(Number(auditRows.rows[0].count)).toBe(1);

    // 3. Session row_version advanced exactly once (0 -> 1)
    const session = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(session?.rowVersion).toBe(1);
    expect(session?.failureCount).toBe(1);

    // 4. Exactly one safety event recorded
    const safetyEventRows = await context.db.execute(sql`
      SELECT COUNT(*)::int as count FROM execution_safety_events WHERE session_id = ${sessionId}
    `);
    expect(Number(safetyEventRows.rows[0].count)).toBe(1);
  });

  it("13. Failure audit evidence FK rollback: non-existent evidenceId rolls back entire transaction", async () => {
    const { sessionId } = await seedSessionAndEvidence(
      "session-ffk-rollback",
      "cue-ffk-rollback",
      "ev-ffk-valid",
    );

    const commandWithBadFK: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:fk-violation:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "Failure with invalid evidence reference",
      evidenceIds: ["ev-does-not-exist-99999"], // Violates FK to evidence_records
      auditEventId: "audit-fk-violation",
      safetyEventId: "safety-evt-fk-violation",
      safetyEventKey: "safety:fk-violation:1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    await expect(
      persistFailureRecovery(context.db, commandWithBadFK),
    ).rejects.toThrow();

    // Verify complete rollback:
    // 1. No failure audit exists
    const audit =
      await failureAuditRepository.findFailureAuditBySessionAndLogicalKey(
        context.db,
        sessionId,
        "fail:fk-violation:1",
      );
    expect(audit).toBeNull();

    // 2. Safety generation unchanged (0, UNAUTHORIZED)
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(safety?.generation).toBe(0);
    expect(safety?.status).toBe("UNAUTHORIZED");

    // 3. No safety history event written
    const safetyEvents = await context.db.execute(sql`
      SELECT COUNT(*)::int as count FROM execution_safety_events WHERE session_id = ${sessionId}
    `);
    expect(Number(safetyEvents.rows[0].count)).toBe(0);

    // 4. Session rowVersion and counters unchanged
    const session = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(session?.rowVersion).toBe(0);
    expect(session?.failureCount).toBe(0);
    expect(session?.retryCount).toBe(0);

    // 5. Idempotency record must not appear COMPLETED
    const idemp = await idempotencyRepository.findCommand(
      context.db,
      "failure-recovery",
      "fail:fk-violation:1",
    );
    expect(idemp).toBeNull();
  });

  it("14. Safety event insertion conflict rollback: unique violation on safety event rolls back entire transaction", async () => {
    const { sessionId, evidenceId } = await seedSessionAndEvidence(
      "session-fsafety-collision",
      "cue-fsafety-collision",
      "ev-fsafety-collision",
    );

    // Pre-insert an execution_safety_events row with a colliding safety_event_id
    await context.db.execute(sql`
      INSERT INTO execution_safety_events (
        safety_event_id, session_id, from_generation, to_generation, event_type, event_key, reason, occurred_at
      ) VALUES (
        'safety-evt-colliding-pk', ${sessionId}, 98, 99, 'SAFETY_REVOCATION', 'pre-existing-key', 'Collision seed', NOW()
      )
    `);

    const collidingCommand: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:safety-collision:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "POLICY_VIOLATION",
      reason: "Policy violation with duplicate safety event ID",
      evidenceIds: [evidenceId],
      auditEventId: "audit-safety-collision",
      safetyEventId: "safety-evt-colliding-pk", // Duplicate PK on execution_safety_events
      safetyEventKey: "safety:collision-test:1",
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    await expect(
      persistFailureRecovery(context.db, collidingCommand),
    ).rejects.toThrow();

    // Verify transaction rollback:
    // 1. Safety state restored to original generation 0 and UNAUTHORIZED status
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(safety?.generation).toBe(0);
    expect(safety?.status).toBe("UNAUTHORIZED");

    // 2. Session unchanged
    const session = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(session?.rowVersion).toBe(0);
    expect(session?.phase).toBe("CUE");

    // 3. Failure audit absent
    const audit =
      await failureAuditRepository.findFailureAuditBySessionAndLogicalKey(
        context.db,
        sessionId,
        "fail:safety-collision:1",
      );
    expect(audit).toBeNull();

    // 4. Idempotency command not COMPLETED
    const idemp = await idempotencyRepository.findCommand(
      context.db,
      "failure-recovery",
      "fail:safety-collision:1",
    );
    expect(idemp).toBeNull();
  });

  it("15. Execution event insertion conflict rollback: unique violation on execution event rolls back entire transaction", async () => {
    const { sessionId, evidenceId } = await seedPlanAndExecution(
      "session-fexec-collision",
      "cue-fexec-collision",
      "cand-fexec-collision",
      "plan-fexec-collision",
      "exec-collision-1",
      "ev-fexec-collision",
    );

    // Pre-insert an execution_events row with a colliding execution_event_id
    await context.db.execute(sql`
      INSERT INTO execution_events (
        execution_event_id, execution_id, transition_sequence, from_status, to_status, safety_generation, event_key, reason, occurred_at
      ) VALUES (
        'exec-evt-colliding-pk', 'exec-collision-1', 99, 'RUNNING', 'BLOCKED', 0, 'pre-existing-exec-key', 'Collision seed', NOW()
      )
    `);

    const collidingExecCommand: FailureRecoveryCommand = {
      commandIdempotencyKey: "fail:exec-collision:1",
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "EXECUTION_TIMEOUT",
      reason: "Timeout with duplicate execution event ID",
      evidenceIds: [evidenceId],
      auditEventId: "audit-exec-collision",
      safetyEventId: "safety-evt-clean-exec-collision",
      safetyEventKey: "safety:clean-exec-collision:1",
      activeExecution: {
        executionId: "exec-collision-1",
        expectedExecutionRowVersion: 0,
        expectedStatus: "RUNNING",
        executionEventId: "exec-evt-colliding-pk", // Duplicate PK on execution_events
        executionEventKey: "exec-evt-unique-key-1",
      },
      createdAt: "2026-08-30T00:01:00.000Z",
    };

    await expect(
      persistFailureRecovery(context.db, collidingExecCommand),
    ).rejects.toThrow();

    // Verify transaction rollback:
    // 1. Execution remains original RUNNING status with row_version 0 and completed_at NULL
    const execRows = await context.db.execute(sql`
      SELECT status, row_version, completed_at FROM executions WHERE execution_id = 'exec-collision-1'
    `);
    expect(execRows.rows[0].status).toBe("RUNNING");
    expect(Number(execRows.rows[0].row_version)).toBe(0);
    expect(execRows.rows[0].completed_at).toBeNull();

    // 2. Safety generation remains 0 and UNAUTHORIZED
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(safety?.generation).toBe(0);
    expect(safety?.status).toBe("UNAUTHORIZED");

    // 3. Session row_version and phase unchanged
    const session = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(session?.rowVersion).toBe(0);
    expect(session?.failureCount).toBe(0);

    // 4. Audit event not committed
    const audit =
      await failureAuditRepository.findFailureAuditBySessionAndLogicalKey(
        context.db,
        sessionId,
        "fail:exec-collision:1",
      );
    expect(audit).toBeNull();

    // 5. Idempotency command not COMPLETED
    const idemp = await idempotencyRepository.findCommand(
      context.db,
      "failure-recovery",
      "fail:exec-collision:1",
    );
    expect(idemp).toBeNull();
  });
});
