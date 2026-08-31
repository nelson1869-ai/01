import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { resultVerifications } from "./audit";
import { executions } from "./execution";

export const rewardEvents = pgTable(
  "reward_events",
  {
    rewardEventId: varchar("reward_event_id", { length: 256 }).primaryKey(),
    rewardIdempotencyKey: varchar("reward_idempotency_key", {
      length: 512,
    }).notNull(),
    executionId: varchar("execution_id", { length: 256 })
      .notNull()
      .references(() => executions.executionId, {
        onDelete: "restrict",
      }),
    verificationId: varchar("verification_id", { length: 256 })
      .notNull()
      .references(() => resultVerifications.verificationId, {
        onDelete: "restrict",
      }),
    rewardRuleId: varchar("reward_rule_id", { length: 256 }).notNull(),
    signal: varchar("signal", { length: 64 }).notNull(),
    value: numeric("value", { precision: 10, scale: 4 }).notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("reward_events_verification_rule_unique").on(
      table.verificationId,
      table.rewardRuleId,
    ),
    unique("reward_events_reward_idempotency_key_unique").on(
      table.rewardIdempotencyKey,
    ),
    index("reward_events_execution_id_idx").on(table.executionId),
    index("reward_events_verification_id_idx").on(table.verificationId),
    check(
      "reward_events_signal_valid",
      sql`${table.signal} IN ('PERFECT', 'SUCCESS', 'HUMAN_APPROVAL', 'NEUTRAL', 'CORRECTION', 'FAILURE', 'HALLUCINATION', 'UNSAFE_ACTION')`,
    ),
  ],
);

export const learningState = pgTable(
  "learning_state",
  {
    skillKey: varchar("skill_key", { length: 256 }).primaryKey(),
    confidence: numeric("confidence", { precision: 5, scale: 4 })
      .notNull()
      .default("0.5000"),
    totalReward: numeric("total_reward", { precision: 12, scale: 4 })
      .notNull()
      .default("0.0000"),
    sampleCount: bigint("sample_count", { mode: "number" })
      .notNull()
      .default(0),
    rowVersion: integer("row_version").notNull().default(0),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    check(
      "learning_state_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "learning_state_sample_count_non_negative",
      sql`${table.sampleCount} >= 0`,
    ),
    check(
      "learning_state_row_version_non_negative",
      sql`${table.rowVersion} >= 0`,
    ),
  ],
);
