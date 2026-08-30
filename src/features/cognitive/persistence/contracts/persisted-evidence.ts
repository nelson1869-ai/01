import { z } from "zod";

import {
  identifierSchema,
  jsonObjectSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedEvidenceSchema = z
  .strictObject({
    evidenceId: identifierSchema,
    source: identifierSchema,
    sourceId: identifierSchema,
    claim: summarySchema,
    observedAt: timestampSchema,
    createdAt: timestampSchema,
    providerMetadata: jsonObjectSchema.nullable(),
  })
  .readonly();

export type PersistedEvidence = z.infer<typeof persistedEvidenceSchema>;
