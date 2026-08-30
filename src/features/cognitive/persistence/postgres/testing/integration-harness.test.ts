import { describe, expect, it } from "vitest";

import { getTestDatabaseUrl } from "./integration-harness";

describe("integration test harness safety guards", () => {
  it("fails closed when TEST_DATABASE_URL is undefined or empty", () => {
    const original = process.env.TEST_DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;

    try {
      expect(() => getTestDatabaseUrl()).toThrow(
        "TEST_DATABASE_URL is required for live PostgreSQL integration tests.",
      );
    } finally {
      if (original !== undefined) {
        process.env.TEST_DATABASE_URL = original;
      }
    }
  });

  it("fails closed when TEST_DATABASE_URL is not a valid URL", () => {
    const original = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = "invalid-url-format";

    try {
      expect(() => getTestDatabaseUrl()).toThrow(
        "Invalid TEST_DATABASE_URL connection string provided.",
      );
    } finally {
      if (original !== undefined) {
        process.env.TEST_DATABASE_URL = original;
      } else {
        delete process.env.TEST_DATABASE_URL;
      }
    }
  });

  it("refuses to run when database name does not contain 'test'", () => {
    const original = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      "postgresql://user:pass@localhost:5432/autodo_production";

    try {
      expect(() => getTestDatabaseUrl()).toThrow(
        'Refusing to run integration tests against database "autodo_production". Database name must contain "test".',
      );
    } finally {
      if (original !== undefined) {
        process.env.TEST_DATABASE_URL = original;
      } else {
        delete process.env.TEST_DATABASE_URL;
      }
    }
  });

  it("accepts database URL when database name contains 'test'", () => {
    const original = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      "postgresql://user:pass@localhost:5432/autodo_ai_test";

    try {
      const url = getTestDatabaseUrl();
      expect(url).toBe("postgresql://user:pass@localhost:5432/autodo_ai_test");
    } finally {
      if (original !== undefined) {
        process.env.TEST_DATABASE_URL = original;
      } else {
        delete process.env.TEST_DATABASE_URL;
      }
    }
  });
});
