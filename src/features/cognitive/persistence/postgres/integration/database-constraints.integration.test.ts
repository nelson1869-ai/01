import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PostgresDatabaseContext } from "../client";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";

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
      VALUES (${cueId}, 'test', 'evt-allowed', 'test.event', NOW(), NOW(), '{}', 'hash-1');

      INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
      VALUES (${sessionId}, ${cueId}, 'CUE', 0, 0, 2, 0, NOW(), NOW());
    `);

    try {
      await context.db.execute(sql`
        INSERT INTO execution_safety_state (
          session_id, generation, durable_status, reason, updated_at
        ) VALUES (
          ${sessionId}, 0, 'ALLOWED', 'Testing forbidden stored state', NOW()
        );
      `);
      expect.unreachable(
        "Database should have rejected durable_status = 'ALLOWED'",
      );
    } catch (error: unknown) {
      const dbErr = error as { code?: string };
      expect(dbErr.code).toBe("23514"); // check_violation
    }

    // Verify database and connection remain operational afterward
    const verifyQuery = await context.db.execute(sql`SELECT 1 as alive`);
    expect(verifyQuery.rows.length).toBe(1);
  });

  it("Test 3: Cognitive Session CHECK Constraints - rejects invalid states", async () => {
    const cueId = "cue-test-check";
    await context.db.execute(sql`
      INSERT INTO cues (cue_id, source, external_event_id, cue_type, occurred_at, received_at, payload, payload_hash)
      VALUES (${cueId}, 'test', 'evt-check-constraints', 'test.event', NOW(), NOW(), '{}', 'hash-2');
    `);

    // 1. failure_count < 0
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
        VALUES ('s-neg-fail', ${cueId}, 'CUE', -1, 0, 2, 0, NOW(), NOW());
      `);
      expect.unreachable("Should have rejected failure_count < 0");
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("23514");
    }

    // 2. retry_count > max_retries
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
        VALUES ('s-retry-exceeded', ${cueId}, 'CUE', 0, 3, 2, 0, NOW(), NOW());
      `);
      expect.unreachable("Should have rejected retry_count > max_retries");
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("23514");
    }

    // 3. COOLDOWN phase with null cooldown_until
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, cooldown_until, row_version, created_at, updated_at)
        VALUES ('s-null-cooldown', ${cueId}, 'COOLDOWN', 0, 0, 2, NULL, 0, NOW(), NOW());
      `);
      expect.unreachable(
        "Should have rejected COOLDOWN with null cooldown_until",
      );
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("23514");
    }

    // 4. Non-COOLDOWN phase with non-null cooldown_until
    try {
      await context.db.execute(sql`
        INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, cooldown_until, row_version, created_at, updated_at)
        VALUES ('s-invalid-cooldown', ${cueId}, 'PERCEIVE', 0, 0, 2, NOW() + interval '10 minutes', 0, NOW(), NOW());
      `);
      expect.unreachable(
        "Should have rejected PERCEIVE with non-null cooldown_until",
      );
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("23514");
    }
  });

  it("Test 15: Foreign Key Defense - rejects executions referencing non-existent session/plan", async () => {
    try {
      await context.db.execute(sql`
        INSERT INTO executions (
          execution_id, session_id, plan_id, status, row_version, created_at, updated_at
        ) VALUES (
          'exec-bad-fk', 'non-existent-session', 'non-existent-plan', 'PENDING', 0, NOW(), NOW()
        );
      `);
      expect.unreachable("Should have rejected FK violation");
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("23503"); // foreign_key_violation
    }
  });

  it("Test 16: Append-Only Duplicate Barrier - rejects duplicate ledger event insertion", async () => {
    const cueId = "cue-test-ledger";
    const sessionId = "session-test-ledger";
    const candidateId = "cand-test-ledger";
    const groundingId = "ground-test-ledger";
    const policyId = "pol-test-ledger";
    const planId = "plan-test-ledger";
    const execId = "exec-test-ledger";
    const auditId = "audit-test-ledger-1";

    await context.db.execute(sql`
      INSERT INTO cues (cue_id, source, external_event_id, cue_type, occurred_at, received_at, payload, payload_hash)
      VALUES (${cueId}, 'test', 'evt-ledger', 'test.event', NOW(), NOW(), '{}', 'hash-3');

      INSERT INTO cognitive_sessions (session_id, cue_id, phase, failure_count, retry_count, max_retries, row_version, created_at, updated_at)
      VALUES (${sessionId}, ${cueId}, 'CUE', 0, 0, 2, 0, NOW(), NOW());

      INSERT INTO candidate_actions (candidate_id, session_id, action_name, action_kind, parameters, score, justification, created_at)
      VALUES (${candidateId}, ${sessionId}, 'test_action', 'TEST', '{}', 0.9, 'justification', NOW());

      INSERT INTO grounding_results (grounding_result_id, candidate_id, session_id, grounded, grounding_score, evaluation, created_at)
      VALUES (${groundingId}, ${candidateId}, ${sessionId}, true, 1.0, '{}', NOW());

      INSERT INTO policy_decisions (policy_decision_id, candidate_id, session_id, decision, score, reason, constraints_evaluated, created_at)
      VALUES (${policyId}, ${candidateId}, ${sessionId}, 'ALLOW', 1.0, 'Policy passed', '[]', NOW());

      INSERT INTO action_plans (plan_id, session_id, candidate_id, grounding_result_id, policy_decision_id, total_steps, created_at)
      VALUES (${planId}, ${sessionId}, ${candidateId}, ${groundingId}, ${policyId}, 1, NOW());

      INSERT INTO executions (execution_id, session_id, plan_id, status, row_version, created_at, updated_at)
      VALUES (${execId}, ${sessionId}, ${planId}, 'PENDING', 0, NOW(), NOW());

      INSERT INTO failure_audit_events (
        failure_audit_event_id, execution_id, session_id, failure_type, error_message, created_at
      ) VALUES (
        ${auditId}, ${execId}, ${sessionId}, 'EXECUTION_REJECTED', 'Initial failure', NOW()
      );
    `);

    // Attempt duplicate primary key insertion on failure_audit_events
    try {
      await context.db.execute(sql`
        INSERT INTO failure_audit_events (
          failure_audit_event_id, execution_id, session_id, failure_type, error_message, created_at
        ) VALUES (
          ${auditId}, ${execId}, ${sessionId}, 'EXECUTION_REJECTED', 'Duplicate attempt', NOW()
        );
      `);
      expect.unreachable(
        "Should have rejected duplicate failure_audit_event_id",
      );
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("23505"); // unique_violation
    }
  });
});
