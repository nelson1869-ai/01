import { describe, expect, it } from "vitest";

import {
  applyVerificationRewardCommandSchema,
  getDefaultRewardForVerificationStatus,
} from "./reward-commands";

describe("reward commands and default verification status mapping", () => {
  const T0 = "2026-08-31T05:00:00.000Z";

  it("maps VERIFIED status to SUCCESS +5 (never auto-inferring PERFECT)", () => {
    const defaultReward = getDefaultRewardForVerificationStatus("VERIFIED");
    expect(defaultReward.signal).toBe("SUCCESS");
    expect(defaultReward.value).toBe(5);
    expect(defaultReward.rewardRuleId).toBe("verification-success-v1");
  });

  it("maps FAILED status to FAILURE -10", () => {
    const defaultReward = getDefaultRewardForVerificationStatus("FAILED");
    expect(defaultReward.signal).toBe("FAILURE");
    expect(defaultReward.value).toBe(-10);
    expect(defaultReward.rewardRuleId).toBe("verification-failure-v1");
  });

  it("maps INCONCLUSIVE status to NEUTRAL 0 (never auto-inferring HALLUCINATION)", () => {
    const defaultReward = getDefaultRewardForVerificationStatus("INCONCLUSIVE");
    expect(defaultReward.signal).toBe("NEUTRAL");
    expect(defaultReward.value).toBe(0);
    expect(defaultReward.rewardRuleId).toBe("verification-inconclusive-v1");
  });

  it("parses valid apply verification reward command", () => {
    const valid = {
      commandIdempotencyKey: "rew:cmd:1",
      rewardEventId: "rew-1",
      executionId: "exec-1",
      verificationId: "ver-1",
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 5,
      skillKey: "email.send",
      reason: "Verified result",
      createdAt: T0,
    };

    expect(applyVerificationRewardCommandSchema.safeParse(valid).success).toBe(
      true,
    );
  });

  it("rejects command when value does not match canonical signal value", () => {
    const invalid = {
      commandIdempotencyKey: "rew:cmd:1",
      rewardEventId: "rew-1",
      executionId: "exec-1",
      verificationId: "ver-1",
      rewardRuleId: "verification-success-v1",
      signal: "SUCCESS",
      value: 10, // Invalid: SUCCESS must be 5
      skillKey: "email.send",
      reason: "Invalid reward value",
      createdAt: T0,
    };

    expect(applyVerificationRewardCommandSchema.safeParse(invalid).success).toBe(
      false,
    );
  });
});
