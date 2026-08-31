import { createPostgresDatabase, type PostgresDatabaseContext } from "./client";

let globalDbContext: PostgresDatabaseContext | null = null;

export function getDatabaseContext(): PostgresDatabaseContext {
  if (!globalDbContext) {
    const isTest =
      process.env.NODE_ENV === "test" ||
      process.env.VITEST === "true" ||
      process.env.VITEST !== undefined;
    const isProduction = process.env.NODE_ENV === "production";

    let connectionString: string | undefined;
    if (isTest) {
      connectionString =
        process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    } else if (isProduction) {
      connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error(
          "DATABASE_URL environment variable is strictly required in production mode.",
        );
      }
    } else {
      connectionString =
        process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
    }

    if (!connectionString) {
      throw new Error(
        "DATABASE_URL or TEST_DATABASE_URL environment variable is required for database connection.",
      );
    }

    globalDbContext = createPostgresDatabase(connectionString);
  }

  return globalDbContext;
}

export async function closeDatabaseContext(): Promise<void> {
  if (globalDbContext) {
    await globalDbContext.close();
    globalDbContext = null;
  }
}
