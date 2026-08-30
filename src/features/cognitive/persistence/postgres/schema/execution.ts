import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { cognitiveSessions } from "./cognitive";
import { actionPlans, actionPlanSteps } from "./planning";

export const executions = pgTable(
  "executions",
  {
    executionId: varchar("execution_id", { length: 256 }).primaryKey(),
    sessionId: varchar("session_id", { length: 256 })
      .notNull()
      .references(() => cognitiveSessions.sessionId, {
        onDelete: "restrict",
      }),
    planId: varchar("plan_id", { length: 256 })
      .notNull()
      .references(() => actionPlans.planId, { onDelete: "restrict" }),
    status: varchar("status", { length: 64 }).notNull(),
    currentStepId: varchar("current_step_id", { length: 256 }),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    error: text("error"),
    safetyGenerationAtStart: bigint("safety_generation_at_start", {
      mode: "number",
    }),
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
    index("executions_session_id_idx").on(table.sessionId),
    index("executions_plan_id_idx").on(table.planId),
    check(
      "executions_status_valid",
      sql`${table.status} IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED')`,
    ),
    check("executions_row_version_non_negative", sql`${table.rowVersion} >= 0`),
    check(
      "executions_safety_generation_at_start_valid",
      sql`${table.safetyGenerationAtStart} IS NULL OR (${table.safetyGenerationAtStart} >= 0 AND ${table.safetyGenerationAtStart} <= 9007199254740991)`,
    ),
    check(
      "executions_status_timestamp_invariant",
      sql`(${table.status} = 'PENDING' AND ${table.startedAt} IS NULL AND ${table.completedAt} IS NULL) OR (${table.status} = 'RUNNING' AND ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.safetyGenerationAtStart} IS NOT NULL) OR (${table.status} IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND ${table.completedAt} IS NOT NULL) OR (${table.status} = 'BLOCKED' AND ${table.completedAt} IS NOT NULL AND ${table.error} IS NOT NULL)`,
    ),
  ],
);

export const executionStepState = pgTable(
  "execution_step_state",
  {
    executionId: varchar("execution_id", { length: 256 })
      .notNull()
      .references(() => executions.executionId, { onDelete: "restrict" }),
    planId: varchar("plan_id", { length: 256 }).notNull(),
    stepId: varchar("step_id", { length: 256 }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    operationGeneration: integer("operation_generation").notNull().default(1),
    rowVersion: integer("row_version").notNull().default(0),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    error: text("error"),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "execution_step_state_pk",
      columns: [table.executionId, table.stepId],
    }),
    foreignKey({
      name: "execution_step_state_step_fk",
      columns: [table.planId, table.stepId],
      foreignColumns: [actionPlanSteps.planId, actionPlanSteps.stepId],
    }).onDelete("restrict"),
    check(
      "execution_step_state_status_valid",
      sql`${table.status} IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED')`,
    ),
    check(
      "execution_step_state_operation_generation_positive",
      sql`${table.operationGeneration} >= 1`,
    ),
    check(
      "execution_step_state_row_version_non_negative",
      sql`${table.rowVersion} >= 0`,
    ),
  ],
);

export const executionOperations = pgTable(
  "execution_operations",
  {
    operationId: varchar("operation_id", { length: 256 }).primaryKey(),
    executionId: varchar("execution_id", { length: 256 })
      .notNull()
      .references(() => executions.executionId, { onDelete: "restrict" }),
    stepId: varchar("step_id", { length: 256 }).notNull(),
    operationGeneration: integer("operation_generation").notNull().default(1),
    operationKind: varchar("operation_kind", { length: 256 }).notNull(),
    operationIdempotencyKey: varchar("operation_idempotency_key", {
      length: 512,
    }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 512,
    }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerScope: varchar("provider_scope", { length: 256 }),
    providerIdempotencyKey: varchar("provider_idempotency_key", {
      length: 512,
    }),
    providerOperationId: varchar("provider_operation_id", {
      length: 256,
    }),
    uncertaintyReason: text("uncertainty_reason"),
    reconciliationStatus: varchar("reconciliation_status", { length: 64 })
      .notNull()
      .default("NOT_REQUIRED"),
    reconciliationOutcome: text("reconciliation_outcome"),
    resultMetadata: jsonb("result_metadata"),
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
    unique("execution_operations_execution_step_generation_unique").on(
      table.executionId,
      table.stepId,
      table.operationGeneration,
    ),
    unique("execution_operations_operation_idempotency_key_unique").on(
      table.operationIdempotencyKey,
    ),
    index("execution_operations_execution_id_idx").on(table.executionId),
    index("execution_operations_status_idx").on(table.status),
    check(
      "execution_operations_status_valid",
      sql`${table.status} IN ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN')`,
    ),
    check(
      "execution_operations_reconciliation_status_valid",
      sql`${table.reconciliationStatus} IN ('NOT_REQUIRED', 'REQUIRED', 'RECONCILED')`,
    ),
    check(
      "execution_operations_operation_generation_positive",
      sql`${table.operationGeneration} >= 1`,
    ),
    check(
      "execution_operations_attempt_count_non_negative",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "execution_operations_row_version_non_negative",
      sql`${table.rowVersion} >= 0`,
    ),
    check(
      "execution_operations_unknown_uncertainty_invariant",
      sql`(${table.status} = 'UNKNOWN' AND ${table.uncertaintyReason} IS NOT NULL) OR (${table.status} <> 'UNKNOWN' AND ${table.uncertaintyReason} IS NULL)`,
    ),
  ],
);

export const executionOperationAttempts = pgTable(
  "execution_operation_attempts",
  {
    attemptId: varchar("attempt_id", { length: 256 }).primaryKey(),
    operationId: varchar("operation_id", { length: 256 })
      .notNull()
      .references(() => executionOperations.operationId, {
        onDelete: "restrict",
      }),
    attemptNumber: integer("attempt_number").notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    workerId: varchar("worker_id", { length: 256 }),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "string",
    }),
    errorSummary: text("error_summary"),
    providerMetadata: jsonb("provider_metadata"),
  },
  (table) => [
    unique("execution_operation_attempts_operation_attempt_number_unique").on(
      table.operationId,
      table.attemptNumber,
    ),
    check(
      "execution_operation_attempts_attempt_number_positive",
      sql`${table.attemptNumber} >= 1`,
    ),
  ],
);

export const executionEvents = pgTable(
  "execution_events",
  {
    executionEventId: varchar("execution_event_id", {
      length: 256,
    }).primaryKey(),
    executionId: varchar("execution_id", { length: 256 })
      .notNull()
      .references(() => executions.executionId, { onDelete: "restrict" }),
    transitionSequence: bigint("transition_sequence", {
      mode: "number",
    }).notNull(),
    fromStatus: varchar("from_status", { length: 64 }),
    toStatus: varchar("to_status", { length: 64 }).notNull(),
    stepId: varchar("step_id", { length: 256 }),
    safetyGeneration: bigint("safety_generation", { mode: "number" }),
    operationId: varchar("operation_id", { length: 256 }),
    eventKey: varchar("event_key", { length: 512 }).notNull(),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("execution_events_execution_transition_sequence_unique").on(
      table.executionId,
      table.transitionSequence,
    ),
    unique("execution_events_event_key_unique").on(table.eventKey),
    check(
      "execution_events_transition_sequence_non_negative",
      sql`${table.transitionSequence} >= 0`,
    ),
  ],
);
