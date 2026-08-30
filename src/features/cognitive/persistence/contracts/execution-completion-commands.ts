import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

const stepCompletionFields = {
  commandIdempotencyKey: idempotencyKeySchema,
  executionEventId: identifierSchema,
  eventKey: idempotencyKeySchema,
  executionId: identifierSchema,
  planId: identifierSchema,
  stepId: identifierSchema,
  operationGeneration: positiveSafeIntegerSchema,
  expectedExecutionRowVersion: nonNegativeSafeIntegerSchema,
  expectedStepRowVersion: nonNegativeSafeIntegerSchema,
  completedAt: timestampSchema,
} as const;

export const completeExecutionStepCommandSchema = z
  .strictObject({
    ...stepCompletionFields,
    reason: summarySchema,
  })
  .readonly();

export type CompleteExecutionStepCommand = z.infer<
  typeof completeExecutionStepCommandSchema
>;

export const failExecutionStepCommandSchema = z
  .strictObject({
    ...stepCompletionFields,
    errorSummary: summarySchema,
  })
  .readonly();

export type FailExecutionStepCommand = z.infer<
  typeof failExecutionStepCommandSchema
>;

const executionFinalizationFields = {
  commandIdempotencyKey: idempotencyKeySchema,
  executionEventId: identifierSchema,
  eventKey: idempotencyKeySchema,
  executionId: identifierSchema,
  expectedExecutionRowVersion: nonNegativeSafeIntegerSchema,
  completedAt: timestampSchema,
} as const;

export const finalizeExecutionSuccessCommandSchema = z
  .strictObject({
    ...executionFinalizationFields,
    reason: summarySchema,
  })
  .readonly();

export type FinalizeExecutionSuccessCommand = z.infer<
  typeof finalizeExecutionSuccessCommandSchema
>;

export const finalizeExecutionFailureCommandSchema = z
  .strictObject({
    ...executionFinalizationFields,
    errorSummary: summarySchema,
  })
  .readonly();

export type FinalizeExecutionFailureCommand = z.infer<
  typeof finalizeExecutionFailureCommandSchema
>;
