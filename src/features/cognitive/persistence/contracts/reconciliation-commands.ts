import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const reconciliationOutcomeEnum = z.enum([
  "CONFIRMED_SUCCEEDED",
  "CONFIRMED_FAILED",
  "CONFIRMED_NOT_APPLIED",
  "INDETERMINATE",
]);

export type ReconciliationOutcomeType = z.infer<
  typeof reconciliationOutcomeEnum
>;

export const reconcileOperationCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    operationId: identifierSchema,
    expectedOperationRowVersion: nonNegativeSafeIntegerSchema,
    reconciliationOutcome: reconciliationOutcomeEnum,
    evidenceSummary: summarySchema,
    providerOperationId: identifierSchema.nullable().optional(),
    reconciledAt: timestampSchema,
  })
  .readonly();

export type ReconcileOperationCommand = z.infer<
  typeof reconcileOperationCommandSchema
>;

export const markInFlightOperationUnknownCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    operationId: identifierSchema,
    expectedOperationRowVersion: nonNegativeSafeIntegerSchema,
    uncertaintyReason: summarySchema,
    occurredAt: timestampSchema,
  })
  .readonly();

export type MarkInFlightOperationUnknownCommand = z.infer<
  typeof markInFlightOperationUnknownCommandSchema
>;
