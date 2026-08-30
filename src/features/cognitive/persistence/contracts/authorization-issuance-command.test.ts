import { describe, expect, it } from "vitest";

import { createCanonicalFingerprint } from "../postgres/utils/canonical-fingerprint";
import {
  type AuthorizationIssuanceCommand,
  authorizationIssuanceCommandSchema,
} from "./authorization-issuance-command";

describe("authorization issuance command contract", () => {
  const validCommand: AuthorizationIssuanceCommand = {
    commandIdempotencyKey: "auth-cmd:sess-1:gen-1",
    sessionId: "sess-1",
    candidateId: "cand-1",
    groundingResultId: "gr-1",
    policyDecisionId: "pol-1",
    expectedSessionRowVersion: 2,
    expectedSafetyGeneration: 1,
    safetyEventId: "safe-evt-1",
    safetyEventKey: "safe-key:sess-1:gen-2",
    issuedAt: "2026-08-31T00:05:00.000Z",
  };

  it("1. parses valid authorization issuance command", () => {
    const result = authorizationIssuanceCommandSchema.safeParse(validCommand);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe("sess-1");
      expect(result.data.candidateId).toBe("cand-1");
      expect(result.data.expectedSafetyGeneration).toBe(1);
    }
  });

  it("2. rejects invalid sessionId, candidateId, or idempotency keys", () => {
    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        sessionId: "",
      }).success,
    ).toBe(false);

    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        candidateId: "   ",
      }).success,
    ).toBe(false);

    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        commandIdempotencyKey: "",
      }).success,
    ).toBe(false);
  });

  it("3. rejects negative or float generations/versions", () => {
    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        expectedSafetyGeneration: -1,
      }).success,
    ).toBe(false);

    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        expectedSessionRowVersion: 1.5,
      }).success,
    ).toBe(false);
  });

  it("4. strictly rejects forbidden speculative fields (workingMemory, chainOfThought, scratchpad, allowed, authBrand)", () => {
    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        workingMemory: { cue: "test" },
      }).success,
    ).toBe(false);

    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        chainOfThought: "thinking...",
      }).success,
    ).toBe(false);

    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        scratchpad: "notes",
      }).success,
    ).toBe(false);

    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        status: "ALLOWED",
      }).success,
    ).toBe(false);

    expect(
      authorizationIssuanceCommandSchema.safeParse({
        ...validCommand,
        authBrand: "some-brand",
      }).success,
    ).toBe(false);
  });

  it("5. verifies canonical fingerprint stability across key order", () => {
    const hash1 = createCanonicalFingerprint({
      sessionId: validCommand.sessionId,
      candidateId: validCommand.candidateId,
      groundingResultId: validCommand.groundingResultId,
      policyDecisionId: validCommand.policyDecisionId,
      expectedSessionRowVersion: validCommand.expectedSessionRowVersion,
      expectedSafetyGeneration: validCommand.expectedSafetyGeneration,
    });

    const hash2 = createCanonicalFingerprint({
      expectedSafetyGeneration: validCommand.expectedSafetyGeneration,
      expectedSessionRowVersion: validCommand.expectedSessionRowVersion,
      policyDecisionId: validCommand.policyDecisionId,
      groundingResultId: validCommand.groundingResultId,
      candidateId: validCommand.candidateId,
      sessionId: validCommand.sessionId,
    });

    expect(hash1).toBe(hash2);

    const hash3 = createCanonicalFingerprint({
      sessionId: validCommand.sessionId,
      candidateId: "cand-2",
      groundingResultId: validCommand.groundingResultId,
      policyDecisionId: validCommand.policyDecisionId,
      expectedSessionRowVersion: validCommand.expectedSessionRowVersion,
      expectedSafetyGeneration: validCommand.expectedSafetyGeneration,
    });

    expect(hash1).not.toBe(hash3);
  });
});
