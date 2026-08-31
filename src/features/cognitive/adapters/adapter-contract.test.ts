import { describe, expect, it } from "vitest";

import type {
  DispatchInput,
  DispatchResult,
  IdempotencySupportLevel,
  ReconciliationResult,
} from "./adapter-contract";
import {
  AdapterConfirmedFailureError,
  AdapterIndeterminateError,
  AdapterPreDispatchError,
  normalizeAdapterError,
} from "./adapter-errors";
import { FakeOperationAdapter } from "./testing/fake-operation-adapter";

describe("provider-neutral adapter contract and error normalization", () => {
  const T0 = "2026-08-31T03:00:00.000Z";

  it("supports strict discriminated union for dispatch results", () => {
    const success: DispatchResult = {
      outcome: "CONFIRMED_SUCCESS",
      providerOperationId: "op-123",
      result: { ok: true },
      finishedAt: T0,
    };
    expect(success.outcome).toBe("CONFIRMED_SUCCESS");

    const failure: DispatchResult = {
      outcome: "CONFIRMED_FAILURE",
      providerOperationId: "op-123",
      errorSummary: "Invalid request payload",
      isDeterministic: true,
      finishedAt: T0,
    };
    expect(failure.outcome).toBe("CONFIRMED_FAILURE");

    const indeterminate: DispatchResult = {
      outcome: "INDETERMINATE",
      providerOperationId: null,
      uncertaintyReason: "HTTP 504 Gateway Timeout",
      category: "TIMEOUT_AFTER_SEND",
      finishedAt: T0,
    };
    expect(indeterminate.outcome).toBe("INDETERMINATE");

    const preDispatch: DispatchResult = {
      outcome: "PRE_DISPATCH_FAILURE",
      errorSummary: "Local validation rejected before sending",
      isDeterministic: true,
      finishedAt: T0,
    };
    expect(preDispatch.outcome).toBe("PRE_DISPATCH_FAILURE");
  });

  it("supports provider idempotency levels NATIVE, EMULATED, and NONE", () => {
    const levels: readonly IdempotencySupportLevel[] = [
      "NATIVE",
      "EMULATED",
      "NONE",
    ];
    expect(levels).toHaveLength(3);
  });

  it("normalizes AdapterPreDispatchError as PRE_DISPATCH_FAILURE", () => {
    const err = new AdapterPreDispatchError("Failed to serialize request payload");
    const result = normalizeAdapterError(err, T0);
    expect(result).toEqual({
      outcome: "PRE_DISPATCH_FAILURE",
      errorSummary: "Failed to serialize request payload",
      isDeterministic: true,
      finishedAt: T0,
    });
  });

  it("normalizes AdapterConfirmedFailureError as CONFIRMED_FAILURE", () => {
    const err = new AdapterConfirmedFailureError("Account does not exist", {
      providerOperationId: "prov-err-1",
    });
    const result = normalizeAdapterError(err, T0);
    expect(result).toEqual({
      outcome: "CONFIRMED_FAILURE",
      providerOperationId: "prov-err-1",
      errorSummary: "Account does not exist",
      isDeterministic: true,
      finishedAt: T0,
    });
  });

  it("normalizes AdapterIndeterminateError as INDETERMINATE with category", () => {
    const err = new AdapterIndeterminateError(
      "Gateway timed out after 30s",
      { category: "TIMEOUT_AFTER_SEND", providerOperationId: "prov-ind-1" },
    );
    const result = normalizeAdapterError(err, T0);
    expect(result).toEqual({
      outcome: "INDETERMINATE",
      providerOperationId: "prov-ind-1",
      uncertaintyReason: "Gateway timed out after 30s",
      category: "TIMEOUT_AFTER_SEND",
      finishedAt: T0,
    });
  });

  it("classifies standard timeout and network errors as INDETERMINATE without assuming failure", () => {
    const timeoutErr = new Error("Request timed out after 10000ms");
    const resTimeout = normalizeAdapterError(timeoutErr, T0);
    expect(resTimeout.outcome).toBe("INDETERMINATE");
    if (resTimeout.outcome === "INDETERMINATE") {
      expect(resTimeout.category).toBe("TIMEOUT_AFTER_SEND");
    }

    const resetErr = new Error("read ECONNRESET");
    const resReset = normalizeAdapterError(resetErr, T0);
    expect(resReset.outcome).toBe("INDETERMINATE");
    if (resReset.outcome === "INDETERMINATE") {
      expect(resReset.category).toBe("CONNECTION_RESET");
    }

    const genericErr = new Error("Unexpected crash during fetch");
    const resGeneric = normalizeAdapterError(genericErr, T0);
    expect(resGeneric.outcome).toBe("INDETERMINATE");
    expect(resGeneric.outcome).not.toBe("CONFIRMED_FAILURE");
  });

  it("fake adapter tracks call counts and simulates all outcomes", async () => {
    const adapter = new FakeOperationAdapter({ mode: "SUCCESS" });
    const input: DispatchInput = {
      operationId: "op-1",
      operationKind: "email.send",
      operationGeneration: 1,
      attemptNumber: 1,
      idempotencyKey: "key-1",
      providerScope: "fake-provider",
      providerIdempotencyKey: "prov-key-1",
      request: { to: "user@example.com" },
    };

    const resSuccess = await adapter.dispatch(input);
    expect(resSuccess.outcome).toBe("CONFIRMED_SUCCESS");
    expect(adapter.dispatchCount).toBe(1);

    adapter.mode = "CONFIRMED_FAILURE";
    const resFail = await adapter.dispatch(input);
    expect(resFail.outcome).toBe("CONFIRMED_FAILURE");
    expect(adapter.dispatchCount).toBe(2);

    adapter.mode = "RECONCILE_SUCCESS";
    const resRec = await adapter.reconcile({
      operationId: "op-1",
      operationKind: "email.send",
      providerScope: "fake-provider",
      providerIdempotencyKey: "prov-key-1",
      providerOperationId: "fake-provider-op-1",
      requestFingerprint: "sha256:fake",
      reconciliationRequestedAt: T0,
    });
    expect(resRec.outcome).toBe("CONFIRMED_SUCCEEDED");
    expect(adapter.reconcileCount).toBe(1);
  });

  it("supports reconciliation discriminated union", () => {
    const succeeded: ReconciliationResult = {
      outcome: "CONFIRMED_SUCCEEDED",
      providerOperationId: "op-rec-1",
      evidenceSummary: "Provider logs confirm transaction success",
      reconciledAt: T0,
    };
    expect(succeeded.outcome).toBe("CONFIRMED_SUCCEEDED");

    const failed: ReconciliationResult = {
      outcome: "CONFIRMED_FAILED",
      providerOperationId: "op-rec-1",
      evidenceSummary: "Provider confirmed transaction failed",
      reconciledAt: T0,
    };
    expect(failed.outcome).toBe("CONFIRMED_FAILED");

    const notApplied: ReconciliationResult = {
      outcome: "CONFIRMED_NOT_APPLIED",
      evidenceSummary: "No transaction found with this idempotency key",
      reconciledAt: T0,
    };
    expect(notApplied.outcome).toBe("CONFIRMED_NOT_APPLIED");

    const indeterminate: ReconciliationResult = {
      outcome: "INDETERMINATE",
      uncertaintyReason: "Provider status API unreachable",
      reconciledAt: T0,
    };
    expect(indeterminate.outcome).toBe("INDETERMINATE");
  });
});
