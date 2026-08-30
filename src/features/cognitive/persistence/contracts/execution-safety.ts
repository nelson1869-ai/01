import { z } from "zod";

import {
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  recoveryFailureSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

const storedUnauthorizedExecutionSafetySchema = z
  .strictObject({
    sessionId: identifierSchema,
    generation: nonNegativeSafeIntegerSchema,
    status: z.literal("UNAUTHORIZED"),
    failure: z.null(),
    reason: summarySchema,
    blockedAt: z.null(),
    evaluatedCandidateId: identifierSchema.nullable(),
    groundingResultId: identifierSchema.nullable(),
    policyDecisionId: identifierSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .readonly();

const storedBlockedExecutionSafetySchema = z
  .strictObject({
    sessionId: identifierSchema,
    generation: nonNegativeSafeIntegerSchema,
    status: z.literal("BLOCKED"),
    failure: recoveryFailureSchema,
    reason: summarySchema,
    blockedAt: timestampSchema,
    evaluatedCandidateId: identifierSchema.nullable(),
    groundingResultId: identifierSchema.nullable(),
    policyDecisionId: identifierSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .readonly();

// Durable storage intentionally has no ALLOWED variant. Runtime authorization
// remains a privately branded capability issued only by the domain policy gate.
export const storedExecutionSafetySchema = z.discriminatedUnion("status", [
  storedUnauthorizedExecutionSafetySchema,
  storedBlockedExecutionSafetySchema,
]).superRefine((safety, context) => {
  const evaluationReferenceCount = [
    safety.evaluatedCandidateId,
    safety.groundingResultId,
    safety.policyDecisionId,
  ].filter((reference) => reference !== null).length;

  if (evaluationReferenceCount !== 0 && evaluationReferenceCount !== 3) {
    context.addIssue({
      code: "custom",
      message: "Safety evaluation references must be complete or all absent.",
      path: ["evaluatedCandidateId"],
    });
  }
});

export type StoredExecutionSafety = z.infer<
  typeof storedExecutionSafetySchema
>;
