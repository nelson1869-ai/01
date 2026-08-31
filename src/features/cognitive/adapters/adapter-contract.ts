import type { z } from "zod";
import type { jsonObjectSchema } from "../persistence/contracts/primitives";

export type IdempotencySupportLevel = "NATIVE" | "EMULATED" | "NONE";

export interface DispatchCorrelationMetadata {
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly stepId?: string;
}

export type JSONObject = z.infer<typeof jsonObjectSchema>;

export interface DispatchInput<
  TRequest extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly operationId: string;
  readonly operationKind: string;
  readonly operationGeneration: number;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly providerScope: string | null;
  readonly providerIdempotencyKey: string | null;
  readonly request: TRequest;
  readonly correlation?: DispatchCorrelationMetadata;
}

export type IndeterminateCategory =
  | "TIMEOUT_AFTER_SEND"
  | "CONNECTION_RESET"
  | "INDETERMINATE_PROVIDER_STATE"
  | "NETWORK_PARTITION"
  | "UNKNOWN_DISPATCH_STATE";

export interface ConfirmedSuccessDispatchResult<
  TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly outcome: "CONFIRMED_SUCCESS";
  readonly providerOperationId: string | null;
  readonly result: TResult;
  readonly finishedAt: string;
  readonly metadata?: JSONObject | null;
}

export interface ConfirmedFailureDispatchResult {
  readonly outcome: "CONFIRMED_FAILURE";
  readonly providerOperationId: string | null;
  readonly errorSummary: string;
  readonly isDeterministic: true;
  readonly finishedAt: string;
  readonly metadata?: JSONObject | null;
}

export interface IndeterminateDispatchResult {
  readonly outcome: "INDETERMINATE";
  readonly providerOperationId: string | null;
  readonly uncertaintyReason: string;
  readonly category: IndeterminateCategory;
  readonly finishedAt: string;
  readonly metadata?: JSONObject | null;
}

export interface PreDispatchFailureResult {
  readonly outcome: "PRE_DISPATCH_FAILURE";
  readonly errorSummary: string;
  readonly isDeterministic: boolean;
  readonly finishedAt: string;
  readonly metadata?: JSONObject | null;
}

export type DispatchResult<
  TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> =
  | ConfirmedSuccessDispatchResult<TResult>
  | ConfirmedFailureDispatchResult
  | IndeterminateDispatchResult
  | PreDispatchFailureResult;

export interface ReconciliationInput {
  readonly operationId: string;
  readonly operationKind: string;
  readonly providerScope: string | null;
  readonly providerIdempotencyKey: string | null;
  readonly providerOperationId: string | null;
  readonly requestFingerprint: string;
  readonly reconciliationRequestedAt: string;
}

export interface ConfirmedSucceededReconciliationResult<
  TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly outcome: "CONFIRMED_SUCCEEDED";
  readonly providerOperationId: string | null;
  readonly evidenceSummary: string;
  readonly reconciledAt: string;
  readonly result?: TResult | null;
}

export interface ConfirmedFailedReconciliationResult {
  readonly outcome: "CONFIRMED_FAILED";
  readonly providerOperationId: string | null;
  readonly evidenceSummary: string;
  readonly reconciledAt: string;
}

export interface ConfirmedNotAppliedReconciliationResult {
  readonly outcome: "CONFIRMED_NOT_APPLIED";
  readonly evidenceSummary: string;
  readonly reconciledAt: string;
}

export interface IndeterminateReconciliationResult {
  readonly outcome: "INDETERMINATE";
  readonly uncertaintyReason: string;
  readonly reconciledAt: string;
}

export type ReconciliationResult<
  TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> =
  | ConfirmedSucceededReconciliationResult<TResult>
  | ConfirmedFailedReconciliationResult
  | ConfirmedNotAppliedReconciliationResult
  | IndeterminateReconciliationResult;

export interface OperationAdapter<
  TRequest extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly scope: string;
  readonly idempotencySupport: IdempotencySupportLevel;
  readonly supportsReconciliation: boolean;

  dispatch(input: DispatchInput<TRequest>): Promise<DispatchResult<TResult>>;

  reconcile?(input: ReconciliationInput): Promise<ReconciliationResult<TResult>>;
}
