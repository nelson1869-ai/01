import { describe, expect, it } from "vitest";

import { createCanonicalFingerprint } from "../postgres/utils/canonical-fingerprint";
import {
  type CooldownResumeCommand,
  cooldownResumeCommandSchema,
} from "./cooldown-resume-command";

describe("cooldown resume command contract", () => {
  const validCommand: CooldownResumeCommand = {
    commandIdempotencyKey: "resume:session-1:v1",
    sessionId: "session-1",
    expectedSessionRowVersion: 1,
    expectedSafetyGeneration: 2,
    expectedCooldownUntil: "2026-08-31T00:04:00.000Z",
    resumedAt: "2026-08-31T00:04:00.000Z",
  };

  it("1. parses valid cooldown resume command", () => {
    const result = cooldownResumeCommandSchema.safeParse(validCommand);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe("session-1");
      expect(result.data.expectedSessionRowVersion).toBe(1);
      expect(result.data.expectedSafetyGeneration).toBe(2);
    }
  });

  it("2. rejects invalid sessionId or commandIdempotencyKey", () => {
    const emptyKey = { ...validCommand, commandIdempotencyKey: "" };
    expect(cooldownResumeCommandSchema.safeParse(emptyKey).success).toBe(false);

    const emptySession = { ...validCommand, sessionId: "" };
    expect(cooldownResumeCommandSchema.safeParse(emptySession).success).toBe(
      false,
    );
  });

  it("3. rejects negative or non-integer expectedSessionRowVersion or safetyGeneration", () => {
    const negVersion = { ...validCommand, expectedSessionRowVersion: -1 };
    expect(cooldownResumeCommandSchema.safeParse(negVersion).success).toBe(
      false,
    );

    const floatVersion = { ...validCommand, expectedSessionRowVersion: 1.5 };
    expect(cooldownResumeCommandSchema.safeParse(floatVersion).success).toBe(
      false,
    );

    const negGen = { ...validCommand, expectedSafetyGeneration: -1 };
    expect(cooldownResumeCommandSchema.safeParse(negGen).success).toBe(false);
  });

  it("4. rejects invalid timestamp formats", () => {
    const badCooldown = {
      ...validCommand,
      expectedCooldownUntil: "invalid-date",
    };
    expect(cooldownResumeCommandSchema.safeParse(badCooldown).success).toBe(
      false,
    );

    const badResumedAt = { ...validCommand, resumedAt: "not-a-timestamp" };
    expect(cooldownResumeCommandSchema.safeParse(badResumedAt).success).toBe(
      false,
    );
  });

  it("5. strictly rejects forbidden speculative fields (workingMemory, chainOfThought, scratchpad, allowed)", () => {
    const withWorkingMemory = {
      ...validCommand,
      workingMemory: { cue: "test" },
    };
    expect(
      cooldownResumeCommandSchema.safeParse(withWorkingMemory).success,
    ).toBe(false);

    const withChainOfThought = {
      ...validCommand,
      chainOfThought: "thinking steps...",
    };
    expect(
      cooldownResumeCommandSchema.safeParse(withChainOfThought).success,
    ).toBe(false);

    const withScratchpad = {
      ...validCommand,
      scratchpad: "notes",
    };
    expect(cooldownResumeCommandSchema.safeParse(withScratchpad).success).toBe(
      false,
    );

    const withAllowed = {
      ...validCommand,
      status: "ALLOWED",
    };
    expect(cooldownResumeCommandSchema.safeParse(withAllowed).success).toBe(
      false,
    );
  });

  it("6. verifies canonical fingerprint stability", () => {
    const hash1 = createCanonicalFingerprint({
      sessionId: validCommand.sessionId,
      expectedSessionRowVersion: validCommand.expectedSessionRowVersion,
      expectedSafetyGeneration: validCommand.expectedSafetyGeneration,
      expectedCooldownUntil: validCommand.expectedCooldownUntil,
    });

    const hash2 = createCanonicalFingerprint({
      expectedCooldownUntil: validCommand.expectedCooldownUntil,
      expectedSafetyGeneration: validCommand.expectedSafetyGeneration,
      expectedSessionRowVersion: validCommand.expectedSessionRowVersion,
      sessionId: validCommand.sessionId,
    });

    expect(hash1).toBe(hash2);

    const hash3 = createCanonicalFingerprint({
      sessionId: validCommand.sessionId,
      expectedSessionRowVersion: 2,
      expectedSafetyGeneration: validCommand.expectedSafetyGeneration,
      expectedCooldownUntil: validCommand.expectedCooldownUntil,
    });

    expect(hash1).not.toBe(hash3);
  });
});
