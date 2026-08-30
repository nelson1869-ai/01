import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

export const prepareExecutionCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    executionId: identifierSchema,
    sessionId: identifierSchema,
    planId: identifierSchema,
    expectedSessionRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    createdAt: timestampSchema,
  })
  .readonly();

export type PrepareExecutionCommand = z.infer<
  typeof prepareExecutionCommandSchema
>;
