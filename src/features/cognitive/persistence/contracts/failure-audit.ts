import { z } from "zod";

import {
  cognitivePhaseSchema,
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  recoveryActionSchema,
  recoveryFailureSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedFailureAuditSchema = z
  .strictObject({
    auditEventId: identifierSchema,
    sessionId: identifierSchema,
    candidateId: identifierSchema.nullable(),
    planId: identifierSchema.nullable(),
    executionId: identifierSchema.nullable(),
    stepId: identifierSchema.nullable(),
    failure: recoveryFailureSchema,
    recoveryAction: recoveryActionSchema,
    phase: cognitivePhaseSchema,
    failureCount: nonNegativeSafeIntegerSchema,
    retryCount: nonNegativeSafeIntegerSchema,
    fromSafetyGeneration: nonNegativeSafeIntegerSchema,
    revokedSafetyGeneration: nonNegativeSafeIntegerSchema,
    reason: summarySchema,
    evidenceIds: z.array(identifierSchema).max(1_000).readonly(),
    logicalFailureKey: idempotencyKeySchema,
    createdAt: timestampSchema,
  })
  .readonly();

export type PersistedFailureAudit = z.infer<
  typeof persistedFailureAuditSchema
>;
