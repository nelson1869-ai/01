import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import type { SafetyTransitionCommand } from "../../contracts/transition-commands";
import type { PostgresDatabaseContext } from "../client";
import { PersistenceError } from "../errors/persistence-errors";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { runInTransaction } from "../transactions/transaction-executor";

describe("live PostgreSQL cue ingestion and safety concurrency tests", () => {
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

  it("Test 4: Duplicate Cue - Same Request (concurrent race)", async () => {
    const cue: PersistedCueIngress = {
      cueId: "cue-race-same",
      source: "github",
      externalEventId: "evt-race-same-1",
      type: "github.issue.created",
      occurredAt: "2026-08-30T10:00:00.000Z",
      receivedAt: "2026-08-30T10:00:01.000Z",
      payload: { issueNumber: 101, title: "Test Bug" },
    };

    const results = await Promise.all([
      ingestCue(context.db, { cue, sessionId: "session-race-same-1" }),
      ingestCue(context.db, { cue, sessionId: "session-race-same-2" }),
    ]);

    const createdCount = results.filter((r) => !r.isReplay).length;
    const replayedCount = results.filter((r) => r.isReplay).length;

    expect(createdCount).toBe(1);
    expect(replayedCount).toBe(1);

    // Verify durable state in PostgreSQL
    const cueRows = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM cues WHERE source = 'github' AND external_event_id = 'evt-race-same-1'`,
    );
    expect((cueRows.rows[0] as { count: number }).count).toBe(1);

    const sessionRows = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM cognitive_sessions`,
    );
    expect((sessionRows.rows[0] as { count: number }).count).toBe(1);

    const safetyRows = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM execution_safety_state`,
    );
    expect((safetyRows.rows[0] as { count: number }).count).toBe(1);
  });

  it("Test 5: Duplicate Cue - Different Request (idempotency conflict)", async () => {
    const cueA: PersistedCueIngress = {
      cueId: "cue-conflict-a",
      source: "email",
      externalEventId: "evt-conflict-1",
      type: "email.received",
      occurredAt: "2026-08-30T10:00:00.000Z",
      receivedAt: "2026-08-30T10:00:01.000Z",
      payload: { text: "Original message" },
    };

    const firstResult = await ingestCue(context.db, {
      cue: cueA,
      sessionId: "session-conflict-a",
    });
    expect(firstResult.isReplay).toBe(false);

    const cueB: PersistedCueIngress = {
      cueId: "cue-conflict-b",
      source: "email",
      externalEventId: "evt-conflict-1",
      type: "email.received",
      occurredAt: "2026-08-30T10:00:00.000Z",
      receivedAt: "2026-08-30T10:00:02.000Z",
      payload: { text: "Tampered or different message" },
    };

    await expect(
      ingestCue(context.db, { cue: cueB, sessionId: "session-conflict-b" }),
    ).rejects.toThrow(PersistenceError);

    try {
      await ingestCue(context.db, {
        cue: cueB,
        sessionId: "session-conflict-b",
      });
    } catch (error) {
      expect((error as PersistenceError).code).toBe("IDEMPOTENCY_CONFLICT");
    }

    // Verify original cue was not modified
    const dbCues = await context.db.execute(
      sql`SELECT cue_id FROM cues WHERE source = 'email' AND external_event_id = 'evt-conflict-1'`,
    );
    expect(dbCues.rows.length).toBe(1);
    expect((dbCues.rows[0] as { cue_id: string }).cue_id).toBe(
      "cue-conflict-a",
    );
  });

  it("Test 6: Safety Generation CAS Race - exactly one worker advances generation", async () => {
    const cue: PersistedCueIngress = {
      cueId: "cue-cas-safety",
      source: "github",
      externalEventId: "evt-cas-safety-1",
      type: "github.issue.created",
      occurredAt: "2026-08-30T10:00:00.000Z",
      receivedAt: "2026-08-30T10:00:01.000Z",
      payload: { id: "GH-1" },
    };

    const ingested = await ingestCue(context.db, {
      cue,
      sessionId: "session-cas-safety",
    });
    expect(ingested.safetyState.generation).toBe(0);

    const nextStateA: StoredExecutionSafety = {
      sessionId: "session-cas-safety",
      generation: 1,
      status: "BLOCKED",
      failure: "POLICY_VIOLATION",
      reason: "Worker A policy block",
      blockedAt: "2026-08-30T10:01:00.000Z",
      evaluatedCandidateId: null,
      groundingResultId: null,
      policyDecisionId: null,
      updatedAt: "2026-08-30T10:01:00.000Z",
    };

    const nextStateB: StoredExecutionSafety = {
      sessionId: "session-cas-safety",
      generation: 1,
      status: "BLOCKED",
      failure: "HALLUCINATION_DETECTED",
      reason: "Worker B grounding block",
      blockedAt: "2026-08-30T10:01:00.000Z",
      evaluatedCandidateId: null,
      groundingResultId: null,
      policyDecisionId: null,
      updatedAt: "2026-08-30T10:01:00.000Z",
    };

    const cmdA: SafetyTransitionCommand = {
      sessionId: "session-cas-safety",
      expectedGeneration: 0,
      nextState: nextStateA,
      commandIdempotencyKey: "safety:cas:worker-a",
    };

    const cmdB: SafetyTransitionCommand = {
      sessionId: "session-cas-safety",
      expectedGeneration: 0,
      nextState: nextStateB,
      commandIdempotencyKey: "safety:cas:worker-b",
    };

    const outcomes = await Promise.allSettled([
      safetyRepository.transitionSafety(context.db, cmdA),
      safetyRepository.transitionSafety(context.db, cmdB),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult)
      .reason as PersistenceError;
    expect(rejectedReason).toBeInstanceOf(PersistenceError);
    expect(rejectedReason.code).toBe("STALE_WRITE");

    // Verify database state: current generation is 1, exactly 1 safety event
    const stateRows = await context.db.execute(
      sql`SELECT generation, durable_status FROM execution_safety_state WHERE session_id = 'session-cas-safety'`,
    );
    expect(
      Number((stateRows.rows[0] as { generation: number | string }).generation),
    ).toBe(1);

    const eventRows = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM execution_safety_events WHERE session_id = 'session-cas-safety' AND to_generation = 1`,
    );
    expect((eventRows.rows[0] as { count: number }).count).toBe(1);
  });

  it("Test 7: Session Row Version CAS Race - exactly one worker transitions session", async () => {
    const cue: PersistedCueIngress = {
      cueId: "cue-cas-session",
      source: "schedule",
      externalEventId: "evt-cas-session-1",
      type: "schedule",
      occurredAt: "2026-08-30T10:00:00.000Z",
      receivedAt: "2026-08-30T10:00:01.000Z",
      payload: { scheduleId: "cron-1" },
    };

    await ingestCue(context.db, { cue, sessionId: "session-cas-session" });

    const outcomes = await Promise.allSettled([
      sessionRepository.transitionSession(context.db, {
        sessionId: "session-cas-session",
        expectedRowVersion: 0,
        nextSessionState: {
          phase: "PERCEIVE",
          failureCount: 0,
          retryCount: 0,
          maxRetries: 2,
          cooldownUntil: null,
          updatedAt: "2026-08-30T10:01:00.000Z",
        },
      }),
      sessionRepository.transitionSession(context.db, {
        sessionId: "session-cas-session",
        expectedRowVersion: 0,
        nextSessionState: {
          phase: "BUILD_CONTEXT",
          failureCount: 0,
          retryCount: 0,
          maxRetries: 2,
          cooldownUntil: null,
          updatedAt: "2026-08-30T10:01:00.000Z",
        },
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedReason = (rejected[0] as PromiseRejectedResult)
      .reason as PersistenceError;
    expect(rejectedReason).toBeInstanceOf(PersistenceError);
    expect(rejectedReason.code).toBe("STALE_WRITE");

    // Verify row_version is exactly 1
    const sessionRow = await context.db.execute(
      sql`SELECT row_version, phase FROM cognitive_sessions WHERE session_id = 'session-cas-session'`,
    );
    expect((sessionRow.rows[0] as { row_version: number }).row_version).toBe(1);
  });

  it("Test 13: Transaction Rollback - Cue Ingestion rolls back completely on mid-transaction failure", async () => {
    const cue: PersistedCueIngress = {
      cueId: "cue-rollback",
      source: "file",
      externalEventId: "evt-rollback-1",
      type: "file.created",
      occurredAt: "2026-08-30T10:00:00.000Z",
      receivedAt: "2026-08-30T10:00:01.000Z",
      payload: { filePath: "/data.csv" },
    };

    try {
      await runInTransaction(context.db, async (tx) => {
        // Step 1: Insert cue
        await tx.execute(sql`
          INSERT INTO cues (cue_id, source, external_event_id, cue_type, occurred_at, received_at, payload, payload_hash)
          VALUES (${cue.cueId}, ${cue.source}, ${cue.externalEventId}, ${cue.type}, NOW(), NOW(), '{}', 'hash-rb')
        `);

        // Step 2: Simulate failure (e.g. invalid check constraint)
        await tx.execute(sql`
          INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
          VALUES ('s-rb', ${cue.cueId}, 'CUE', -10, 0, 2, 0, NOW(), NOW())
        `);
      });
      expect.unreachable("Transaction should have failed and rolled back");
    } catch {
      // Expected failure
    }

    // Verify that cue was NOT committed
    const cueCheck = await context.db.execute(
      sql`SELECT COUNT(*)::int as count FROM cues WHERE cue_id = 'cue-rollback'`,
    );
    expect((cueCheck.rows[0] as { count: number }).count).toBe(0);
  });

  it("Test 14: Safety Transition + History Atomicity - rolls back safety update if event insert fails", async () => {
    const cue: PersistedCueIngress = {
      cueId: "cue-safety-rb",
      source: "github",
      externalEventId: "evt-safety-rb",
      type: "github.issue.created",
      occurredAt: "2026-08-30T10:00:00.000Z",
      receivedAt: "2026-08-30T10:00:01.000Z",
      payload: {},
    };

    await ingestCue(context.db, { cue, sessionId: "session-safety-rb" });

    // Pre-insert a safety event with specific eventKey to trigger a collision
    await context.db.execute(sql`
      INSERT INTO execution_safety_events (
        safety_event_id, session_id, from_generation, to_generation, event_type, event_key, reason, occurred_at
      ) VALUES (
        'evt-existing-1', 'session-safety-rb', 0, 1, 'SAFETY_TRANSITION', 'safety:event:fixed-key', 'Pre-existing event', NOW()
      );
    `);

    // Now attempt transitionSafety with duplicate to_generation (UNIQUE constraint violation on session_id, to_generation)
    const cmd: SafetyTransitionCommand = {
      sessionId: "session-safety-rb",
      expectedGeneration: 0,
      nextState: {
        sessionId: "session-safety-rb",
        generation: 1,
        status: "BLOCKED",
        failure: "EXECUTION_TIMEOUT",
        reason: "Execution timed out",
        blockedAt: "2026-08-30T10:01:00.000Z",
        evaluatedCandidateId: null,
        groundingResultId: null,
        policyDecisionId: null,
        updatedAt: "2026-08-30T10:01:00.000Z",
      },
      commandIdempotencyKey: "safety:event:different-key",
    };

    try {
      await runInTransaction(context.db, async (tx) => {
        await safetyRepository.transitionSafety(tx, cmd);
      });
      expect.unreachable("Should have failed due to duplicate to_generation");
    } catch {
      // Expected
    }

    // Verify that execution_safety_state generation remained at 0
    const state = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      "session-safety-rb",
    );
    expect(state?.generation).toBe(0);
    expect(state?.status).toBe("UNAUTHORIZED");
  });
});
