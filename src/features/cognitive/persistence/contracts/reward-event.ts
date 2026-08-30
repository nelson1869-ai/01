import { z } from "zod";

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
      "SUCCESS",
      "HUMAN_APPROVAL",
      "CORRECTION",
      "FAILURE",
      "HALLUCINATION",
      "UNSAFE_ACTION",
    ]),
    value: finiteNumberSchema,
    reason: summarySchema,
    createdAt: timestampSchema,
  })
  .readonly();

export type PersistedRewardEvent = z.infer<
  typeof persistedRewardEventSchema
>;
