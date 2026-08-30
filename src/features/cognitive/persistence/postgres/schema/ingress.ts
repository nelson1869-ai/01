import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

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
