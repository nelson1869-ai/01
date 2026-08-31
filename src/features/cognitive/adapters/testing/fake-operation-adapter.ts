import type {
  DispatchInput,
  DispatchResult,
  IdempotencySupportLevel,
  OperationAdapter,
  ReconciliationInput,
  ReconciliationResult,
} from "../adapter-contract";
import {
  AdapterIndeterminateError,
  AdapterPreDispatchError,
} from "../adapter-errors";

export type FakeAdapterMode =
  | "SUCCESS"
  | "CONFIRMED_FAILURE"
  | "PRE_DISPATCH_FAILURE"
  | "PRE_DISPATCH_THROW"
  | "TIMEOUT_THROW"
  | "CONNECTION_RESET"
  | "INDETERMINATE"
  | "GENERIC_THROW"
  | "RECONCILE_SUCCESS"
  | "RECONCILE_FAILURE"
  | "RECONCILE_NOT_APPLIED"
  | "RECONCILE_INDETERMINATE"
  | "RECONCILE_UNSUPPORTED";

export interface FakeAdapterOptions {
  readonly scope?: string;
  readonly idempotencySupport?: IdempotencySupportLevel;
  readonly supportsReconciliation?: boolean;
  readonly mode?: FakeAdapterMode;
  readonly simulatedProviderOperationId?: string | null;
  readonly failureSummary?: string;
  readonly uncertaintyReason?: string;
}

export class FakeOperationAdapter implements OperationAdapter {
  readonly scope: string;
  readonly idempotencySupport: IdempotencySupportLevel;
  readonly supportsReconciliation: boolean;

  mode: FakeAdapterMode;
  simulatedProviderOperationId: string | null;
  failureSummary: string;
  uncertaintyReason: string;

  readonly dispatchCalls: DispatchInput[] = [];
  readonly reconcileCalls: ReconciliationInput[] = [];

  constructor(options?: FakeAdapterOptions) {
    this.scope = options?.scope ?? "fake-provider";
    this.idempotencySupport = options?.idempotencySupport ?? "NATIVE";
    this.supportsReconciliation = options?.supportsReconciliation ?? true;
    this.mode = options?.mode ?? "SUCCESS";
    this.simulatedProviderOperationId =
      options?.simulatedProviderOperationId ?? "fake-provider-op-1";
    this.failureSummary =
      options?.failureSummary ?? "Fake deterministic provider rejection.";
    this.uncertaintyReason =
      options?.uncertaintyReason ?? "Fake indeterminate provider outcome.";
  }

  get dispatchCount(): number {
    return this.dispatchCalls.length;
  }

  get reconcileCount(): number {
    return this.reconcileCalls.length;
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.dispatchCalls.push(input);

    const now = new Date().toISOString();

    switch (this.mode) {
      case "SUCCESS":
        return {
          outcome: "CONFIRMED_SUCCESS",
          providerOperationId: this.simulatedProviderOperationId,
          result: { delivered: true, echoRequest: input.request },
          finishedAt: now,
        };

      case "CONFIRMED_FAILURE":
        return {
          outcome: "CONFIRMED_FAILURE",
          providerOperationId: this.simulatedProviderOperationId,
          errorSummary: this.failureSummary,
          isDeterministic: true,
          finishedAt: now,
        };

      case "PRE_DISPATCH_FAILURE":
        return {
          outcome: "PRE_DISPATCH_FAILURE",
          errorSummary: "Pre-dispatch validation failed: invalid payload format.",
          isDeterministic: true,
          finishedAt: now,
        };

      case "PRE_DISPATCH_THROW":
        throw new AdapterPreDispatchError(
          "Local request serialization failed before sending.",
        );

      case "TIMEOUT_THROW":
        throw new AdapterIndeterminateError(
          "HTTP 504 Gateway Timeout while awaiting provider response.",
          { category: "TIMEOUT_AFTER_SEND", providerOperationId: null },
        );

      case "CONNECTION_RESET":
        return {
          outcome: "INDETERMINATE",
          providerOperationId: null,
          uncertaintyReason: "TCP connection reset by peer after request write completed.",
          category: "CONNECTION_RESET",
          finishedAt: now,
        };

      case "INDETERMINATE":
        return {
          outcome: "INDETERMINATE",
          providerOperationId: null,
          uncertaintyReason: this.uncertaintyReason,
          category: "INDETERMINATE_PROVIDER_STATE",
          finishedAt: now,
        };

      case "GENERIC_THROW":
        throw new Error("Unexpected socket closed without response.");

      default:
        return {
          outcome: "CONFIRMED_SUCCESS",
          providerOperationId: this.simulatedProviderOperationId,
          result: { delivered: true },
          finishedAt: now,
        };
    }
  }

  async reconcile(input: ReconciliationInput): Promise<ReconciliationResult> {
    this.reconcileCalls.push(input);

    const now = new Date().toISOString();

    if (!this.supportsReconciliation || this.mode === "RECONCILE_UNSUPPORTED") {
      return {
        outcome: "INDETERMINATE",
        uncertaintyReason: `Provider "${this.scope}" does not support external reconciliation.`,
        reconciledAt: now,
      };
    }

    switch (this.mode) {
      case "RECONCILE_SUCCESS":
      case "SUCCESS":
        return {
          outcome: "CONFIRMED_SUCCEEDED",
          providerOperationId:
            input.providerOperationId ?? this.simulatedProviderOperationId,
          evidenceSummary: "Provider confirmed transaction committed successfully.",
          reconciledAt: now,
          result: { verified: true },
        };

      case "RECONCILE_FAILURE":
      case "CONFIRMED_FAILURE":
        return {
          outcome: "CONFIRMED_FAILED",
          providerOperationId:
            input.providerOperationId ?? this.simulatedProviderOperationId,
          evidenceSummary: "Provider confirmed transaction was rejected with permanent error.",
          reconciledAt: now,
        };

      case "RECONCILE_NOT_APPLIED":
        return {
          outcome: "CONFIRMED_NOT_APPLIED",
          evidenceSummary: "Provider confirmed idempotency key has no record and no effect was applied.",
          reconciledAt: now,
        };

      case "RECONCILE_INDETERMINATE":
      case "TIMEOUT_THROW":
      case "CONNECTION_RESET":
      case "INDETERMINATE":
      default:
        return {
          outcome: "INDETERMINATE",
          uncertaintyReason: "Provider status check timed out during reconciliation query.",
          reconciledAt: now,
        };
    }
  }
}
