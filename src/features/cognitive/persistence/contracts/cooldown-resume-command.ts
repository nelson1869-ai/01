import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

export const cooldownResumeCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    sessionId: identifierSchema,
    expectedSessionRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    expectedCooldownUntil: timestampSchema,
    resumedAt: timestampSchema,
  })
  .readonly();

export type CooldownResumeCommand = z.infer<typeof cooldownResumeCommandSchema>;
