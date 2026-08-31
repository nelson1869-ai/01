import { z } from "zod";

import { PersistenceError } from "../postgres/errors/persistence-errors";
import {
  confidenceSchema,
  idempotencyKeySchema,
  identifierSchema,
  jsonObjectSchema,
  positiveSafeIntegerSchema,
  timestampSchema,
} from "./primitives";

const DISALLOWED_MEMORY_KEYS_PATTERN =
  /^(authorization|accesstoken|refreshtoken|apikey|password|cookie|privatekey|secret|token|authbrand|runtimeauthorization|chainofthought|scratchpad|workingmemory|temporaryassumptions|hypotheses|rawmodeltrace)$/i;

export function assertMemoryContentSecurity(
  content: unknown,
  path: string = "",
): void {
  if (content === null || typeof content !== "object") {
    return;
  }

  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      assertMemoryContentSecurity(content[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(
    content as Record<string, unknown>,
  )) {
    if (DISALLOWED_MEMORY_KEYS_PATTERN.test(key)) {
      throw PersistenceError.invalidPersistedState(
        `Disallowed property "${key}" (credential or working-memory trace) found in verified memory content at ${path || "root"}.`,
      );
    }
    assertMemoryContentSecurity(value, path ? `${path}.${key}` : key);
  }
}

export const admitVerifiedMemoryCommandSchema = z
  .strictObject({
    commandIdempotencyKey: idempotencyKeySchema,
    memoryId: identifierSchema,
    executionId: identifierSchema,
    verificationId: identifierSchema,
    kind: z.enum(["FACT", "POLICY", "SKILL", "PROCEDURE"]),
    key: identifierSchema,
    version: positiveSafeIntegerSchema,
    content: jsonObjectSchema,
    sourceIds: z.array(identifierSchema).min(1).max(1_000).readonly(),
    confidence: confidenceSchema,
    admissionRuleVersion: identifierSchema,
    verifiedAt: timestampSchema,
    createdAt: timestampSchema,
  })
  .readonly();

export type AdmitVerifiedMemoryCommand = z.infer<
  typeof admitVerifiedMemoryCommandSchema
>;
