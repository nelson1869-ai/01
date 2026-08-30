import { describe, expect, it } from "vitest";

import { getTestDatabaseUrl } from "./integration-harness";

describe("integration test harness safety guards", () => {
  it("fails closed when URL is empty", () => {
    expect(() => getTestDatabaseUrl("")).toThrow(
      "TEST_DATABASE_URL is required for live PostgreSQL integration tests.",
    );
  });

  it("fails closed when URL is not a valid URL", () => {
    expect(() => getTestDatabaseUrl("invalid-url-format")).toThrow(
      "Invalid TEST_DATABASE_URL connection string provided.",
    );
  });

  it("refuses to run when database name does not contain 'test'", () => {
    expect(() =>
      getTestDatabaseUrl(
        "postgresql://user:pass@localhost:5432/autodo_production",
      ),
    ).toThrow(
      'Refusing to run integration tests against database "autodo_production". Database name must contain "test".',
    );
  });

  it("accepts database URL when database name contains 'test'", () => {
    const url = getTestDatabaseUrl(
      "postgresql://user:pass@localhost:5432/autodo_ai_test",
    );
    expect(url).toBe("postgresql://user:pass@localhost:5432/autodo_ai_test");
  });
});
