import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { cues } from "./ingress";

export const cognitiveSessions = pgTable(
  "cognitive_sessions",
  {
    sessionId: varchar("session_id", { length: 256 }).primaryKey(),
    cueId: varchar("cue_id", { length: 256 })
      .notNull()
      .references(() => cues.cueId, { onDelete: "restrict" }),
    phase: varchar("phase", { length: 64 }).notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(0),
    cooldownUntil: timestamp("cooldown_until", {
      withTimezone: true,
      mode: "string",
    }),
    currentCandidateId: varchar("current_candidate_id", { length: 256 }),
    currentPlanId: varchar("current_plan_id", { length: 256 }),
    currentExecutionId: varchar("current_execution_id", { length: 256 }),
    rowVersion: integer("row_version").notNull().default(0),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("cognitive_sessions_cue_id_unique").on(table.cueId),
    index("cognitive_sessions_cue_id_idx").on(table.cueId),
    check(
      "cognitive_sessions_failure_count_non_negative",
      sql`${table.failureCount} >= 0`,
    ),
    check(
      "cognitive_sessions_retry_count_non_negative",
      sql`${table.retryCount} >= 0`,
    ),
    check(
      "cognitive_sessions_max_retries_non_negative",
      sql`${table.maxRetries} >= 0`,
    ),
    check(
      "cognitive_sessions_retry_within_max",
      sql`${table.retryCount} <= ${table.maxRetries}`,
    ),
    check(
      "cognitive_sessions_row_version_non_negative",
      sql`${table.rowVersion} >= 0`,
    ),
    check(
      "cognitive_sessions_phase_cooldown_invariant",
      sql`(${table.phase} = 'COOLDOWN' AND ${table.cooldownUntil} IS NOT NULL) OR (${table.phase} <> 'COOLDOWN' AND ${table.cooldownUntil} IS NULL)`,
    ),
    check(
      "cognitive_sessions_phase_valid",
      sql`${table.phase} IN ('CUE', 'PERCEIVE', 'BUILD_CONTEXT', 'RETRIEVE_MEMORY', 'GENERATE_CANDIDATES', 'SCORE', 'GROUND_VERIFY', 'POLICY_SAFETY', 'PLAN', 'DURABLE_EXECUTION', 'ACT', 'OBSERVE', 'VERIFY_RESULT', 'REWARD', 'LEARN', 'SAVE_MEMORY', 'CLEAR_WORKING_MEMORY', 'COOLDOWN', 'HUMAN_REVIEW', 'IDLE')`,
    ),
  ],
);
