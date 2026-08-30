import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { cognitiveSessions } from "./cognitive";

export const executionSafetyState = pgTable(
  "execution_safety_state",
  {
    sessionId: varchar("session_id", { length: 256 })
      .primaryKey()
      .references(() => cognitiveSessions.sessionId, {
        onDelete: "restrict",
      }),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    durableStatus: varchar("durable_status", { length: 64 })
      .notNull()
      .default("UNAUTHORIZED"),
    failureCode: varchar("failure_code", { length: 64 }),
    reason: text("reason").notNull(),
    blockedAt: timestamp("blocked_at", {
      withTimezone: true,
      mode: "string",
    }),
    evaluatedCandidateId: varchar("evaluated_candidate_id", {
      length: 256,
    }),
    groundingResultId: varchar("grounding_result_id", { length: 256 }),
    policyDecisionId: varchar("policy_decision_id", { length: 256 }),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("execution_safety_state_session_id_idx").on(table.sessionId),
    check(
      "execution_safety_state_status_fail_closed",
      sql`${table.durableStatus} IN ('UNAUTHORIZED', 'BLOCKED')`,
    ),
    check(
      "execution_safety_state_generation_safe_range",
      sql`${table.generation} >= 0 AND ${table.generation} <= 9007199254740991`,
    ),
    check(
      "execution_safety_state_status_fields_invariant",
      sql`(${table.durableStatus} = 'UNAUTHORIZED' AND ${table.failureCode} IS NULL AND ${table.blockedAt} IS NULL) OR (${table.durableStatus} = 'BLOCKED' AND ${table.failureCode} IS NOT NULL AND ${table.blockedAt} IS NOT NULL)`,
    ),
    check(
      "execution_safety_state_evaluation_refs_all_or_none",
      sql`(${table.evaluatedCandidateId} IS NULL AND ${table.groundingResultId} IS NULL AND ${table.policyDecisionId} IS NULL) OR (${table.evaluatedCandidateId} IS NOT NULL AND ${table.groundingResultId} IS NOT NULL AND ${table.policyDecisionId} IS NOT NULL)`,
    ),
  ],
);

export const executionSafetyEvents = pgTable(
  "execution_safety_events",
  {
    safetyEventId: varchar("safety_event_id", { length: 256 }).primaryKey(),
    sessionId: varchar("session_id", { length: 256 })
      .notNull()
      .references(() => cognitiveSessions.sessionId, {
        onDelete: "restrict",
      }),
    fromGeneration: bigint("from_generation", { mode: "number" }).notNull(),
    toGeneration: bigint("to_generation", { mode: "number" }).notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    candidateId: varchar("candidate_id", { length: 256 }),
    groundingResultId: varchar("grounding_result_id", { length: 256 }),
    policyDecisionId: varchar("policy_decision_id", { length: 256 }),
    failureAuditEventId: varchar("failure_audit_event_id", {
      length: 256,
    }),
    eventKey: varchar("event_key", { length: 512 }).notNull(),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("execution_safety_events_session_to_generation_unique").on(
      table.sessionId,
      table.toGeneration,
    ),
    unique("execution_safety_events_event_key_unique").on(table.eventKey),
    check(
      "execution_safety_events_from_generation_safe_range",
      sql`${table.fromGeneration} >= 0 AND ${table.fromGeneration} <= 9007199254740991`,
    ),
    check(
      "execution_safety_events_to_generation_safe_range",
      sql`${table.toGeneration} >= 0 AND ${table.toGeneration} <= 9007199254740991`,
    ),
    check(
      "execution_safety_events_generation_advance_exact_one",
      sql`${table.toGeneration} = ${table.fromGeneration} + 1`,
    ),
  ],
);
