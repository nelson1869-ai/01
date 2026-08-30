import { describe, expect, it } from "vitest";

import { persistedExecutionSchema } from "./execution";
import { persistedExecutionOperationSchema } from "./execution-operation";
import { executionTransitionCommandSchema } from "./transition-commands";

const validExecution = {
  executionId: "execution-1",
  sessionId: "session-1",
  planId: "plan-1",
  status: "RUNNING",
  currentStepId: "step-1",
  startedAt: "2026-08-30T00:01:00.000Z",
  completedAt: null,
  error: null,
  rowVersion: 3,
  safetyGenerationAtStart: 7,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:01:00.000Z",
};

const validOperation = {
  operationId: "operation-1",
  executionId: "execution-1",
  stepId: "step-1",
  operationGeneration: 1,
  operationKind: "email.send",
  idempotencyKey: "operation:execution-1:step-1:1",
  requestFingerprint: "sha256:request-1",
  status: "IN_FLIGHT",
  attemptCount: 1,
  providerScope: "email-provider",
  providerIdempotencyKey: "operation:execution-1:step-1:1",
  providerOperationId: "provider-operation-1",
  uncertaintyReason: null,
  reconciliationStatus: "NOT_REQUIRED",
  reconciliationOutcome: null,
  rowVersion: 2,
  createdAt: "2026-08-30T00:01:00.000Z",
  updatedAt: "2026-08-30T00:01:30.000Z",
};

describe("persisted execution contract", () => {
  it("parses a valid crash-resumable execution record", () => {
    expect(persistedExecutionSchema.safeParse(validExecution).success).toBe(
      true,
    );
  });

  it("rejects invalid execution statuses", () => {
    expect(
      persistedExecutionSchema.safeParse({
        ...validExecution,
        status: "STARTED",
      }).success,
    ).toBe(false);
  });

  it("rejects negative row versions and safety generations", () => {
    expect(
      persistedExecutionSchema.safeParse({
        ...validExecution,
        rowVersion: -1,
      }).success,
    ).toBe(false);

    expect(
      persistedExecutionSchema.safeParse({
        ...validExecution,
        safetyGenerationAtStart: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects timestamp/state contradictions", () => {
    expect(
      persistedExecutionSchema.safeParse({
        ...validExecution,
        status: "PENDING",
      }).success,
    ).toBe(false);
  });
});

describe("execution operation idempotency contract", () => {
  it("parses one stable logical side-effect operation", () => {
    expect(
      persistedExecutionOperationSchema.safeParse(validOperation).success,
    ).toBe(true);
  });

  it("supports UNKNOWN without pretending the effect failed", () => {
    expect(
      persistedExecutionOperationSchema.safeParse({
        ...validOperation,
        status: "UNKNOWN",
        uncertaintyReason: "Provider accepted the request but response was lost.",
        reconciliationStatus: "REQUIRED",
      }).success,
    ).toBe(true);
  });

  it("rejects UNKNOWN without a reconciliation reason", () => {
    expect(
      persistedExecutionOperationSchema.safeParse({
        ...validOperation,
        status: "UNKNOWN",
        reconciliationStatus: "REQUIRED",
      }).success,
    ).toBe(false);
  });

  it("rejects empty and overlong idempotency keys", () => {
    expect(
      persistedExecutionOperationSchema.safeParse({
        ...validOperation,
        idempotencyKey: "   ",
      }).success,
    ).toBe(false);

    expect(
      persistedExecutionOperationSchema.safeParse({
        ...validOperation,
        idempotencyKey: "x".repeat(513),
      }).success,
    ).toBe(false);
  });

  it("rejects zero-based or non-integer operation generations", () => {
    expect(
      persistedExecutionOperationSchema.safeParse({
        ...validOperation,
        operationGeneration: 0,
      }).success,
    ).toBe(false);

    expect(
      persistedExecutionOperationSchema.safeParse({
        ...validOperation,
        operationGeneration: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe("execution transition command contract", () => {
  it("requires optimistic-concurrency and idempotency identities", () => {
    expect(
      executionTransitionCommandSchema.safeParse({
        executionId: "execution-1",
        expectedRowVersion: 3,
        expectedStatus: "PENDING",
        nextStatus: "RUNNING",
        expectedSafetyGeneration: 7,
        commandIdempotencyKey: "execution:execution-1:pending:running:3",
      }).success,
    ).toBe(true);
  });
});
