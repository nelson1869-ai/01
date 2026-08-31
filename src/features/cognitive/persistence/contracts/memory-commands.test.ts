import { describe, expect, it } from "vitest";

import {
  admitVerifiedMemoryCommandSchema,
  assertMemoryContentSecurity,
} from "./memory-commands";

describe("memory commands contract and security assertions", () => {
  const T0 = "2026-08-31T05:00:00.000Z";

  it("parses valid admit verified memory command", () => {
    const valid = {
      commandIdempotencyKey: "mem:cmd:1",
      memoryId: "mem-1",
      executionId: "exec-1",
      verificationId: "ver-1",
      kind: "FACT",
      key: "user.timezone",
      version: 1,
      content: { timezone: "America/New_York", offsetMinutes: -300 },
      sourceIds: ["ev-1"],
      confidence: 0.98,
      admissionRuleVersion: "verified-result-v1",
      verifiedAt: T0,
      createdAt: T0,
    };

    expect(admitVerifiedMemoryCommandSchema.safeParse(valid).success).toBe(true);
  });

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
    "workingMemory",
    "temporaryAssumptions",
    "hypotheses",
    "rawModelTrace",
  ])("rejects memory content containing disallowed property %s", (disallowedKey) => {
    const badContent = {
      fact: "some fact",
      [disallowedKey]: "forbidden payload",
    };

    expect(() => assertMemoryContentSecurity(badContent)).toThrow(
      /Disallowed property/,
    );
  });

  it("rejects nested disallowed keys in memory content", () => {
    const nested = {
      profile: {
        secrets: {
          apiKey: "12345",
        },
      },
    };

    expect(() => assertMemoryContentSecurity(nested)).toThrow(
      /Disallowed property/,
    );
  });

  it("allows safe structured verified knowledge", () => {
    const safe = {
      domain: "api.example.com",
      endpoints: ["/v1/users", "/v1/projects"],
      verifiedConfig: {
        rateLimitPerMinute: 60,
        sslRequired: true,
      },
    };

    expect(() => assertMemoryContentSecurity(safe)).not.toThrow();
  });
});
