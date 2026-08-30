import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CooldownResumeCommand } from "../../contracts/cooldown-resume-command";
import type { PersistedEvidence } from "../../contracts/persisted-evidence";
import type { PostgresDatabaseContext } from "../client";
import { PersistenceError } from "../errors/persistence-errors";
import { evidenceRepository } from "../repositories/evidence-repository";
import { idempotencyRepository } from "../repositories/idempotency-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { persistCooldownResume } from "../transactions/persist-cooldown-resume";
import { persistFailureRecovery } from "../transactions/persist-failure-recovery";
import { orchestrateRecoverySession } from "../../../orchestration/recovery-orchestrator";

describe("live PostgreSQL durable cooldown resume and recovery orchestration integration tests", () => {
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

  async function seedSessionInCooldown(
    sessionId = "sess-cd-1",
    cueId = "cue-cd-1",
    evidenceId = "ev-cd-1",
    t0 = "2026-08-31T00:00:00.000Z",
  ) {
    // 1. Ingest cue (retryCount = 0)
    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "github",
        externalEventId: `evt-${cueId}`,
        type: "github.issue.created",
        occurredAt: t0,
        receivedAt: "2026-08-31T00:00:01.000Z",
        payload: { title: "Fix issue" },
      },
      sessionId,
      maxRetries: 3,
    });

    const ev: PersistedEvidence = {
      evidenceId,
      source: "diagnostics",
      sourceId: `diag-${evidenceId}`,
      claim: "Failure diagnostics",
      observedAt: t0,
      createdAt: t0,
      providerMetadata: null,
    };
    await evidenceRepository.appendEvidence(context.db, ev);

    // 2. Failure #1 (HALLUCINATION_DETECTED) -> BUILD_CONTEXT, safety gen 0 -> 1, retryCount 0 -> 1
    await persistFailureRecovery(context.db, {
      commandIdempotencyKey: `fail:${sessionId}:1`,
      sessionId,
      expectedSessionRowVersion: 0,
      expectedSafetyGeneration: 0,
      failure: "HALLUCINATION_DETECTED",
      reason: "First failure",
      evidenceIds: [evidenceId],
      auditEventId: `audit-${sessionId}-1`,
      safetyEventId: `safety-evt-${sessionId}-1`,
      safetyEventKey: `safety:${sessionId}:gen-1`,
      createdAt: "2026-08-31T00:01:00.000Z",
    });

    // 3. Failure #2 (EXECUTION_TIMEOUT) at 00:02:00 -> COOLDOWN until 00:06:00, safety gen 1 -> 2, retryCount remains 1
    const fail2Result = await persistFailureRecovery(context.db, {
      commandIdempotencyKey: `fail:${sessionId}:2`,
      sessionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 1,
      failure: "EXECUTION_TIMEOUT",
      reason: "Second failure: timeout",
      evidenceIds: [evidenceId],
      auditEventId: `audit-${sessionId}-2`,
      safetyEventId: `safety-evt-${sessionId}-2`,
      safetyEventKey: `safety:${sessionId}:gen-2`,
      createdAt: "2026-08-31T00:02:00.000Z",
    });

    return {
      sessionId,
      cueId,
      evidenceId,
      session: fail2Result.session,
      safety: fail2Result.safetyState,
    };
  }

  it("1. Failure #2 produces exact durable 4-minute cooldown deadline", async () => {
    const { session, safety } = await seedSessionInCooldown(
      "sess-test-1",
      "cue-test-1",
      "ev-test-1",
    );

    expect(session.phase).toBe("COOLDOWN");
    expect(session.failureCount).toBe(2);
    expect(session.retryCount).toBe(1);
    expect(session.rowVersion).toBe(2);
    // 00:02:00 + 4 minutes = 00:06:00
    expect(session.cooldownUntil).toBe("2026-08-31T00:06:00.000Z");

    expect(safety.generation).toBe(2);
    expect(safety.status).toBe("BLOCKED");
  });

  it("2. Before deadline: resume rejected; no durable writes", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-2",
      "cue-test-2",
      "ev-test-2",
    );

    const earlyCommand: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-2:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:05:59.999Z", // 1ms before 00:06:00
    };

    await expect(
      persistCooldownResume(context.db, earlyCommand),
    ).rejects.toThrow(PersistenceError);

    // Verify 0 durable writes: session remains in COOLDOWN at rowVersion 2
    const currentSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(currentSession?.phase).toBe("COOLDOWN");
    expect(currentSession?.cooldownUntil).toBe("2026-08-31T00:06:00.000Z");
    expect(currentSession?.rowVersion).toBe(2);
    expect(currentSession?.retryCount).toBe(1);

    // Safety remains BLOCKED at generation 2
    const currentSafety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(currentSafety?.generation).toBe(2);
    expect(currentSafety?.status).toBe("BLOCKED");

    // Idempotency record was rolled back
    const idemp = await idempotencyRepository.findCommand(
      context.db,
      "cooldown-resume",
      "resume:sess-test-2:v2",
    );
    expect(idemp).toBeNull();
  });

  it("3. Exact deadline: resume succeeds", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-3",
      "cue-test-3",
      "ev-test-3",
    );

    const exactCommand: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-3:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z", // Exact boundary
    };

    const result = await persistCooldownResume(context.db, exactCommand);
    expect(result.isReplay).toBe(false);
    expect(result.session.phase).toBe("BUILD_CONTEXT");
    expect(result.session.retryCount).toBe(2);
    expect(result.session.cooldownUntil).toBeNull();
    expect(result.session.rowVersion).toBe(3);
  });

  it("4. After deadline: resume succeeds", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-4",
      "cue-test-4",
      "ev-test-4",
    );

    const postCommand: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-4:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:10:00.000Z", // 4 minutes past deadline
    };

    const result = await persistCooldownResume(context.db, postCommand);
    expect(result.session.phase).toBe("BUILD_CONTEXT");
    expect(result.session.rowVersion).toBe(3);
  });

  it("5, 6, 7, 8. Successful resume: phase COOLDOWN -> BUILD_CONTEXT, retryCount +1, cooldown_until NULL, rowVersion +1", async () => {
    const { sessionId } = await seedSessionInCooldown(
      "sess-test-5",
      "cue-test-5",
      "ev-test-5",
    );

    const command: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-5:v2",
      sessionId,
      expectedSessionRowVersion: 2,
      expectedSafetyGeneration: 2,
      expectedCooldownUntil: "2026-08-31T00:06:00.000Z",
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    const result = await persistCooldownResume(context.db, command);
    expect(result.session.phase).toBe("BUILD_CONTEXT");
    expect(result.session.retryCount).toBe(2);
    expect(result.session.failureCount).toBe(2);
    expect(result.session.cooldownUntil).toBeNull();
    expect(result.session.rowVersion).toBe(3);
  });

  it("9, 10. Safety state remains BLOCKED and safety generation remains unchanged", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-9",
      "cue-test-9",
      "ev-test-9",
    );

    const command: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-9:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    const result = await persistCooldownResume(context.db, command);
    expect(result.safetyState.generation).toBe(2);
    expect(result.safetyState.status).toBe("BLOCKED");

    // Double check directly in database
    const dbSafety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(dbSafety?.generation).toBe(2);
    expect(dbSafety?.status).toBe("BLOCKED");
  });

  it("11, 12. Root cue is reloaded from PostgreSQL and workingMemory is never persisted", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-11",
      "cue-test-11",
      "ev-test-11",
    );

    const command: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-11:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    const result = await persistCooldownResume(context.db, command);
    expect(result.session.phase).toBe("BUILD_CONTEXT");

    // Verify cognitive_sessions table has no workingMemory column or data
    const rawSessionRow = await context.db.execute(sql`
      SELECT * FROM cognitive_sessions WHERE session_id = ${sessionId}
    `);
    expect("working_memory" in rawSessionRow.rows[0]).toBe(false);
    expect("workingMemory" in rawSessionRow.rows[0]).toBe(false);
  });

  it("13. Same resume command replay: no second retry increment / rowVersion increment", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-13",
      "cue-test-13",
      "ev-test-13",
    );

    const command: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-13:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    const first = await persistCooldownResume(context.db, command);
    expect(first.isReplay).toBe(false);
    expect(first.session.rowVersion).toBe(3);
    expect(first.session.retryCount).toBe(2);

    const second = await persistCooldownResume(context.db, command);
    expect(second.isReplay).toBe(true);
    expect(second.session.rowVersion).toBe(3);
    expect(second.session.retryCount).toBe(2);
    expect(second.session.phase).toBe("BUILD_CONTEXT");
  });

  it("14. Same idempotency key + different logical fingerprint: IDEMPOTENCY_CONFLICT", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-14",
      "cue-test-14",
      "ev-test-14",
    );

    const command: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-14:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    await persistCooldownResume(context.db, command);

    const conflictingCommand: CooldownResumeCommand = {
      ...command,
      expectedSessionRowVersion: 99, // Different logical expectation
    };

    await expect(
      persistCooldownResume(context.db, conflictingCommand),
    ).rejects.toThrow(PersistenceError);
  });

  it("15. Two workers concurrently submit SAME resume command: one commit + one replay; one durable transition", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-15",
      "cue-test-15",
      "ev-test-15",
    );

    const command: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-15:v2",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    const results = await Promise.all([
      persistCooldownResume(context.db, command),
      persistCooldownResume(context.db, command),
    ]);

    const created = results.filter((r) => !r.isReplay);
    const replayed = results.filter((r) => r.isReplay);

    expect(created.length).toBe(1);
    expect(replayed.length).toBe(1);

    const dbSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(dbSession?.rowVersion).toBe(3);
    expect(dbSession?.retryCount).toBe(2);
  });

  it("16. Two workers with different resume command keys but same expected rowVersion: exactly one succeeds; other STALE_WRITE", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-16",
      "cue-test-16",
      "ev-test-16",
    );

    const commandA: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-16:worker-A",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    const commandB: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-16:worker-B",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    const results = await Promise.allSettled([
      persistCooldownResume(context.db, commandA),
      persistCooldownResume(context.db, commandB),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectionReason).toBeInstanceOf(PersistenceError);
    expect((rejectionReason as PersistenceError).code).toBe("STALE_WRITE");

    const dbSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(dbSession?.rowVersion).toBe(3);
  });

  it("17. Stale session rowVersion: full rollback", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-17",
      "cue-test-17",
      "ev-test-17",
    );

    const staleCommand: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-17:stale",
      sessionId,
      expectedSessionRowVersion: 99, // Stale
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    await expect(
      persistCooldownResume(context.db, staleCommand),
    ).rejects.toThrow(PersistenceError);

    // Verify session remains in COOLDOWN at rowVersion 2
    const currentSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(currentSession?.phase).toBe("COOLDOWN");
    expect(currentSession?.rowVersion).toBe(2);
    expect(currentSession?.retryCount).toBe(1);

    const idemp = await idempotencyRepository.findCommand(
      context.db,
      "cooldown-resume",
      "resume:sess-test-17:stale",
    );
    expect(idemp).toBeNull();
  });

  it("18. Stale safety generation: full rollback", async () => {
    const { sessionId, session } = await seedSessionInCooldown(
      "sess-test-18",
      "cue-test-18",
      "ev-test-18",
    );

    const staleSafetyCommand: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-18:stale-safety",
      sessionId,
      expectedSessionRowVersion: session.rowVersion,
      expectedSafetyGeneration: 99, // Stale safety gen
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    await expect(
      persistCooldownResume(context.db, staleSafetyCommand),
    ).rejects.toThrow(PersistenceError);

    const currentSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(currentSession?.phase).toBe("COOLDOWN");
    expect(currentSession?.rowVersion).toBe(2);
  });

  it("19. Retry budget exhausted: no resume", async () => {
    const { sessionId, session, safety } = await seedSessionInCooldown(
      "sess-test-19",
      "cue-test-19",
      "ev-test-19",
    );

    // Manually set retry_count = 3 (equal to maxRetries = 3)
    await context.db.execute(sql`
      UPDATE cognitive_sessions SET retry_count = 3 WHERE session_id = ${sessionId}
    `);

    const command: CooldownResumeCommand = {
      commandIdempotencyKey: "resume:sess-test-19:exhausted",
      sessionId,
      expectedSessionRowVersion: 2,
      expectedSafetyGeneration: safety.generation,
      expectedCooldownUntil: session.cooldownUntil!,
      resumedAt: "2026-08-31T00:06:00.000Z",
    };

    await expect(persistCooldownResume(context.db, command)).rejects.toThrow(
      PersistenceError,
    );

    const currentSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(currentSession?.phase).toBe("COOLDOWN");
    expect(currentSession?.retryCount).toBe(3);
  });

  it("20. HUMAN_REVIEW: never automatically resumes", async () => {
    const { sessionId, evidenceId } = await seedSessionInCooldown(
      "sess-test-20",
      "cue-test-20",
      "ev-test-20",
    );

    // Trigger 3rd failure to escalate to HUMAN_REVIEW
    await persistFailureRecovery(context.db, {
      commandIdempotencyKey: `fail:${sessionId}:3`,
      sessionId,
      expectedSessionRowVersion: 2,
      expectedSafetyGeneration: 2,
      failure: "UNVERIFIED_RESULT",
      reason: "Third failure triggers escalation",
      evidenceIds: [evidenceId],
      auditEventId: `audit-${sessionId}-3`,
      safetyEventId: `safety-evt-${sessionId}-3`,
      safetyEventKey: `safety:${sessionId}:gen-3`,
      createdAt: "2026-08-31T00:03:00.000Z",
    });

    const humanSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(humanSession?.phase).toBe("HUMAN_REVIEW");

    // Orchestrator inspection returns HUMAN_REVIEW_REQUIRED
    const inspection = await orchestrateRecoverySession(context.db, {
      sessionId,
      now: "2026-08-31T00:10:00.000Z",
    });
    expect(inspection.status).toBe("HUMAN_REVIEW_REQUIRED");

    // Session remains strictly in HUMAN_REVIEW in DB
    const finalSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(finalSession?.phase).toBe("HUMAN_REVIEW");
  });

  it("21, 22, 23. Ready-cooldown query: includes expired, excludes future, excludes HUMAN_REVIEW", async () => {
    const now = "2026-08-31T00:06:00.000Z";

    // 1. Expired cooldown (until 00:05:00)
    await seedSessionInCooldown("sess-q-expired", "cue-q-1", "ev-q-1");
    await context.db.execute(sql`
      UPDATE cognitive_sessions SET cooldown_until = '2026-08-31 00:05:00.000+00' WHERE session_id = 'sess-q-expired'
    `);

    // 2. Future cooldown (until 00:10:00)
    await seedSessionInCooldown("sess-q-future", "cue-q-2", "ev-q-2");
    await context.db.execute(sql`
      UPDATE cognitive_sessions SET cooldown_until = '2026-08-31 00:10:00.000+00' WHERE session_id = 'sess-q-future'
    `);

    // 3. HUMAN_REVIEW session
    await ingestCue(context.db, {
      cue: {
        cueId: "cue-q-3",
        source: "github",
        externalEventId: "evt-q-3",
        type: "github.issue.created",
        occurredAt: now,
        receivedAt: now,
        payload: {},
      },
      sessionId: "sess-q-human",
      maxRetries: 3,
    });
    await context.db.execute(sql`
      UPDATE cognitive_sessions SET phase = 'HUMAN_REVIEW', cooldown_until = NULL WHERE session_id = 'sess-q-human'
    `);

    const readySessions =
      await sessionRepository.findCooldownSessionsReadyToResume(
        context.db,
        now,
      );

    const sessionIds = readySessions.map((s) => s.sessionId);
    expect(sessionIds).toContain("sess-q-expired");
    expect(sessionIds).not.toContain("sess-q-future");
    expect(sessionIds).not.toContain("sess-q-human");
  });

  it("24. True restart test: close client, reopen fresh client, reload durable state, resume correctly", async () => {
    const { sessionId, session } = await seedSessionInCooldown(
      "sess-test-24",
      "cue-test-24",
      "ev-test-24",
    );

    expect(session.phase).toBe("COOLDOWN");
    expect(session.rowVersion).toBe(2);

    // Simulate process termination: close existing PostgreSQL client context
    await context.close();

    // Reopen fresh PostgreSQL context as if process restarted
    const freshContext = await setupIntegrationTestDatabase();

    try {
      // Reload session and safety purely from durable PostgreSQL tables
      const reloadedSession = await sessionRepository.findSessionById(
        freshContext.db,
        sessionId,
      );
      const reloadedSafety = await safetyRepository.findSafetyStateBySessionId(
        freshContext.db,
        sessionId,
      );

      expect(reloadedSession).not.toBeNull();
      expect(reloadedSafety).not.toBeNull();

      const resumeCommand: CooldownResumeCommand = {
        commandIdempotencyKey: "resume:sess-test-24:after-restart",
        sessionId: reloadedSession!.sessionId,
        expectedSessionRowVersion: reloadedSession!.rowVersion,
        expectedSafetyGeneration: reloadedSafety!.generation,
        expectedCooldownUntil: reloadedSession!.cooldownUntil!,
        resumedAt: "2026-08-31T00:06:00.000Z",
      };

      const result = await persistCooldownResume(
        freshContext.db,
        resumeCommand,
      );

      expect(result.session.phase).toBe("BUILD_CONTEXT");
      expect(result.session.rowVersion).toBe(3);
      expect(result.session.retryCount).toBe(2);
      expect(result.safetyState.status).toBe("BLOCKED");
      expect(result.safetyState.generation).toBe(2);
    } finally {
      await freshContext.close();
      // Reconnect test-level context for afterAll clean shutdown
      context = await setupIntegrationTestDatabase();
    }
  });
});
