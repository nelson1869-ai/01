import { z } from "zod";

import {
  confidenceSchema,
  idempotencyKeySchema,
  identifierSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedGroundingResultSchema = z
  .strictObject({
    groundingResultId: identifierSchema,
    candidateId: identifierSchema,
    evaluationKey: idempotencyKeySchema,
    status: z.enum(["VERIFIED", "CONTRADICTED", "UNVERIFIED"]),
    confidence: confidenceSchema,
    reason: summarySchema,
    evaluatorVersion: identifierSchema,
    evidenceIds: z.array(identifierSchema).max(1_000).readonly(),
    evaluatedAt: timestampSchema,
  })
  .readonly();

export type PersistedGroundingResult = z.infer<
  typeof persistedGroundingResultSchema
>;
