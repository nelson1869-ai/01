import { z } from "zod";

import {
  identifierSchema,
  jsonObjectSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedObservationSchema = z
  .strictObject({
    observationId: identifierSchema,
    executionId: identifierSchema,
    stepId: identifierSchema.nullable(),
    source: identifierSchema,
    sourceEventId: identifierSchema.nullable(),
    summary: summarySchema,
    data: jsonObjectSchema,
    observedAt: timestampSchema,
    payloadExpiresAt: timestampSchema.nullable(),
  })
  .readonly();

export type PersistedObservation = z.infer<typeof persistedObservationSchema>;
