import { z } from "zod";

export const MAX_ASSISTANT_MESSAGE_LENGTH = 8000;
export const MAX_CONTEXT_TURNS = 8;
export const MAX_CONTEXT_CHARACTERS = 16000;

export const conversationIdSchema = z
  .string()
  .regex(/^conv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  .max(64);

export const assistantChatRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(MAX_ASSISTANT_MESSAGE_LENGTH),
  conversationId: conversationIdSchema.optional(),
});

export type AssistantChatRequest = z.infer<typeof assistantChatRequestSchema>;

export const assistantResponseStatusSchema = z.enum([
  "COMPLETED",
  "CLARIFICATION_REQUIRED",
  "DENIED",
  "FAILED",
  "UNVERIFIED",
]);

export const assistantVerificationStatusSchema = z.enum([
  "NOT_REQUIRED",
  "VERIFIED",
  "FAILED",
  "INCONCLUSIVE",
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
]);

export const assistantProviderStatusSchema = z.enum([
  "READY",
  "MISSING_CREDENTIAL",
  "AUTHENTICATION_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "SAFETY_BLOCKED",
  "INVALID_STRUCTURED_OUTPUT",
  "RESPONSE_TOO_LARGE",
  "UNKNOWN_PROVIDER_FAILURE",
]);

export type AssistantProviderStatus = z.infer<typeof assistantProviderStatusSchema>;

export interface AssistantChatResponseData {
  readonly conversationId: string;
  readonly message: string;
  readonly status: z.infer<typeof assistantResponseStatusSchema>;
  readonly providerStatus: AssistantProviderStatus | null;
  readonly sessionId: string | null;
  readonly executionId: string | null;
  readonly verification: z.infer<typeof assistantVerificationStatusSchema>;
  readonly decisionSummary: readonly string[];
}
