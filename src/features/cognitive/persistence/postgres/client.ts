import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema";

export interface PostgresDatabaseContext {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;
  readonly close: () => Promise<void>;
}

export function createPostgresDatabase(
  configOrConnectionString?: string | PoolConfig,
): PostgresDatabaseContext {
  const poolConfig: PoolConfig =
    typeof configOrConnectionString === "string"
      ? { connectionString: configOrConnectionString }
      : (configOrConnectionString ?? {});

  const pool = new Pool(poolConfig);
  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
}
