import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const executionOperationStatusSchema = z.enum([
  "PENDING",
  "IN_FLIGHT",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);

export const reconciliationStatusSchema = z.enum([
  "NOT_REQUIRED",
  "REQUIRED",
  "RECONCILED",
]);

export const persistedExecutionOperationSchema = z
  .strictObject({
    operationId: identifierSchema,
    executionId: identifierSchema,
    stepId: identifierSchema,
    operationGeneration: positiveSafeIntegerSchema,
    operationKind: identifierSchema,
    idempotencyKey: idempotencyKeySchema,
    requestFingerprint: idempotencyKeySchema,
    status: executionOperationStatusSchema,
    attemptCount: nonNegativeSafeIntegerSchema,
    providerScope: identifierSchema.nullable(),
    providerIdempotencyKey: idempotencyKeySchema.nullable(),
    providerOperationId: identifierSchema.nullable(),
    uncertaintyReason: summarySchema.nullable(),
    reconciliationStatus: reconciliationStatusSchema,
    reconciliationOutcome: summarySchema.nullable(),
    rowVersion: nonNegativeSafeIntegerSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((operation, context) => {
    if (operation.status === "UNKNOWN" && operation.uncertaintyReason === null) {
      context.addIssue({
        code: "custom",
        message: "An unknown external outcome requires an uncertainty reason.",
        path: ["uncertaintyReason"],
      });
    }

    if (operation.status !== "UNKNOWN" && operation.uncertaintyReason !== null) {
      context.addIssue({
        code: "custom",
        message: "Only an unknown external outcome may retain uncertainty.",
        path: ["uncertaintyReason"],
      });
    }
  })
  .readonly();

export type PersistedExecutionOperation = z.infer<
  typeof persistedExecutionOperationSchema
>;
