import { z } from "zod";

import {
  confidenceSchema,
  idempotencyKeySchema,
  identifierSchema,
  positiveSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedResultVerificationSchema = z
  .strictObject({
    verificationId: identifierSchema,
    executionId: identifierSchema,
    verificationGeneration: positiveSafeIntegerSchema,
    observationSetDigest: idempotencyKeySchema,
    verifierVersion: identifierSchema,
    status: z.enum(["VERIFIED", "FAILED", "INCONCLUSIVE"]),
    confidence: confidenceSchema,
    reason: summarySchema,
    verifiedAt: timestampSchema,
  })
  .readonly();

export type PersistedResultVerification = z.infer<
  typeof persistedResultVerificationSchema
>;
