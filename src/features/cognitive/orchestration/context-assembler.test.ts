import { describe, expect, it } from "vitest";

import {
  assertContextSecurity,
} from "./context-assembler";

describe("context assembler security and structure unit tests", () => {
  it.each([
    "authorization",
    "accessToken",
    "refreshToken",
    "apiKey",
    "password",
    "cookie",
    "privateKey",
    "secret",
    "token",
    "authBrand",
    "runtimeAuthorization",
    "chainOfThought",
    "scratchpad",
    "hiddenReasoning",
    "modelThoughts",
    "rawModelTrace",
  ])("rejects context containing disallowed property %s", (disallowedKey) => {
    const badContext = {
      summary: "Perceived action",
      [disallowedKey]: "forbidden payload",
    };

    expect(() => assertContextSecurity(badContext)).toThrow(
      /Disallowed property/,
    );
  });

  it("rejects nested disallowed keys in context metadata", () => {
    const nestedBad = {
      summary: "Perception ok",
      metadata: {
        credentials: {
          apiKey: "secret-value",
        },
      },
    };

    expect(() => assertContextSecurity(nestedBad)).toThrow(
      /Disallowed property/,
    );
  });

  it("allows safe structured facts and metadata", () => {
    const safeContext = {
      summary: "User requested report generation",
      structuredFacts: {
        reportType: "monthly-summary",
        rangeDays: 30,
      },
      metadata: {
        requestedBy: "user-123",
        environment: "production",
      },
    };

    expect(() => assertContextSecurity(safeContext)).not.toThrow();
  });
});
