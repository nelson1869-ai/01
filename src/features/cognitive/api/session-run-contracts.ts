import { z } from "zod";
import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { CognitiveCycleResult } from "../orchestration/cognitive-loop-driver";

export const SUPPORTED_TASK_PROFILES = ["github-readonly-v1"] as const;
export type SupportedTaskProfile = (typeof SUPPORTED_TASK_PROFILES)[number];

export const runSessionRequestSchema = z
  .strictObject({
    taskProfile: z.enum(SUPPORTED_TASK_PROFILES, {
      message: `taskProfile must be one of: ${SUPPORTED_TASK_PROFILES.join(", ")}.`,
    }),
  })
  .readonly();

export type RunSessionRequest = z.infer<typeof runSessionRequestSchema>;

export interface RunSessionResponseData {
  readonly result: CognitiveCycleResult;
  readonly session: PersistedCognitiveSession;
}
