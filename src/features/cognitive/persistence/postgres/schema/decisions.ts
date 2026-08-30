import { sql } from "drizzle-orm";
import {
  check,
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
import { cues } from "./ingress";

export const evidenceRecords = pgTable(
  "evidence_records",
  {
    evidenceId: varchar("evidence_id", { length: 256 }).primaryKey(),
    source: varchar("source", { length: 256 }).notNull(),
    sourceId: varchar("source_id", { length: 256 }).notNull(),
    claim: text("claim").notNull(),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    providerMetadata: jsonb("provider_metadata"),
  },
  (table) => [
    check(
      "evidence_records_source_non_empty",
      sql`length(trim(${table.source})) > 0`,
    ),
    check(
      "evidence_records_source_id_non_empty",
      sql`length(trim(${table.sourceId})) > 0`,
    ),
  ],
);

export const candidateActions = pgTable(
  "candidate_actions",
  {
    candidateId: varchar("candidate_id", { length: 256 }).primaryKey(),
    sessionId: varchar("session_id", { length: 256 })
      .notNull()
      .references(() => cognitiveSessions.sessionId, { onDelete: "restrict" }),
    cueId: varchar("cue_id", { length: 256 })
      .notNull()
      .references(() => cues.cueId, { onDelete: "restrict" }),
    goal: text("goal").notNull(),
    action: text("action").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    expectedUtility: numeric("expected_utility", {
      precision: 5,
      scale: 4,
    }).notNull(),
    estimatedRisk: numeric("estimated_risk", {
      precision: 5,
      scale: 4,
    }).notNull(),
    estimatedCost: numeric("estimated_cost", {
      precision: 5,
      scale: 4,
    }).notNull(),
    scoreValue: numeric("score_value", { precision: 5, scale: 4 }).notNull(),
    recommendation: varchar("recommendation", { length: 64 }).notNull(),
    scoreFormulaVersion: varchar("score_formula_version", {
      length: 256,
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("candidate_actions_session_candidate_unique").on(
      table.sessionId,
      table.candidateId,
    ),
    check(
      "candidate_actions_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "candidate_actions_expected_utility_range",
      sql`${table.expectedUtility} >= 0 AND ${table.expectedUtility} <= 1`,
    ),
    check(
      "candidate_actions_estimated_risk_range",
      sql`${table.estimatedRisk} >= 0 AND ${table.estimatedRisk} <= 1`,
    ),
    check(
      "candidate_actions_estimated_cost_range",
      sql`${table.estimatedCost} >= 0 AND ${table.estimatedCost} <= 1`,
    ),
    check(
      "candidate_actions_score_value_range",
      sql`${table.scoreValue} >= 0 AND ${table.scoreValue} <= 1`,
    ),
  ],
);

export const candidateEvidence = pgTable(
  "candidate_evidence",
  {
    candidateId: varchar("candidate_id", { length: 256 })
      .notNull()
      .references(() => candidateActions.candidateId, { onDelete: "cascade" }),
    evidenceId: varchar("evidence_id", { length: 256 })
      .notNull()
      .references(() => evidenceRecords.evidenceId, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "candidate_evidence_pk",
      columns: [table.candidateId, table.evidenceId],
    }),
    check(
      "candidate_evidence_ordinal_non_negative",
      sql`${table.ordinal} >= 0`,
    ),
  ],
);

export const groundingResults = pgTable(
  "grounding_results",
  {
    groundingResultId: varchar("grounding_result_id", {
      length: 256,
    }).primaryKey(),
    candidateId: varchar("candidate_id", { length: 256 })
      .notNull()
      .references(() => candidateActions.candidateId, {
        onDelete: "restrict",
      }),
    evaluationKey: varchar("evaluation_key", { length: 512 }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    reason: text("reason").notNull(),
    evaluatorVersion: varchar("evaluator_version", { length: 256 }).notNull(),
    evaluatedAt: timestamp("evaluated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("grounding_results_candidate_evaluation_key_unique").on(
      table.candidateId,
      table.evaluationKey,
    ),
    check(
      "grounding_results_status_valid",
      sql`${table.status} IN ('VERIFIED', 'CONTRADICTED', 'UNVERIFIED')`,
    ),
    check(
      "grounding_results_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  ],
);

export const groundingResultEvidence = pgTable(
  "grounding_result_evidence",
  {
    groundingResultId: varchar("grounding_result_id", { length: 256 })
      .notNull()
      .references(() => groundingResults.groundingResultId, {
        onDelete: "cascade",
      }),
    evidenceId: varchar("evidence_id", { length: 256 })
      .notNull()
      .references(() => evidenceRecords.evidenceId, {
        onDelete: "restrict",
      }),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "grounding_result_evidence_pk",
      columns: [table.groundingResultId, table.evidenceId],
    }),
    check(
      "grounding_result_evidence_ordinal_non_negative",
      sql`${table.ordinal} >= 0`,
    ),
  ],
);

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    policyDecisionId: varchar("policy_decision_id", {
      length: 256,
    }).primaryKey(),
    candidateId: varchar("candidate_id", { length: 256 })
      .notNull()
      .references(() => candidateActions.candidateId, {
        onDelete: "restrict",
      }),
    groundingResultId: varchar("grounding_result_id", { length: 256 })
      .notNull()
      .references(() => groundingResults.groundingResultId, {
        onDelete: "restrict",
      }),
    evaluationKey: varchar("evaluation_key", { length: 512 }).notNull(),
    outcome: varchar("outcome", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    policyEngineVersion: varchar("policy_engine_version", {
      length: 256,
    }).notNull(),
    evaluatedAt: timestamp("evaluated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("policy_decisions_candidate_evaluation_key_unique").on(
      table.candidateId,
      table.evaluationKey,
    ),
    check(
      "policy_decisions_outcome_valid",
      sql`${table.outcome} IN ('ALLOW', 'REQUIRE_HUMAN_CONFIRMATION', 'DENY')`,
    ),
  ],
);

export const policyDecisionPolicyRefs = pgTable(
  "policy_decision_policy_refs",
  {
    policyDecisionId: varchar("policy_decision_id", { length: 256 })
      .notNull()
      .references(() => policyDecisions.policyDecisionId, {
        onDelete: "cascade",
      }),
    policyId: varchar("policy_id", { length: 256 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "policy_decision_policy_refs_pk",
      columns: [table.policyDecisionId, table.policyId],
    }),
  ],
);
