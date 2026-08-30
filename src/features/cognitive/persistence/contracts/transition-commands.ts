import { z } from "zod";

import { storedExecutionSafetySchema } from "./execution-safety";
import {
  advanceableGenerationSchema,
  executionStatusSchema,
  idempotencyKeySchema,
  identifierSchema,
  nonNegativeSafeIntegerSchema,
} from "./primitives";

export const safetyTransitionCommandSchema = z
  .strictObject({
    sessionId: identifierSchema,
    expectedGeneration: advanceableGenerationSchema,
    nextState: storedExecutionSafetySchema,
    commandIdempotencyKey: idempotencyKeySchema,
  })
  .superRefine((command, context) => {
    if (command.nextState.sessionId !== command.sessionId) {
      context.addIssue({
        code: "custom",
        message: "Safety transition must remain bound to one session.",
        path: ["nextState", "sessionId"],
      });
    }

    if (command.nextState.generation !== command.expectedGeneration + 1) {
      context.addIssue({
        code: "custom",
        message: "Safety transition must advance generation exactly once.",
        path: ["nextState", "generation"],
      });
    }
  })
  .readonly();

export type SafetyTransitionCommand = z.infer<
  typeof safetyTransitionCommandSchema
>;

export const executionTransitionCommandSchema = z
  .strictObject({
    executionId: identifierSchema,
    expectedRowVersion: nonNegativeSafeIntegerSchema,
    expectedStatus: executionStatusSchema,
    nextStatus: executionStatusSchema,
    expectedSafetyGeneration: nonNegativeSafeIntegerSchema,
    commandIdempotencyKey: idempotencyKeySchema,
  })
  .readonly();

export type ExecutionTransitionCommand = z.infer<
  typeof executionTransitionCommandSchema
>;
