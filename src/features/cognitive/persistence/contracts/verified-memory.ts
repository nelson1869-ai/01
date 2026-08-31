import { z } from "zod";

import {
  confidenceSchema,
  identifierSchema,
  jsonObjectSchema,
  positiveSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

export const persistedVerifiedMemorySchema = z
  .strictObject({
    memoryId: identifierSchema,
    kind: z.enum(["FACT", "POLICY", "SKILL", "PROCEDURE"]),
    key: identifierSchema,
    version: positiveSafeIntegerSchema,
    content: jsonObjectSchema,
    sourceIds: z.array(identifierSchema).min(1).max(1_000).readonly(),
    confidence: confidenceSchema,
    admissionRuleVersion: identifierSchema,
    supersedesMemoryId: identifierSchema.nullable(),
    verificationId: identifierSchema.nullable().optional(),
    verifiedAt: timestampSchema,
    createdAt: timestampSchema,
  })
  .readonly();

export type PersistedVerifiedMemory = z.infer<
  typeof persistedVerifiedMemorySchema
>;
