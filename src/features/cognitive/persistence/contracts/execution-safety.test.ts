import { describe, expect, it } from "vitest";

import { storedExecutionSafetySchema } from "./execution-safety";
import { safetyTransitionCommandSchema } from "./transition-commands";

const unauthorizedSafety = {
  sessionId: "session-1",
  generation: 0,
  status: "UNAUTHORIZED",
  failure: null,
  reason: "Runtime authorization must be re-evaluated.",
  blockedAt: null,
  evaluatedCandidateId: null,
  groundingResultId: null,
  policyDecisionId: null,
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const blockedSafety = {
  sessionId: "session-1",
  generation: 2,
  status: "BLOCKED",
  failure: "HALLUCINATION_DETECTED",
  reason: "Grounding failed and the previous generation was revoked.",
  blockedAt: "2026-08-30T00:01:00.000Z",
  evaluatedCandidateId: "candidate-1",
  groundingResultId: "grounding-1",
  policyDecisionId: "policy-decision-1",
  updatedAt: "2026-08-30T00:01:00.000Z",
};

describe("stored execution safety contract", () => {
  it("parses fail-closed UNAUTHORIZED state", () => {
    expect(storedExecutionSafetySchema.safeParse(unauthorizedSafety).success).toBe(
      true,
    );
  });

  it("parses fail-closed BLOCKED state", () => {
    expect(storedExecutionSafetySchema.safeParse(blockedSafety).success).toBe(
      true,
    );
  });

  it("rejects a stored record claiming ALLOWED", () => {
    expect(
      storedExecutionSafetySchema.safeParse({
        ...unauthorizedSafety,
        status: "ALLOWED",
        candidateId: "candidate-1",
        reason: null,
      }).success,
    ).toBe(false);
  });

  it("rejects negative and non-integer generations", () => {
    expect(
      storedExecutionSafetySchema.safeParse({
        ...blockedSafety,
        generation: -1,
      }).success,
    ).toBe(false);

    expect(
      storedExecutionSafetySchema.safeParse({
        ...blockedSafety,
        generation: 1.5,
      }).success,
    ).toBe(false);
  });

  it("rejects private runtime authorization fields", () => {
    expect(
      storedExecutionSafetySchema.safeParse({
        ...unauthorizedSafety,
        authorizationBrand: "forged-runtime-capability",
      }).success,
    ).toBe(false);
  });

  it("rejects partial safety evaluation evidence", () => {
    expect(
      storedExecutionSafetySchema.safeParse({
        ...unauthorizedSafety,
        evaluatedCandidateId: "candidate-1",
      }).success,
    ).toBe(false);
  });
});

describe("safety transition command contract", () => {
  it("makes the expected generation and one-step advance explicit", () => {
    expect(
      safetyTransitionCommandSchema.safeParse({
        sessionId: "session-1",
        expectedGeneration: 1,
        nextState: blockedSafety,
        commandIdempotencyKey: "safety:session-1:1:2",
      }).success,
    ).toBe(true);
  });

  it("rejects stale or skipped generation transitions", () => {
    expect(
      safetyTransitionCommandSchema.safeParse({
        sessionId: "session-1",
        expectedGeneration: 0,
        nextState: blockedSafety,
        commandIdempotencyKey: "safety:session-1:0:2",
      }).success,
    ).toBe(false);
  });

  it("cannot carry an ALLOWED next state", () => {
    expect(
      safetyTransitionCommandSchema.safeParse({
        sessionId: "session-1",
        expectedGeneration: 2,
        nextState: {
          ...unauthorizedSafety,
          generation: 3,
          status: "ALLOWED",
          candidateId: "candidate-1",
          reason: null,
        },
        commandIdempotencyKey: "safety:session-1:2:3",
      }).success,
    ).toBe(false);
  });
});
