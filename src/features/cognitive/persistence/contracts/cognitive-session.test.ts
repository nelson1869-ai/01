import { describe, expect, it } from "vitest";

import { persistedCognitiveSessionSchema } from "./cognitive-session";

const validSession = {
  sessionId: "session-1",
  cueId: "cue-1",
  currentCandidateId: null,
  currentPlanId: null,
  currentExecutionId: null,
  phase: "BUILD_CONTEXT",
  failureCount: 1,
  retryCount: 1,
  maxRetries: 2,
  cooldownUntil: null,
  rowVersion: 4,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:01:00+00:00",
};

describe("persisted cognitive session contract", () => {
  it("parses valid authoritative resumable state", () => {
    expect(persistedCognitiveSessionSchema.parse(validSession)).toEqual(
      validSession,
    );
  });

  it("rejects durable working memory", () => {
    expect(
      persistedCognitiveSessionSchema.safeParse({
        ...validSession,
        workingMemory: { assumption: "temporary" },
      }).success,
    ).toBe(false);
  });

  it.each(["chainOfThought", "temporaryAssumptions", "authorizationBrand"])(
    "rejects the unexpected runtime/speculative field %s",
    (field) => {
      expect(
        persistedCognitiveSessionSchema.safeParse({
          ...validSession,
          [field]: "must not persist",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects negative counters and row versions", () => {
    for (const invalid of [
      { ...validSession, failureCount: -1 },
      { ...validSession, retryCount: -1 },
      { ...validSession, maxRetries: -1 },
      { ...validSession, rowVersion: -1 },
    ]) {
      expect(persistedCognitiveSessionSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("rejects retry counts beyond the durable retry budget", () => {
    expect(
      persistedCognitiveSessionSchema.safeParse({
        ...validSession,
        retryCount: 3,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid timestamps", () => {
    expect(
      persistedCognitiveSessionSchema.safeParse({
        ...validSession,
        updatedAt: "2026-02-30T25:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("rejects empty and whitespace-only identifiers", () => {
    expect(
      persistedCognitiveSessionSchema.safeParse({
        ...validSession,
        sessionId: "   ",
      }).success,
    ).toBe(false);
  });

  it("requires a durable deadline exactly while in cooldown", () => {
    expect(
      persistedCognitiveSessionSchema.safeParse({
        ...validSession,
        phase: "COOLDOWN",
      }).success,
    ).toBe(false);

    expect(
      persistedCognitiveSessionSchema.safeParse({
        ...validSession,
        phase: "COOLDOWN",
        cooldownUntil: "2026-08-30T00:05:00.000Z",
      }).success,
    ).toBe(true);
  });
});
