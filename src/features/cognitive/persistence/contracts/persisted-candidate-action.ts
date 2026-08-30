import { z } from "zod";

import {
  confidenceSchema,
  identifierSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedCandidateActionSchema = z
  .strictObject({
    candidateId: identifierSchema,
    sessionId: identifierSchema,
    cueId: identifierSchema,
    goal: summarySchema,
    action: summarySchema,
    confidence: confidenceSchema,
    expectedUtility: confidenceSchema,
    estimatedRisk: confidenceSchema,
    estimatedCost: confidenceSchema,
    scoreValue: confidenceSchema,
    recommendation: identifierSchema,
    scoreFormulaVersion: identifierSchema,
    evidenceIds: z.array(identifierSchema).max(1_000).readonly(),
    createdAt: timestampSchema,
  })
  .readonly();

export type PersistedCandidateAction = z.infer<
  typeof persistedCandidateActionSchema
>;
