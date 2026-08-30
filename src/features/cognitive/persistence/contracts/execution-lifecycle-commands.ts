import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

const executionEventFields = {
  executionEventId: identifierSchema,
  eventKey: idempotencyKeySchema,
  reason: summarySchema,
} as const;

export const startExecutionCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    executionId: identifierSchema,
    sessionId: identifierSchema,
    planId: identifierSchema,
    expectedExecutionRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    startedAt: timestampSchema,
    ...executionEventFields,
  })
  .readonly();

export type StartExecutionCommand = z.infer<
  typeof startExecutionCommandSchema
>;

export const startExecutionStepCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    executionId: identifierSchema,
    sessionId: identifierSchema,
    planId: identifierSchema,
    stepId: identifierSchema,
    expectedExecutionRowVersion: nonNegativeSafeIntegerSchema,
    expectedStepRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    startedAt: timestampSchema,
    ...executionEventFields,
  })
  .readonly();

export type StartExecutionStepCommand = z.infer<
  typeof startExecutionStepCommandSchema
>;

export const reserveExecutionOperationCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    operationId: identifierSchema,
    executionId: identifierSchema,
    sessionId: identifierSchema,
    planId: identifierSchema,
    stepId: identifierSchema,
    operationGeneration: positiveSafeIntegerSchema,
    expectedStepRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    operationKind: identifierSchema,
    requestFingerprint: idempotencyKeySchema,
    providerScope: identifierSchema.nullable(),
    providerIdempotencyKey: idempotencyKeySchema.nullable(),
    createdAt: timestampSchema,
  })
  .readonly();

export type ReserveExecutionOperationCommand = z.infer<
  typeof reserveExecutionOperationCommandSchema
>;
