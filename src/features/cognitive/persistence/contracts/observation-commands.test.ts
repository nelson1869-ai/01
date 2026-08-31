import { describe, expect, it } from "vitest";

import {
  assertObservationDataSecurity,
  recordObservationCommandSchema,
} from "./observation-commands";

describe("observation command contract and security sanitization", () => {
  const T0 = "2026-08-31T05:00:00.000Z";

  it("parses valid record observation command", () => {
    const valid = {
      commandIdempotencyKey: "obs:cmd:1",
      observationId: "obs-1",
      executionId: "exec-1",
      stepId: "step-1",
      source: "provider-dispatch",
      sourceEventId: "prov-op-1",
      summary: "Provider confirmed success",
      data: { status: "OK", count: 1 },
      observedAt: T0,
      payloadExpiresAt: null,
    };

    expect(recordObservationCommandSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    "authorization",
    "Authorization",
    "accessToken",
    "refreshToken",
    "apiKey",
    "password",
    "cookie",
    "privateKey",
    "runtimeAuthorization",
    "authBrand",
    "secret",
    "token",
  ])("rejects observation data containing disallowed credential key %s", (credentialKey) => {
    const dataWithSecret = {
      validField: "data",
      [credentialKey]: "super-secret-token",
    };

    expect(() => assertObservationDataSecurity(dataWithSecret)).toThrow(
      /Disallowed security token or credential property/,
    );
  });

  it("rejects nested credential keys in observation data", () => {
    const nested = {
      user: {
        profile: {
          apiKey: "secret-key",
        },
      },
    };

    expect(() => assertObservationDataSecurity(nested)).toThrow(
      /Disallowed security token or credential property/,
    );
  });

  it("allows safe structured factual data", () => {
    const safe = {
      resourceId: "res-123",
      statusCode: 200,
      delivered: true,
      metrics: {
        sizeBytes: 1024,
        latencyMs: 45,
      },
    };

    expect(() => assertObservationDataSecurity(safe)).not.toThrow();
  });
});
