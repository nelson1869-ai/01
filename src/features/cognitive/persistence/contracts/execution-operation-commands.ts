import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const beginOperationAttemptCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    attemptId: identifierSchema,
    operationId: identifierSchema,
    executionId: identifierSchema,
    sessionId: identifierSchema,
    planId: identifierSchema,
    stepId: identifierSchema,
    expectedOperationRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    workerId: identifierSchema.nullable(),
    startedAt: timestampSchema,
  })
  .readonly();

export type BeginOperationAttemptCommand = z.infer<
  typeof beginOperationAttemptCommandSchema
>;

const operationOutcomeFields = {
  commandIdempotencyKey: idempotencyKeySchema,
  operationId: identifierSchema,
  attemptId: identifierSchema,
  expectedOperationRowVersion: nonNegativeSafeIntegerSchema,
  finishedAt: timestampSchema,
} as const;

export const recordOperationSucceededCommandSchema = z
  .strictObject({
    ...operationOutcomeFields,
    outcome: z.literal("SUCCEEDED"),
  })
  .readonly();

export type RecordOperationSucceededCommand = z.infer<
  typeof recordOperationSucceededCommandSchema
>;

export const recordOperationFailedCommandSchema = z
  .strictObject({
    ...operationOutcomeFields,
    outcome: z.literal("FAILED"),
    errorSummary: summarySchema,
  })
  .readonly();

export type RecordOperationFailedCommand = z.infer<
  typeof recordOperationFailedCommandSchema
>;

export const recordOperationUnknownCommandSchema = z
  .strictObject({
    ...operationOutcomeFields,
    outcome: z.literal("UNKNOWN"),
    uncertaintyReason: summarySchema,
  })
  .readonly();

export type RecordOperationUnknownCommand = z.infer<
  typeof recordOperationUnknownCommandSchema
>;
