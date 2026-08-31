import { z } from "zod";
import { identifierSchema, timestampSchema } from "./primitives";

export const assistantTurnKindSchema = z.enum([
  "DIRECT_ANSWER",
  "TOOL_REQUIRED",
  "CLARIFICATION",
  "DENIED",
]);

export const assistantTurnStatusSchema = z.enum([
  "PROCESSING",
  "COMPLETED",
  "CLARIFICATION_REQUIRED",
  "DENIED",
  "FAILED",
  "UNVERIFIED",
]);

export const persistedAssistantConversationSchema = z.strictObject({
  conversationId: identifierSchema,
  turnCount: z.number().int().nonnegative(),
  rowVersion: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema,
});

export const persistedAssistantTurnSchema = z.strictObject({
  turnId: identifierSchema,
  conversationId: identifierSchema,
  ordinal: z.number().int().positive(),
  userMessage: z.string().min(1).max(8000),
  assistantMessage: z.string().min(1).max(12000).nullable(),
  kind: assistantTurnKindSchema.nullable(),
  status: assistantTurnStatusSchema,
  decisionSummary: z.array(z.string().min(1).max(300)).max(8),
  cueId: identifierSchema.nullable(),
  sessionId: identifierSchema.nullable(),
  executionId: identifierSchema.nullable(),
  verificationId: identifierSchema.nullable(),
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});

export type AssistantTurnKind = z.infer<typeof assistantTurnKindSchema>;
export type AssistantTurnStatus = z.infer<typeof assistantTurnStatusSchema>;
export type PersistedAssistantConversation = z.infer<typeof persistedAssistantConversationSchema>;
export type PersistedAssistantTurn = z.infer<typeof persistedAssistantTurnSchema>;
