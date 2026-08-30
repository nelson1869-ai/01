import { z } from "zod";

import {
  identifierSchema,
  jsonObjectSchema,
  timestampSchema,
} from "./primitives";

export const persistedCueIngressSchema = z
  .strictObject({
    cueId: identifierSchema,
    source: identifierSchema,
    externalEventId: identifierSchema,
    type: z.enum([
      "email.received",
      "calendar.upcoming",
      "file.created",
      "github.issue.created",
      "browser.event",
      "schedule",
      "task.completed",
      "user.action",
    ]),
    occurredAt: timestampSchema,
    receivedAt: timestampSchema,
    payload: jsonObjectSchema,
  })
  .readonly();

export type PersistedCueIngress = z.infer<typeof persistedCueIngressSchema>;
