import { z } from "zod";

import {
  executionStatusSchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedExecutionSchema = z
  .strictObject({
    executionId: identifierSchema,
    sessionId: identifierSchema,
    planId: identifierSchema,
    status: executionStatusSchema,
    currentStepId: identifierSchema.nullable(),
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    error: summarySchema.nullable(),
    rowVersion: nonNegativeSafeIntegerSchema,
    safetyGenerationAtStart: nonNegativeSafeIntegerSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((execution, context) => {
    if (execution.status === "PENDING" && execution.startedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "A pending execution cannot have a start timestamp.",
        path: ["startedAt"],
      });
    }

    if (execution.status === "RUNNING" && execution.startedAt === null) {
      context.addIssue({
        code: "custom",
        message: "A running execution requires a start timestamp.",
        path: ["startedAt"],
      });
    }

    if (
      execution.startedAt !== null &&
      execution.safetyGenerationAtStart === null
    ) {
      context.addIssue({
        code: "custom",
        message: "A started execution requires its safety generation.",
        path: ["safetyGenerationAtStart"],
      });
    }

    if (
      (execution.status === "PENDING" || execution.status === "RUNNING") &&
      execution.completedAt !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A non-terminal execution cannot have a completion timestamp.",
        path: ["completedAt"],
      });
    }

    if (execution.status === "BLOCKED" && execution.error === null) {
      context.addIssue({
        code: "custom",
        message: "A blocked execution requires a durable error summary.",
        path: ["error"],
      });
    }

    if (
      execution.status !== "PENDING" &&
      execution.status !== "RUNNING" &&
      execution.completedAt === null
    ) {
      context.addIssue({
        code: "custom",
        message: "A terminal execution requires a completion timestamp.",
        path: ["completedAt"],
      });
    }
  })
  .readonly();

export type PersistedExecution = z.infer<typeof persistedExecutionSchema>;
