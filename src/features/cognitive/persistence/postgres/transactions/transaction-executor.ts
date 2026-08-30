import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  NodePgDatabase,
  NodePgQueryResultHKT,
} from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";

import * as schema from "../schema";

export type PostgresSchema = typeof schema;
export type DatabaseClient = NodePgDatabase<PostgresSchema>;
export type DatabaseTransaction = PgTransaction<
  NodePgQueryResultHKT,
  PostgresSchema,
  ExtractTablesWithRelations<PostgresSchema>
>;
export type DatabaseExecutor = DatabaseClient | DatabaseTransaction;

export async function runInTransaction<T>(
  executor: DatabaseExecutor,
  callback: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  if ("transaction" in executor && typeof executor.transaction === "function") {
    return await executor.transaction(async (tx) => {
      return await callback(tx as DatabaseExecutor);
    });
  }
  return await callback(executor);
}
