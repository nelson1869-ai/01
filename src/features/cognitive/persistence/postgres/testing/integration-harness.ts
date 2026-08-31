import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import {
  createPostgresDatabase,
  type PostgresDatabaseContext,
} from "../client";
import type { DatabaseClient } from "../transactions/transaction-executor";

function validateDatabaseUrl(url: string): string {
  let dbName = "";
  try {
    const parsed = new URL(url);
    dbName = parsed.pathname.replace(/^\//, "");
  } catch {
    throw new Error("Invalid TEST_DATABASE_URL connection string provided.");
  }

  if (!dbName.toLowerCase().includes("test")) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}". Database name must contain "test".`,
    );
  }

  return url;
}

export function getTestDatabaseUrl(explicitUrl?: string): string {
  if (explicitUrl !== undefined) {
    if (explicitUrl.trim().length === 0) {
      throw new Error(
        "TEST_DATABASE_URL is required for live PostgreSQL integration tests.",
      );
    }
    return validateDatabaseUrl(explicitUrl);
  }

  if (
    (!process.env.TEST_DATABASE_URL ||
      process.env.TEST_DATABASE_URL.trim().length === 0) &&
    typeof process.loadEnvFile === "function"
  ) {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      // ignore if .env.local is missing
    }
  }

  const url = process.env.TEST_DATABASE_URL;

  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error(
      "TEST_DATABASE_URL is required for live PostgreSQL integration tests.",
    );
  }

  return validateDatabaseUrl(url);
}

export async function setupIntegrationTestDatabase(): Promise<PostgresDatabaseContext> {
  const url = getTestDatabaseUrl();
  const dbContext = createPostgresDatabase(url);

  await migrate(dbContext.db, { migrationsFolder: "./drizzle" });

  return dbContext;
}

export async function cleanIntegrationTestTables(
  db: DatabaseClient,
): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      assistant_turns,
      assistant_conversations,
      cues,
      cognitive_sessions,
      evidence_records,
      candidate_actions,
      candidate_evidence,
      grounding_results,
      grounding_result_evidence,
      policy_decisions,
      policy_decision_policy_refs,
      action_plans,
      action_plan_steps,
      action_plan_step_dependencies,
      executions,
      execution_step_state,
      execution_operations,
      execution_operation_attempts,
      execution_events,
      execution_safety_state,
      execution_safety_events,
      observations,
      result_verifications,
      result_verification_observations,
      failure_audit_events,
      failure_audit_evidence,
      reward_events,
      learning_state,
      verified_memory,
      verified_memory_sources,
      verified_memory_heads,
      idempotency_records
    CASCADE;
  `);
}
