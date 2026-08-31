import { z } from "zod";

import {
  canonicalRewardValueForSignal,
  type RewardSignal,
} from "../../domain/reward";
import type { VerificationStatus } from "../../domain/verifier-contract";
import {
  finiteNumberSchema,
  idempotencyKeySchema,
  identifierSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const applyVerificationRewardCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    rewardEventId: identifierSchema,
    executionId: identifierSchema,
    verificationId: identifierSchema,
    rewardRuleId: identifierSchema,
    signal: z.enum([
      "PERFECT",
      "SUCCESS",
      "HUMAN_APPROVAL",
      "NEUTRAL",
      "CORRECTION",
      "FAILURE",
      "HALLUCINATION",
      "UNSAFE_ACTION",
    ]),
    value: finiteNumberSchema,
    skillKey: identifierSchema,
    reason: summarySchema,
    createdAt: timestampSchema,
  })
  .refine(
    (data) => data.value === canonicalRewardValueForSignal(data.signal),
    {
      message:
        "Reward value must match canonical numeric value for its signal.",
      path: ["value"],
    },
  )
  .readonly();

export type ApplyVerificationRewardCommand = z.infer<
  typeof applyVerificationRewardCommandSchema
>;

export function getDefaultRewardForVerificationStatus(
  status: VerificationStatus,
): {
  readonly signal: RewardSignal;
  readonly value: number;
  readonly rewardRuleId: string;
  readonly reason: string;
} {
  switch (status) {
    case "VERIFIED":
      return {
        signal: "SUCCESS",
        value: 5,
        rewardRuleId: "verification-success-v1",
        reason: "Automatic reward for verified execution result.",
      };
    case "FAILED":
      return {
        signal: "FAILURE",
        value: -10,
        rewardRuleId: "verification-failure-v1",
        reason: "Automatic penalty for failed execution result.",
      };
    case "INCONCLUSIVE":
    default:
      return {
        signal: "NEUTRAL",
        value: 0,
        rewardRuleId: "verification-inconclusive-v1",
        reason: "Neutral evaluation for inconclusive execution result.",
      };
  }
}
