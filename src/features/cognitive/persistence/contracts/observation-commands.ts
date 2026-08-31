import { z } from "zod";

import { PersistenceError } from "../postgres/errors/persistence-errors";
import {
  idempotencyKeySchema,
  identifierSchema,
  jsonObjectSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

const DISALLOWED_CREDENTIAL_KEY_PATTERN =
  /^(authorization|accesstoken|refreshtoken|apikey|password|cookie|privatekey|runtimeauthorization|authbrand|secret|token)$/i;

export function assertObservationDataSecurity(data: unknown, path: string = ""): void {
  if (data === null || typeof data !== "object") {
    return;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      assertObservationDataSecurity(data[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (DISALLOWED_CREDENTIAL_KEY_PATTERN.test(key)) {
      throw PersistenceError.invalidPersistedState(
        `Disallowed security token or credential property "${key}" found in observation data at ${path || "root"}.`,
      );
    }
    assertObservationDataSecurity(value, path ? `${path}.${key}` : key);
  }
}

export const recordObservationCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    observationId: identifierSchema,
    executionId: identifierSchema,
    stepId: identifierSchema.nullable().optional(),
    source: identifierSchema,
    sourceEventId: identifierSchema.nullable().optional(),
    summary: summarySchema,
    data: jsonObjectSchema,
    observedAt: timestampSchema,
    payloadExpiresAt: timestampSchema.nullable().optional(),
  })
  .readonly();

export type RecordObservationCommand = z.infer<
  typeof recordObservationCommandSchema
>;
