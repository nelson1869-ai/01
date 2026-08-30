import { z } from "zod";

import {
  advanceableGenerationSchema,
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  recoveryFailureSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const activeExecutionRecoveryTargetSchema = z
  .strictObject({
    executionId: identifierSchema,
    expectedExecutionRowVersion: nonNegativeSafeIntegerSchema,
    expectedStatus: z.enum(["PENDING", "RUNNING"]),
    executionEventId: identifierSchema,
    executionEventKey: idempotencyKeySchema,
  })
  .readonly();

export type ActiveExecutionRecoveryTarget = z.infer<
  typeof activeExecutionRecoveryTargetSchema
>;

export const failureRecoveryCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    sessionId: identifierSchema,
    expectedSessionRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: advanceableGenerationSchema,
    failure: recoveryFailureSchema,
    reason: summarySchema,
    evidenceIds: z.array(identifierSchema).max(1_000).readonly(),
    auditEventId: identifierSchema,
    safetyEventId: identifierSchema,
    safetyEventKey: idempotencyKeySchema,
    candidateId: identifierSchema.nullable().optional(),
    planId: identifierSchema.nullable().optional(),
    activeExecution: activeExecutionRecoveryTargetSchema.nullable().optional(),
    createdAt: timestampSchema,
  })
  .readonly();

export type FailureRecoveryCommand = z.infer<
  typeof failureRecoveryCommandSchema
>;
