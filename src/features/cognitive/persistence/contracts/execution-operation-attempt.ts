import { z } from "zod";

import {
  identifierSchema,
  jsonObjectSchema,
  positiveSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const executionOperationAttemptStatusSchema = z.enum([
  "IN_FLIGHT",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);

export const persistedExecutionOperationAttemptSchema = z
  .strictObject({
    attemptId: identifierSchema,
    operationId: identifierSchema,
    attemptNumber: positiveSafeIntegerSchema,
    status: executionOperationAttemptStatusSchema,
    workerId: identifierSchema.nullable(),
    startedAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
    errorSummary: summarySchema.nullable(),
    providerMetadata: jsonObjectSchema.nullable(),
  })
  .superRefine((attempt, context) => {
    if (attempt.status === "IN_FLIGHT" && attempt.finishedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "An in-flight attempt cannot have a finish timestamp.",
        path: ["finishedAt"],
      });
    }

    if (attempt.status !== "IN_FLIGHT" && attempt.finishedAt === null) {
      context.addIssue({
        code: "custom",
        message: "A terminal attempt requires a finish timestamp.",
        path: ["finishedAt"],
      });
    }

    if (
      (attempt.status === "FAILED" || attempt.status === "UNKNOWN") &&
      attempt.errorSummary === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Failed and unknown attempts require a durable summary.",
        path: ["errorSummary"],
      });
    }

    if (
      (attempt.status === "IN_FLIGHT" || attempt.status === "SUCCEEDED") &&
      attempt.errorSummary !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "In-flight and successful attempts cannot retain an error.",
        path: ["errorSummary"],
      });
    }
  })
  .readonly();

export type PersistedExecutionOperationAttempt = z.infer<
  typeof persistedExecutionOperationAttemptSchema
>;
