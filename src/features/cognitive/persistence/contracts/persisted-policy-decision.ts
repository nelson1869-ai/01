import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedPolicyDecisionSchema = z
  .strictObject({
    policyDecisionId: identifierSchema,
    candidateId: identifierSchema,
    groundingResultId: identifierSchema,
    evaluationKey: idempotencyKeySchema,
    outcome: z.enum(["ALLOW", "REQUIRE_HUMAN_CONFIRMATION", "DENY"]),
    reason: summarySchema,
    policyEngineVersion: identifierSchema,
    policyIds: z.array(identifierSchema).max(1_000).readonly(),
    evaluatedAt: timestampSchema,
  })
  .readonly();

export type PersistedPolicyDecision = z.infer<
  typeof persistedPolicyDecisionSchema
>;
