import { describe, expect, it } from "vitest";

import { persistedExecutionOperationAttemptSchema } from "./execution-operation-attempt";
import { persistedExecutionStepStateSchema } from "./execution-step-state";
import { startExecutionCommandSchema } from "./execution-lifecycle-commands";
import { prepareExecutionCommandSchema } from "./prepare-execution-command";

const prepareCommand = {
  commandIdempotencyKey: "prepare:execution-1",
  executionId: "execution-1",
  sessionId: "session-1",
  planId: "plan-1",
  expectedSessionRowVersion: 2,
  expectedSafetyGeneration: 3,
  createdAt: "2026-08-31T01:00:00.000Z",
};

describe("execution lifecycle command contracts", () => {
  it("parses a strict execution-preparation command", () => {
    expect(prepareExecutionCommandSchema.safeParse(prepareCommand).success).toBe(
      true,
    );
  });

  it.each([
    "authorization",
    "authBrand",
    "status",
    "workingMemory",
    "chainOfThought",
    "scratchpad",
    "reasoning",
    "accessToken",
  ])("rejects forbidden or unknown preparation field %s", (field) => {
    expect(
      prepareExecutionCommandSchema.safeParse({
        ...prepareCommand,
        [field]: "not permitted",
      }).success,
    ).toBe(false);
  });

  it("requires valid expected versions and timestamps", () => {
    expect(
      prepareExecutionCommandSchema.safeParse({
        ...prepareCommand,
        expectedSafetyGeneration: -1,
      }).success,
    ).toBe(false);
    expect(
      prepareExecutionCommandSchema.safeParse({
        ...prepareCommand,
        createdAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
  });

  it("keeps runtime authorization out of start commands", () => {
    const start = {
      commandIdempotencyKey: "start:execution-1",
      executionEventId: "event-1",
      eventKey: "event:start:execution-1",
      executionId: "execution-1",
      sessionId: "session-1",
      planId: "plan-1",
      expectedExecutionRowVersion: 0,
      expectedSafetyGeneration: 3,
      startedAt: "2026-08-31T01:01:00.000Z",
      reason: "Authorized execution start.",
    };
    expect(startExecutionCommandSchema.safeParse(start).success).toBe(true);
    expect(
      startExecutionCommandSchema.safeParse({
        ...start,
        authorization: { status: "ALLOWED" },
      }).success,
    ).toBe(false);
  });
});

describe("execution step and attempt persistence contracts", () => {
  it("parses coherent PENDING and RUNNING step state", () => {
    const base = {
      executionId: "execution-1",
      planId: "plan-1",
      stepId: "step-1",
      operationGeneration: 1,
      rowVersion: 0,
      completedAt: null,
      error: null,
      updatedAt: "2026-08-31T01:00:00.000Z",
    };
    expect(
      persistedExecutionStepStateSchema.safeParse({
        ...base,
        status: "PENDING",
        startedAt: null,
      }).success,
    ).toBe(true);
    expect(
      persistedExecutionStepStateSchema.safeParse({
        ...base,
        status: "RUNNING",
        startedAt: "2026-08-31T01:01:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid step generation, timestamps, and speculative fields", () => {
    const invalid = {
      executionId: "execution-1",
      planId: "plan-1",
      stepId: "step-1",
      status: "PENDING",
      operationGeneration: 0,
      rowVersion: 0,
      startedAt: "2026-08-31T01:01:00.000Z",
      completedAt: null,
      error: null,
      updatedAt: "2026-08-31T01:00:00.000Z",
      scratchpad: "forbidden",
    };
    expect(persistedExecutionStepStateSchema.safeParse(invalid).success).toBe(
      false,
    );
  });

  it("parses an in-flight attempt and rejects incoherent terminal attempts", () => {
    const attempt = {
      attemptId: "attempt-1",
      operationId: "operation-1",
      attemptNumber: 1,
      status: "IN_FLIGHT",
      workerId: "worker-1",
      startedAt: "2026-08-31T01:02:00.000Z",
      finishedAt: null,
      errorSummary: null,
      providerMetadata: null,
    };
    expect(
      persistedExecutionOperationAttemptSchema.safeParse(attempt).success,
    ).toBe(true);
    expect(
      persistedExecutionOperationAttemptSchema.safeParse({
        ...attempt,
        status: "UNKNOWN",
      }).success,
    ).toBe(false);
  });
});
