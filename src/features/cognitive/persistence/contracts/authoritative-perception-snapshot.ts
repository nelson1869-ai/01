import { z } from "zod";

import {
  identifierSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const authoritativePerceptionSnapshotSchema = z
  .strictObject({
    snapshotId: identifierSchema,
    sessionId: identifierSchema,
    cueId: identifierSchema,
    evaluationGeneration: z.number().int().positive(),
    summary: summarySchema,
    structuredFacts: z.record(z.string(), z.unknown()).readonly(),
    targetSpec: z.record(z.string(), z.unknown()).nullable().optional(),
    perceivedAt: timestampSchema,
    createdAt: timestampSchema,
  })
  .readonly();

export type AuthoritativePerceptionSnapshot = z.infer<
  typeof authoritativePerceptionSnapshotSchema
>;
