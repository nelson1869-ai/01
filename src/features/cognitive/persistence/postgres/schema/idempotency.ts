import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    scope: varchar("scope", { length: 256 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 512 }).notNull(),
    requestHash: varchar("request_hash", { length: 512 }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    resultResourceType: varchar("result_resource_type", { length: 256 }),
    resultResourceId: varchar("result_resource_id", { length: 256 }),
    errorCode: varchar("error_code", { length: 256 }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    primaryKey({
      name: "idempotency_records_pk",
      columns: [table.scope, table.idempotencyKey],
    }),
    check(
      "idempotency_records_status_valid",
      sql`${table.status} IN ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN')`,
    ),
  ],
);
