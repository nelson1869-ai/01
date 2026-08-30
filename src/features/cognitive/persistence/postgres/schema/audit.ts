import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { cognitiveSessions } from "./cognitive";
import { evidenceRecords } from "./decisions";
import { executions } from "./execution";

export const observations = pgTable(
  "observations",
  {
    observationId: varchar("observation_id", { length: 256 }).primaryKey(),
    executionId: varchar("execution_id", { length: 256 })
      .notNull()
      .references(() => executions.executionId, {
        onDelete: "restrict",
      }),
    stepId: varchar("step_id", { length: 256 }),
    source: varchar("source", { length: 256 }).notNull(),
    sourceEventId: varchar("source_event_id", { length: 256 }),
    summary: text("summary").notNull(),
    data: jsonb("data").notNull(),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    payloadExpiresAt: timestamp("payload_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("observations_execution_id_idx").on(table.executionId),
    unique("observations_execution_source_source_event_unique").on(
      table.executionId,
      table.source,
      table.sourceEventId,
    ),
  ],
);

export const resultVerifications = pgTable(
  "result_verifications",
  {
    verificationId: varchar("verification_id", {
      length: 256,
    }).primaryKey(),
    executionId: varchar("execution_id", { length: 256 })
      .notNull()
      .references(() => executions.executionId, {
        onDelete: "restrict",
      }),
    verificationGeneration: integer("verification_generation")
      .notNull()
      .default(1),
    observationSetDigest: varchar("observation_set_digest", {
      length: 512,
    }).notNull(),
    verifierVersion: varchar("verifier_version", {
      length: 256,
    }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    reason: text("reason").notNull(),
    verifiedAt: timestamp("verified_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("result_verifications_execution_generation_unique").on(
      table.executionId,
      table.verificationGeneration,
    ),
    unique("result_verifications_execution_digest_version_unique").on(
      table.executionId,
      table.observationSetDigest,
      table.verifierVersion,
    ),
    index("result_verifications_execution_id_idx").on(table.executionId),
    check(
      "result_verifications_generation_positive",
      sql`${table.verificationGeneration} >= 1`,
    ),
    check(
      "result_verifications_status_valid",
      sql`${table.status} IN ('VERIFIED', 'FAILED', 'INCONCLUSIVE')`,
    ),
    check(
      "result_verifications_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  ],
);

export const resultVerificationObservations = pgTable(
  "result_verification_observations",
  {
    verificationId: varchar("verification_id", { length: 256 })
      .notNull()
      .references(() => resultVerifications.verificationId, {
        onDelete: "cascade",
      }),
    observationId: varchar("observation_id", { length: 256 })
      .notNull()
      .references(() => observations.observationId, {
        onDelete: "restrict",
      }),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "result_verification_observations_pk",
      columns: [table.verificationId, table.observationId],
    }),
    check(
      "result_verification_observations_ordinal_non_negative",
      sql`${table.ordinal} >= 0`,
    ),
  ],
);

export const failureAuditEvents = pgTable(
  "failure_audit_events",
  {
    auditEventId: varchar("audit_event_id", { length: 256 }).primaryKey(),
    logicalFailureKey: varchar("logical_failure_key", {
      length: 512,
    }).notNull(),
    sessionId: varchar("session_id", { length: 256 })
      .notNull()
      .references(() => cognitiveSessions.sessionId, {
        onDelete: "restrict",
      }),
    candidateId: varchar("candidate_id", { length: 256 }),
    planId: varchar("plan_id", { length: 256 }),
    executionId: varchar("execution_id", { length: 256 }),
    stepId: varchar("step_id", { length: 256 }),
    failureCode: varchar("failure_code", { length: 64 }).notNull(),
    originalPhase: varchar("original_phase", { length: 64 }).notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    fromSafetyGeneration: bigint("from_safety_generation", {
      mode: "number",
    }).notNull(),
    revokedSafetyGeneration: bigint("revoked_safety_generation", {
      mode: "number",
    }).notNull(),
    recoveryAction: varchar("recovery_action", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("failure_audit_events_session_logical_key_unique").on(
      table.sessionId,
      table.logicalFailureKey,
    ),
    unique("failure_audit_events_session_revoked_generation_unique").on(
      table.sessionId,
      table.revokedSafetyGeneration,
    ),
    index("failure_audit_events_session_id_idx").on(table.sessionId),
    index("failure_audit_events_execution_id_idx").on(table.executionId),
    check(
      "failure_audit_events_failure_count_non_negative",
      sql`${table.failureCount} >= 0`,
    ),
    check(
      "failure_audit_events_retry_count_non_negative",
      sql`${table.retryCount} >= 0`,
    ),
    check(
      "failure_audit_events_from_generation_safe_range",
      sql`${table.fromSafetyGeneration} >= 0 AND ${table.fromSafetyGeneration} <= 9007199254740991`,
    ),
    check(
      "failure_audit_events_revoked_generation_safe_range",
      sql`${table.revokedSafetyGeneration} >= 0 AND ${table.revokedSafetyGeneration} <= 9007199254740991`,
    ),
    check(
      "failure_audit_events_failure_code_valid",
      sql`${table.failureCode} IN ('HALLUCINATION_DETECTED', 'POLICY_VIOLATION', 'EXECUTION_TIMEOUT', 'UNVERIFIED_RESULT')`,
    ),
    check(
      "failure_audit_events_recovery_action_valid",
      sql`${table.recoveryAction} IN ('RETRY_WITH_FRESH_CONTEXT', 'START_COOLDOWN', 'ESCALATE_TO_HUMAN')`,
    ),
  ],
);

export const failureAuditEvidence = pgTable(
  "failure_audit_evidence",
  {
    auditEventId: varchar("audit_event_id", { length: 256 })
      .notNull()
      .references(() => failureAuditEvents.auditEventId, {
        onDelete: "cascade",
      }),
    evidenceId: varchar("evidence_id", { length: 256 })
      .notNull()
      .references(() => evidenceRecords.evidenceId, {
        onDelete: "restrict",
      }),
  },
  (table) => [
    primaryKey({
      name: "failure_audit_evidence_pk",
      columns: [table.auditEventId, table.evidenceId],
    }),
  ],
);
