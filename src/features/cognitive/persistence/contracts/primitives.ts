import { z } from "zod";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 4_096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function isTrimmedNonEmpty(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

export const identifierSchema = z
  .string()
  .max(MAX_IDENTIFIER_LENGTH)
  .refine(isTrimmedNonEmpty, "Identifier must be non-empty and trimmed.")
  .refine(
    (value) => !CONTROL_CHARACTER_PATTERN.test(value),
    "Identifier must not contain control characters.",
  );

export const idempotencyKeySchema = z
  .string()
  .max(MAX_IDEMPOTENCY_KEY_LENGTH)
  .refine(isTrimmedNonEmpty, "Idempotency key must be non-empty and trimmed.")
  .refine(
    (value) => !CONTROL_CHARACTER_PATTERN.test(value),
    "Idempotency key must not contain control characters.",
  );

export const summarySchema = z
  .string()
  .max(MAX_SUMMARY_LENGTH)
  .refine(isTrimmedNonEmpty, "Summary must be non-empty and trimmed.");

export const timestampSchema = z.iso.datetime({ offset: true });

export const nonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export const advanceableGenerationSchema = nonNegativeSafeIntegerSchema.max(
  Number.MAX_SAFE_INTEGER - 1,
);

export const finiteNumberSchema = z.number().finite();

export const confidenceSchema = finiteNumberSchema.min(0).max(1);

export const jsonObjectSchema = z
  .record(z.string(), z.json())
  .readonly();

export const cognitivePhaseSchema = z.enum([
  "CUE",
  "PERCEIVE",
  "BUILD_CONTEXT",
  "RETRIEVE_MEMORY",
  "GENERATE_CANDIDATES",
  "SCORE",
  "GROUND_VERIFY",
  "POLICY_SAFETY",
  "PLAN",
  "DURABLE_EXECUTION",
  "ACT",
  "OBSERVE",
  "VERIFY_RESULT",
  "REWARD",
  "LEARN",
  "SAVE_MEMORY",
  "CLEAR_WORKING_MEMORY",
  "COOLDOWN",
  "HUMAN_REVIEW",
  "IDLE",
]);

export const executionStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "BLOCKED",
]);

export const recoveryFailureSchema = z.enum([
  "HALLUCINATION_DETECTED",
  "POLICY_VIOLATION",
  "EXECUTION_TIMEOUT",
  "UNVERIFIED_RESULT",
]);

export const recoveryActionSchema = z.enum([
  "RETRY_WITH_FRESH_CONTEXT",
  "START_COOLDOWN",
  "ESCALATE_TO_HUMAN",
]);
