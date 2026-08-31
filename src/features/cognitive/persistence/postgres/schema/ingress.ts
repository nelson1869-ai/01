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

import { cognitiveSessions } from "./cognitive";

export const cues = pgTable(
  "cues",
  {
    cueId: varchar("cue_id", { length: 256 }).primaryKey(),
    source: varchar("source", { length: 256 }).notNull(),
    externalEventId: varchar("external_event_id", { length: 256 }).notNull(),
    cueType: varchar("cue_type", { length: 256 }).notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    payload: jsonb("payload").notNull(),
    payloadExpiresAt: timestamp("payload_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    payloadHash: varchar("payload_hash", { length: 512 }),
  },
  (table) => [
    unique("cues_source_external_event_id_unique").on(
      table.source,
      table.externalEventId,
    ),
    check("cues_source_non_empty", sql`length(trim(${table.source})) > 0`),
    check(
      "cues_external_event_id_non_empty",
      sql`length(trim(${table.externalEventId})) > 0`,
    ),
  ],
);

export const authoritativePerceptionSnapshots = pgTable(
  "authoritative_perception_snapshots",
  {
    snapshotId: varchar("snapshot_id", { length: 256 }).primaryKey(),
    sessionId: varchar("session_id", { length: 256 })
      .notNull()
      .references(() => cognitiveSessions.sessionId, { onDelete: "restrict" }),
    cueId: varchar("cue_id", { length: 256 })
      .notNull()
      .references(() => cues.cueId, { onDelete: "restrict" }),
    evaluationGeneration: integer("evaluation_generation").notNull(),
    summary: text("summary").notNull(),
    structuredFacts: jsonb("structured_facts").notNull().default({}),
    targetSpec: jsonb("target_spec"),
    perceivedAt: timestamp("perceived_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("perception_snapshots_session_generation_unique").on(
      table.sessionId,
      table.evaluationGeneration,
    ),
    index("perception_snapshots_session_idx").on(table.sessionId),
    check(
      "perception_snapshots_generation_positive",
      sql`${table.evaluationGeneration} >= 1`,
    ),
  ],
);
