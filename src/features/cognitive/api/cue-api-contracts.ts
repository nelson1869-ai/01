import { z } from "zod";
import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";

export const ALLOWED_CUE_TYPES = [
  "email.received",
  "calendar.upcoming",
  "file.created",
  "github.issue.created",
  "browser.event",
  "schedule",
  "task.completed",
  "user.action",
] as const;

export const createCueRequestSchema = z
  .strictObject({
    source: z
      .string()
      .trim()
      .min(1, "source is required.")
      .max(256, "source exceeds max length of 256."),
    type: z.enum(ALLOWED_CUE_TYPES, {
      message: `type must be one of: ${ALLOWED_CUE_TYPES.join(", ")}.`,
    }),
    payload: z
      .record(z.string(), z.unknown())
      .default({})
      .refine(
        (val) => JSON.stringify(val).length <= 102400,
        "payload exceeds max size of 100 KB.",
      ),
    occurredAt: z.string().datetime().optional(),
    externalEventId: z
      .string()
      .trim()
      .min(1, "externalEventId must not be empty.")
      .max(256, "externalEventId exceeds max length of 256.")
      .regex(
        /^[a-zA-Z0-9_.:-]+$/,
        "externalEventId may only contain alphanumeric characters, underscores, dots, colons, or hyphens.",
      )
      .optional(),
    maxRetries: z
      .number()
      .int()
      .min(0, "maxRetries must be >= 0.")
      .max(10, "maxRetries must be <= 10.")
      .optional(),
  })
  .readonly();

export type CreateCueRequest = z.infer<typeof createCueRequestSchema>;

export const identifierParamSchema = z
  .string()
  .trim()
  .min(1, "Identifier must not be empty.")
  .max(256, "Identifier exceeds max length of 256.")
  .regex(
    /^[a-zA-Z0-9_.:-]+$/,
    "Identifier may only contain alphanumeric characters, underscores, dots, colons, or hyphens.",
  );

export interface IngestedCueResponseData {
  readonly cue: PersistedCueIngress;
  readonly session: PersistedCognitiveSession;
}
