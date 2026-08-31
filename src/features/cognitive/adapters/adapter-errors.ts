import type {
  DispatchResult,
  IndeterminateCategory,
} from "./adapter-contract";

export class AdapterPreDispatchError extends Error {
  readonly isDeterministic: boolean;

  constructor(message: string, options?: { isDeterministic?: boolean; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "AdapterPreDispatchError";
    this.isDeterministic = options?.isDeterministic ?? true;
  }
}

export class AdapterIndeterminateError extends Error {
  readonly category: IndeterminateCategory;
  readonly providerOperationId: string | null;

  constructor(
    message: string,
    options?: {
      category?: IndeterminateCategory;
      providerOperationId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AdapterIndeterminateError";
    this.category = options?.category ?? "UNKNOWN_DISPATCH_STATE";
    this.providerOperationId = options?.providerOperationId ?? null;
  }
}

export class AdapterConfirmedFailureError extends Error {
  readonly providerOperationId: string | null;

  constructor(
    message: string,
    options?: {
      providerOperationId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AdapterConfirmedFailureError";
    this.providerOperationId = options?.providerOperationId ?? null;
  }
}

export function normalizeAdapterError(
  error: unknown,
  timestamp: string,
): DispatchResult {
  if (error instanceof AdapterPreDispatchError) {
    return {
      outcome: "PRE_DISPATCH_FAILURE",
      errorSummary: error.message,
      isDeterministic: error.isDeterministic,
      finishedAt: timestamp,
    };
  }

  if (error instanceof AdapterConfirmedFailureError) {
    return {
      outcome: "CONFIRMED_FAILURE",
      providerOperationId: error.providerOperationId,
      errorSummary: error.message,
      isDeterministic: true,
      finishedAt: timestamp,
    };
  }

  if (error instanceof AdapterIndeterminateError) {
    return {
      outcome: "INDETERMINATE",
      providerOperationId: error.providerOperationId,
      uncertaintyReason: error.message,
      category: error.category,
      finishedAt: timestamp,
    };
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown adapter execution error";

  const lower = message.toLowerCase();
  let category: IndeterminateCategory = "UNKNOWN_DISPATCH_STATE";

  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    category = "TIMEOUT_AFTER_SEND";
  } else if (
    lower.includes("econnreset") ||
    lower.includes("reset") ||
    lower.includes("socket hang up") ||
    lower.includes("connection closed")
  ) {
    category = "CONNECTION_RESET";
  } else if (lower.includes("network") || lower.includes("ehostunreach") || lower.includes("econnrefused")) {
    category = "NETWORK_PARTITION";
  }

  return {
    outcome: "INDETERMINATE",
    providerOperationId: null,
    uncertaintyReason: `Unhandled adapter error: ${message}`,
    category,
    finishedAt: timestamp,
  };
}
