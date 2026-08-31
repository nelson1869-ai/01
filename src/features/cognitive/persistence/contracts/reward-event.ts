import { z } from "zod";

import { canonicalRewardValueForSignal } from "../../domain/reward";
import {
  finiteNumberSchema,
  idempotencyKeySchema,
  identifierSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedRewardEventSchema = z
  .strictObject({
    rewardEventId: identifierSchema,
    executionId: identifierSchema,
    verificationId: identifierSchema,
    rewardRuleId: identifierSchema,
    rewardIdempotencyKey: idempotencyKeySchema,
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
    skillKey: identifierSchema.nullish(),
    reason: summarySchema,
    createdAt: timestampSchema,
  })
  .refine((data) => data.value === canonicalRewardValueForSignal(data.signal), {
    message: "Reward value must match canonical numeric value for its signal.",
    path: ["value"],
  })
  .readonly();

export type PersistedRewardEvent = z.infer<typeof persistedRewardEventSchema>;
