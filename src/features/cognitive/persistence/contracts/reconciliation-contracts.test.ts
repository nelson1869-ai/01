import { describe, expect, it } from "vitest";

import { dispatchOperationCommandSchema } from "./dispatch-operation-command";
import {
  markInFlightOperationUnknownCommandSchema,
  reconcileOperationCommandSchema,
} from "./reconciliation-commands";

describe("reconciliation and dispatch command contracts", () => {
  const T0 = "2026-08-31T03:00:00.000Z";

  it("parses valid reconcile operation command", () => {
    const valid = {
      commandIdempotencyKey: "reconcile:op-1:1",
      operationId: "operation-1",
      expectedOperationRowVersion: 1,
      reconciliationOutcome: "CONFIRMED_SUCCEEDED",
      evidenceSummary: "External system logs confirm success",
      providerOperationId: "prov-op-1",
      reconciledAt: T0,
    };
    expect(reconcileOperationCommandSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    "CONFIRMED_SUCCEEDED",
    "CONFIRMED_FAILED",
    "CONFIRMED_NOT_APPLIED",
    "INDETERMINATE",
  ])("accepts legal reconciliation outcome %s", (outcome) => {
    const cmd = {
      commandIdempotencyKey: "reconcile:op-1:1",
      operationId: "operation-1",
      expectedOperationRowVersion: 1,
      reconciliationOutcome: outcome,
      evidenceSummary: "Evidence summary",
      reconciledAt: T0,
    };
    expect(reconcileOperationCommandSchema.safeParse(cmd).success).toBe(true);
  });

  it("rejects illegal reconciliation outcome", () => {
    const invalid = {
      commandIdempotencyKey: "reconcile:op-1:1",
      operationId: "operation-1",
      expectedOperationRowVersion: 1,
      reconciliationOutcome: "AUTO_RETRY",
      evidenceSummary: "Evidence",
      reconciledAt: T0,
    };
    expect(reconcileOperationCommandSchema.safeParse(invalid).success).toBe(false);
  });

  it("parses valid mark in-flight unknown command", () => {
    const valid = {
      commandIdempotencyKey: "unknown:op-1:1",
      operationId: "operation-1",
      expectedOperationRowVersion: 1,
      uncertaintyReason: "Process restarted while operation was in flight",
      occurredAt: T0,
    };
    expect(
      markInFlightOperationUnknownCommandSchema.safeParse(valid).success,
    ).toBe(true);
  });

  it("parses valid dispatch operation command", () => {
    const valid = {
      commandIdempotencyKey: "dispatch:op-1:1",
      operationId: "operation-1",
      attemptId: "attempt-1",
      executionId: "execution-1",
      sessionId: "session-1",
      planId: "plan-1",
      stepId: "step-1",
      operationGeneration: 1,
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: 3,
      workerId: "worker-1",
      startedAt: T0,
      request: { action: "test", params: { count: 1 } },
    };
    expect(dispatchOperationCommandSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    "authorization",
    "authBrand",
    "password",
    "token",
    "secret",
    "apiKey",
  ])("rejects secret or forbidden field %s in dispatch command root", (field) => {
    const invalid = {
      commandIdempotencyKey: "dispatch:op-1:1",
      operationId: "operation-1",
      attemptId: "attempt-1",
      executionId: "execution-1",
      sessionId: "session-1",
      planId: "plan-1",
      stepId: "step-1",
      operationGeneration: 1,
      expectedOperationRowVersion: 0,
      expectedSafetyGeneration: 3,
      workerId: null,
      startedAt: T0,
      request: {},
      [field]: "forbidden",
    };
    expect(dispatchOperationCommandSchema.safeParse(invalid).success).toBe(false);
  });
});
