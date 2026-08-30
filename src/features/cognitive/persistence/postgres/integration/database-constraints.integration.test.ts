import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PostgresDatabaseContext } from "../client";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";

function extractDbErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    if (
      "code" in error &&
      typeof (error as { code: unknown }).code === "string"
    ) {
      return (error as { code: string }).code;
    }
    if (
      "cause" in error &&
      typeof (error as { cause: unknown }).cause === "object" &&
      (error as { cause: unknown }).cause !== null
    ) {
      const cause = (error as { cause: Record<string, unknown> }).cause;
      if (typeof cause.code === "string") {
        return cause.code;
      }
    }
  }
  return undefined;
}

describe("live PostgreSQL database constraints and migration smoke test", () => {
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

  it("Test 1: Migration Smoke Test - verifies key tables exist after migration", async () => {
    const requiredTables = [
      "cues",
      "cognitive_sessions",
      "executions",
      "execution_operations",
      "execution_safety_state",
      "execution_safety_events",
      "failure_audit_events",
      "reward_events",
      "verified_memory",
      "idempotency_records",
    ];

    const result = await context.db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);

    const existingTables = new Set(
      result.rows.map((row) => (row as { table_name: string }).table_name),
    );

    for (const table of requiredTables) {
      expect(
        existingTables.has(table),
        `Expected table "${table}" to exist in migrated database`,
      ).toBe(true);
    }
  });

  it("Test 2: Database Rejects Stored ALLOWED - PostgreSQL CHECK constraint rejects ALLOWED durable_status", async () => {
    const cueId = "cue-test-allowed";
    const sessionId = "session-test-allowed";

    await context.db.execute(sql`
      INSERT INTO cues (cue_id, source, external_event_id, cue_type, occurred_at, received_at, payload, payload_hash)
      VALUES (${cueId}, 'test', 'evt-allowed', 'user.action', NOW(), NOW(), '{}', 'hash-1')
    `);

    await context.db.execute(sql`
      INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
      VALUES (${sessionId}, ${cueId}, 'CUE', 0, 0, 2, 0, NOW(), NOW())
    `);

    try {
      await context.db.execute(sql`
        INSERT INTO execution_safety_state (
          session_id, generation, durable_status, reason, updated_at
        ) VALUES (
          ${sessionId}, 0, 'ALLOWED', 'Testing forbidden stored state', NOW()
        )
      `);
      expect.unreachable(
        "Database should have rejected durable_status = 'ALLOWED'",
      );
    } catch (error: unknown) {
      expect(extractDbErrorCode(error)).toBe("23514"); // check_violation
    }

    // Verify database and connection remain operational afterward
    const verifyQuery = await context.db.execute(sql`SELECT 1 as alive`);
    expect(verifyQuery.rows.length).toBe(1);
  });

  it("Test 3: Cognitive Session CHECK Constraints - rejects invalid states", async () => {
    const cueId = "cue-test-check";
    await context.db.execute(sql`
      INSERT INTO cues (cue_id, source, external_event_id, cue_type, occurred_at, received_at, payload, payload_hash)
      VALUES (${cueId}, 'test', 'evt-check-constraints', 'user.action', NOW(), NOW(), '{}', 'hash-2')
    `);

    // 1. failure_count < 0
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
        VALUES ('s-neg-fail', ${cueId}, 'CUE', -1, 0, 2, 0, NOW(), NOW())
      `);
      expect.unreachable("Should have rejected failure_count < 0");
    } catch (error: unknown) {
      expect(extractDbErrorCode(error)).toBe("23514");
    }

    // 2. retry_count > max_retries
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
        VALUES ('s-retry-exceeded', ${cueId}, 'CUE', 0, 3, 2, 0, NOW(), NOW())
      `);
      expect.unreachable("Should have rejected retry_count > max_retries");
    } catch (error: unknown) {
      expect(extractDbErrorCode(error)).toBe("23514");
    }

    // 3. COOLDOWN phase with null cooldown_until
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, cooldown_until, row_version, created_at, updated_at)
        VALUES ('s-null-cooldown', ${cueId}, 'COOLDOWN', 0, 0, 2, NULL, 0, NOW(), NOW())
      `);
      expect.unreachable(
        "Should have rejected COOLDOWN with null cooldown_until",
      );
    } catch (error: unknown) {
      expect(extractDbErrorCode(error)).toBe("23514");
    }

    // 4. Non-COOLDOWN phase with non-null cooldown_until
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, cooldown_until, row_version, created_at, updated_at)
        VALUES ('s-invalid-cooldown', ${cueId}, 'PERCEIVE', 0, 0, 2, NOW() + interval '10 minutes', 0, NOW(), NOW())
      `);
      expect.unreachable(
        "Should have rejected PERCEIVE with non-null cooldown_until",
      );
    } catch (error: unknown) {
      expect(extractDbErrorCode(error)).toBe("23514");
    }
  });

  it("Test 15: Foreign Key Defense - rejects executions referencing non-existent session/plan", async () => {
    try {
      await context.db.execute(sql`
        INSERT INTO executions (
          execution_id, session_id, plan_id, status, row_version, created_at, updated_at
        ) VALUES (
          'exec-bad-fk', 'non-existent-session', 'non-existent-plan', 'PENDING', 0, NOW(), NOW()
        )
      `);
      expect.unreachable("Should have rejected FK violation");
    } catch (error: unknown) {
      expect(extractDbErrorCode(error)).toBe("23503"); // foreign_key_violation
    }
  });

  it("Test 16: Append-Only Duplicate Barrier - rejects duplicate ledger event insertion", async () => {
    const cueId = "cue-test-ledger";
    const sessionId = "session-test-ledger";
    const auditId = "audit-test-ledger-1";

    await context.db.execute(sql`
      INSERT INTO cues (cue_id, source, external_event_id, cue_type, occurred_at, received_at, payload, payload_hash)
      VALUES (${cueId}, 'test', 'evt-ledger', 'user.action', NOW(), NOW(), '{}', 'hash-3')
    `);

    await context.db.execute(sql`
      INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
      VALUES (${sessionId}, ${cueId}, 'CUE', 0, 0, 2, 0, NOW(), NOW())
    `);

    await context.db.execute(sql`
      INSERT INTO failure_audit_events (
        audit_event_id, logical_failure_key, session_id, failure_code, original_phase,
        failure_count, retry_count, from_safety_generation, revoked_safety_generation,
        recovery_action, reason, created_at
      ) VALUES (
        ${auditId}, 'fail:key:1', ${sessionId}, 'HALLUCINATION_DETECTED', 'GROUND_VERIFY',
        1, 0, 0, 1,
        'START_COOLDOWN', 'Grounding check failed', NOW()
      )
    `);

    // Attempt duplicate primary key insertion on failure_audit_events
    try {
      await context.db.execute(sql`
        INSERT INTO failure_audit_events (
          audit_event_id, logical_failure_key, session_id, failure_code, original_phase,
          failure_count, retry_count, from_safety_generation, revoked_safety_generation,
          recovery_action, reason, created_at
        ) VALUES (
          ${auditId}, 'fail:key:2', ${sessionId}, 'HALLUCINATION_DETECTED', 'GROUND_VERIFY',
          1, 0, 0, 1,
          'START_COOLDOWN', 'Duplicate attempt', NOW()
        )
      `);
      expect.unreachable(
        "Should have rejected duplicate failure_audit_event_id",
      );
    } catch (error: unknown) {
      expect(extractDbErrorCode(error)).toBe("23505"); // unique_violation
    }
  });
});
