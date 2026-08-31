import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  jsonObjectSchema,
  positiveSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

export const verifyExecutionResultCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    verificationId: identifierSchema,
    executionId: identifierSchema,
    observationIds: z.array(identifierSchema).min(1).max(1_000).readonly(),
    expectedVerificationGeneration: positiveSafeIntegerSchema,
    verifierVersion: identifierSchema,
    verifiedAt: timestampSchema,
    expectedResult: jsonObjectSchema.nullable().optional(),
  })
  .readonly();

export type VerifyExecutionResultCommand = z.infer<
  typeof verifyExecutionResultCommandSchema
>;
