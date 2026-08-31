import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { resultVerifications } from "./audit";
import { cognitiveSessions } from "./cognitive";
import { executions } from "./execution";
import { cues } from "./ingress";

export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    conversationId: varchar("conversation_id", { length: 256 }).primaryKey(),
    turnCount: integer("turn_count").notNull().default(0),
    rowVersion: integer("row_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("assistant_conversations_expires_at_idx").on(table.expiresAt),
    check("assistant_conversations_turn_count_non_negative", sql`${table.turnCount} >= 0`),
    check("assistant_conversations_row_version_non_negative", sql`${table.rowVersion} >= 0`),
    check("assistant_conversations_expiry_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const assistantTurns = pgTable(
  "assistant_turns",
  {
    turnId: varchar("turn_id", { length: 256 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 256 })
      .notNull()
      .references(() => assistantConversations.conversationId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    userMessage: text("user_message").notNull(),
    assistantMessage: text("assistant_message"),
    kind: varchar("kind", { length: 64 }),
    status: varchar("status", { length: 64 }).notNull(),
    decisionSummary: jsonb("decision_summary").notNull().default([]),
    cueId: varchar("cue_id", { length: 256 }).references(() => cues.cueId, { onDelete: "restrict" }),
    sessionId: varchar("session_id", { length: 256 }).references(
      () => cognitiveSessions.sessionId,
      { onDelete: "restrict" },
    ),
    executionId: varchar("execution_id", { length: 256 }).references(
      () => executions.executionId,
      { onDelete: "restrict" },
    ),
    verificationId: varchar("verification_id", { length: 256 }).references(
      () => resultVerifications.verificationId,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    unique("assistant_turns_conversation_ordinal_unique").on(
      table.conversationId,
      table.ordinal,
    ),
    index("assistant_turns_conversation_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("assistant_turns_session_id_idx").on(table.sessionId),
    index("assistant_turns_execution_id_idx").on(table.executionId),
    check("assistant_turns_ordinal_positive", sql`${table.ordinal} >= 1`),
    check("assistant_turns_user_message_length", sql`length(${table.userMessage}) BETWEEN 1 AND 8000`),
    check(
      "assistant_turns_assistant_message_length",
      sql`${table.assistantMessage} IS NULL OR length(${table.assistantMessage}) BETWEEN 1 AND 12000`,
    ),
    check(
      "assistant_turns_kind_valid",
      sql`${table.kind} IS NULL OR ${table.kind} IN ('DIRECT_ANSWER', 'TOOL_REQUIRED', 'CLARIFICATION', 'DENIED')`,
    ),
    check(
      "assistant_turns_status_valid",
      sql`${table.status} IN ('PROCESSING', 'COMPLETED', 'CLARIFICATION_REQUIRED', 'DENIED', 'FAILED', 'UNVERIFIED')`,
    ),
    check(
      "assistant_turns_completion_invariant",
      sql`(${table.status} = 'PROCESSING' AND ${table.assistantMessage} IS NULL AND ${table.completedAt} IS NULL) OR (${table.status} <> 'PROCESSING' AND ${table.assistantMessage} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);
