import { describe, expect, it } from "vitest";

import { canonicalRewardValueForSignal } from "./reward";
import { persistedRewardEventSchema } from "../persistence/contracts/reward-event";

describe("canonical reward scale and validation", () => {
  const T0 = "2026-08-31T05:00:00.000Z";

  it("maps every canonical signal to its exact numeric value", () => {
    expect(canonicalRewardValueForSignal("PERFECT")).toBe(10);
    expect(canonicalRewardValueForSignal("SUCCESS")).toBe(5);
    expect(canonicalRewardValueForSignal("HUMAN_APPROVAL")).toBe(5);
    expect(canonicalRewardValueForSignal("NEUTRAL")).toBe(0);
    expect(canonicalRewardValueForSignal("CORRECTION")).toBe(-3);
    expect(canonicalRewardValueForSignal("FAILURE")).toBe(-10);
    expect(canonicalRewardValueForSignal("HALLUCINATION")).toBe(-20);
    expect(canonicalRewardValueForSignal("UNSAFE_ACTION")).toBe(-100);
  });

  it.each([
    ["PERFECT", 10],
    ["SUCCESS", 5],
    ["HUMAN_APPROVAL", 5],
    ["NEUTRAL", 0],
    ["CORRECTION", -3],
    ["FAILURE", -10],
    ["HALLUCINATION", -20],
    ["UNSAFE_ACTION", -100],
  ] as const)("accepts valid reward event for signal %s with value %d", (signal, value) => {
    const valid = {
      rewardEventId: "rew-1",
      executionId: "exec-1",
      verificationId: "ver-1",
      rewardRuleId: "rule-1",
      rewardIdempotencyKey: "rew:idemp:1",
      signal,
      value,
      reason: `Reward for ${signal}`,
      createdAt: T0,
    };

    expect(persistedRewardEventSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects reward event when signal and value mismatch", () => {
    const mismatchUnsafe = {
      rewardEventId: "rew-2",
      executionId: "exec-1",
      verificationId: "ver-1",
      rewardRuleId: "rule-1",
      rewardIdempotencyKey: "rew:idemp:2",
      signal: "UNSAFE_ACTION",
      value: 100, // Invalid: UNSAFE_ACTION must be -100
      reason: "Forged value",
      createdAt: T0,
    };

    expect(persistedRewardEventSchema.safeParse(mismatchUnsafe).success).toBe(
      false,
    );

    const mismatchSuccess = {
      rewardEventId: "rew-3",
      executionId: "exec-1",
      verificationId: "ver-1",
      rewardRuleId: "rule-1",
      rewardIdempotencyKey: "rew:idemp:3",
      signal: "SUCCESS",
      value: -50, // Invalid: SUCCESS must be 5
      reason: "Forged value",
      createdAt: T0,
    };

    expect(persistedRewardEventSchema.safeParse(mismatchSuccess).success).toBe(
      false,
    );
  });
});
