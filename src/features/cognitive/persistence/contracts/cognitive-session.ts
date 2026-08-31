import { z } from "zod";

import {
  cognitivePhaseSchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

export const persistedCognitiveSessionSchema = z
  .strictObject({
    sessionId: identifierSchema,
    cueId: identifierSchema,
    currentCandidateId: identifierSchema.nullable(),
    currentPlanId: identifierSchema.nullable(),
    currentExecutionId: identifierSchema.nullable(),
    evaluationGeneration: nonNegativeSafeIntegerSchema.default(1),
    phase: cognitivePhaseSchema,
    failureCount: nonNegativeSafeIntegerSchema,
    retryCount: nonNegativeSafeIntegerSchema,
    maxRetries: nonNegativeSafeIntegerSchema,
    cooldownUntil: timestampSchema.nullable(),
    rowVersion: nonNegativeSafeIntegerSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((session, context) => {
    if (session.retryCount > session.maxRetries) {
      context.addIssue({
        code: "custom",
        message: "Retry count must not exceed max retries.",
        path: ["retryCount"],
      });
    }

    if (session.phase === "COOLDOWN" && session.cooldownUntil === null) {
      context.addIssue({
        code: "custom",
        message: "Cooldown phase requires a durable cooldown deadline.",
        path: ["cooldownUntil"],
      });
    }

    if (session.phase !== "COOLDOWN" && session.cooldownUntil !== null) {
      context.addIssue({
        code: "custom",
        message: "Only a cooldown session may retain a cooldown deadline.",
        path: ["cooldownUntil"],
      });
    }
  })
  .readonly();

export type PersistedCognitiveSession = z.infer<
  typeof persistedCognitiveSessionSchema
>;
