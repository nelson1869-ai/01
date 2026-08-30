import { z } from "zod";

import {
  executionStatusSchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedExecutionStepStateSchema = z
  .strictObject({
    executionId: identifierSchema,
    planId: identifierSchema,
    stepId: identifierSchema,
    status: executionStatusSchema,
    operationGeneration: positiveSafeIntegerSchema,
    rowVersion: nonNegativeSafeIntegerSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    error: summarySchema.nullable(),
    updatedAt: timestampSchema,
  })
  .superRefine((step, context) => {
    if (step.status === "PENDING" && step.startedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "A pending step cannot have a start timestamp.",
        path: ["startedAt"],
      });
    }

    if (step.status === "RUNNING" && step.startedAt === null) {
      context.addIssue({
        code: "custom",
        message: "A running step requires a start timestamp.",
        path: ["startedAt"],
      });
    }

    if (
      (step.status === "PENDING" || step.status === "RUNNING") &&
      step.completedAt !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A non-terminal step cannot have a completion timestamp.",
        path: ["completedAt"],
      });
    }

    if (
      step.status !== "PENDING" &&
      step.status !== "RUNNING" &&
      step.completedAt === null
    ) {
      context.addIssue({
        code: "custom",
        message: "A terminal step requires a completion timestamp.",
        path: ["completedAt"],
      });
    }

    if (step.status === "BLOCKED" && step.error === null) {
      context.addIssue({
        code: "custom",
        message: "A blocked step requires a durable error summary.",
        path: ["error"],
      });
    }
  })
  .readonly();

export type PersistedExecutionStepState = z.infer<
  typeof persistedExecutionStepStateSchema
>;
