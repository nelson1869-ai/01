import { z } from "zod";

import {
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

export const authorizationIssuanceCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    sessionId: identifierSchema,
    candidateId: identifierSchema,
    groundingResultId: identifierSchema,
    policyDecisionId: identifierSchema,
    expectedSessionRowVersion: nonNegativeSafeIntegerSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    safetyEventId: identifierSchema,
    safetyEventKey: idempotencyKeySchema,
    issuedAt: timestampSchema,
  })
  .readonly();

export type AuthorizationIssuanceCommand = z.infer<
  typeof authorizationIssuanceCommandSchema
>;
