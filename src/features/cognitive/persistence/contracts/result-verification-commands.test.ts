import { describe, expect, it } from "vitest";

import { verifyExecutionResultCommandSchema } from "./result-verification-commands";

describe("result verification command contract", () => {
  const T0 = "2026-08-31T05:00:00.000Z";

  it("parses valid verify execution result command", () => {
    const valid = {
      commandIdempotencyKey: "verify:cmd:1",
      verificationId: "ver-1",
      executionId: "exec-1",
      observationIds: ["obs-1", "obs-2"],
      expectedVerificationGeneration: 1,
      verifierVersion: "deterministic-verifier-v1",
      verifiedAt: T0,
      expectedResult: { resourceCreated: true },
    };

    expect(verifyExecutionResultCommandSchema.safeParse(valid).success).toBe(
      true,
    );
  });

  it("rejects command with zero observation IDs", () => {
    const invalid = {
      commandIdempotencyKey: "verify:cmd:1",
      verificationId: "ver-1",
      executionId: "exec-1",
      observationIds: [],
      expectedVerificationGeneration: 1,
      verifierVersion: "deterministic-verifier-v1",
      verifiedAt: T0,
    };

    expect(verifyExecutionResultCommandSchema.safeParse(invalid).success).toBe(
      false,
    );
  });

  it("rejects non-positive verification generation", () => {
    const invalid = {
      commandIdempotencyKey: "verify:cmd:1",
      verificationId: "ver-1",
      executionId: "exec-1",
      observationIds: ["obs-1"],
      expectedVerificationGeneration: 0,
      verifierVersion: "deterministic-verifier-v1",
      verifiedAt: T0,
    };

    expect(verifyExecutionResultCommandSchema.safeParse(invalid).success).toBe(
      false,
    );
  });
});
