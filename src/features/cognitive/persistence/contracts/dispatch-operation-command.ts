import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  jsonObjectSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

export const dispatchOperationCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    operationId: identifierSchema,
    attemptId: identifierSchema,
    executionId: identifierSchema,
    sessionId: identifierSchema,
    planId: identifierSchema,
    stepId: identifierSchema,
    operationGeneration: positiveSafeIntegerSchema,
    expectedOperationRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    workerId: identifierSchema.nullable(),
    startedAt: timestampSchema,
    request: jsonObjectSchema,
  })
  .readonly();

export type DispatchOperationCommand = z.infer<
  typeof dispatchOperationCommandSchema
>;
