import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { evidenceRecords } from "./decisions";

export const verifiedMemory = pgTable(
  "verified_memory",
  {
    memoryId: varchar("memory_id", { length: 256 }).primaryKey(),
    kind: varchar("kind", { length: 64 }).notNull(),
    memoryKey: varchar("memory_key", { length: 256 }).notNull(),
    memoryVersion: integer("memory_version").notNull().default(1),
    content: jsonb("content").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    admissionRuleVersion: varchar("admission_rule_version", {
      length: 256,
    }).notNull(),
    supersedesMemoryId: varchar("supersedes_memory_id", { length: 256 }),
    verifiedAt: timestamp("verified_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("verified_memory_kind_key_version_unique").on(
      table.kind,
      table.memoryKey,
      table.memoryVersion,
    ),
    index("verified_memory_kind_key_idx").on(table.kind, table.memoryKey),
    check(
      "verified_memory_kind_valid",
      sql`${table.kind} IN ('FACT', 'POLICY', 'SKILL', 'PROCEDURE')`,
    ),
    check("verified_memory_version_positive", sql`${table.memoryVersion} >= 1`),
    check(
      "verified_memory_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  ],
);

export const verifiedMemorySources = pgTable(
  "verified_memory_sources",
  {
    memoryId: varchar("memory_id", { length: 256 })
      .notNull()
      .references(() => verifiedMemory.memoryId, { onDelete: "cascade" }),
    evidenceId: varchar("evidence_id", { length: 256 })
      .notNull()
      .references(() => evidenceRecords.evidenceId, {
        onDelete: "restrict",
      }),
  },
  (table) => [
    primaryKey({
      name: "verified_memory_sources_pk",
      columns: [table.memoryId, table.evidenceId],
    }),
  ],
);

export const verifiedMemoryHeads = pgTable(
  "verified_memory_heads",
  {
    kind: varchar("kind", { length: 64 }).notNull(),
    memoryKey: varchar("memory_key", { length: 256 }).notNull(),
    memoryId: varchar("memory_id", { length: 256 })
      .notNull()
      .references(() => verifiedMemory.memoryId, { onDelete: "restrict" }),
    memoryVersion: integer("memory_version").notNull(),
    rowVersion: integer("row_version").notNull().default(0),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "verified_memory_heads_pk",
      columns: [table.kind, table.memoryKey],
    }),
    check(
      "verified_memory_heads_version_positive",
      sql`${table.memoryVersion} >= 1`,
    ),
    check(
      "verified_memory_heads_row_version_non_negative",
      sql`${table.rowVersion} >= 0`,
    ),
  ],
);
