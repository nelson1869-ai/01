import type {
  DispatchInput,
  DispatchResult,
  JSONObject,
  OperationAdapter,
} from "../adapters/adapter-contract";
import { normalizeAdapterError } from "../adapters/adapter-errors";
import type { ExecutionSafetyState } from "../domain/execution-safety";
import {
  type DispatchOperationCommand,
  dispatchOperationCommandSchema,
} from "../persistence/contracts/dispatch-operation-command";
import type { PersistedExecutionOperation } from "../persistence/contracts/execution-operation";
import type { PersistedExecutionOperationAttempt } from "../persistence/contracts/execution-operation-attempt";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import { assertLiveExecutionAuthorization } from "./execution-authorization-guard";
import {
  recordOperationFailed,
  recordOperationSucceeded,
  recordOperationUnknown,
} from "./execution-outcome-orchestrator";
import { beginAuthorizedOperationAttempt } from "./execution-progress-orchestrator";

export interface DispatchAuthorizedOperationResult<
  TResult extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly isReplay: boolean;
  readonly operation: PersistedExecutionOperation;
  readonly attempt: PersistedExecutionOperationAttempt;
  readonly dispatchResult: DispatchResult<TResult>;
}

export async function dispatchAuthorizedOperation<
  TRequest extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
  TResult extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
>(
  db: DatabaseClient,
  authorization: ExecutionSafetyState,
  adapter: OperationAdapter<TRequest, TResult>,
  rawCommand: DispatchOperationCommand,
): Promise<DispatchAuthorizedOperationResult<TResult>> {
  const parsed = dispatchOperationCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid dispatch operation command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;

  // 1. Validate live runtime authorization before ANY external dispatch or attempt begin
  assertLiveExecutionAuthorization(
    authorization,
    command.expectedSafetyGeneration,
  );

  // 2. TRANSACTION A: Move PENDING -> IN_FLIGHT and record attempt #1 IN_FLIGHT (commits before external call)
  const beginResult = await beginAuthorizedOperationAttempt(db, authorization, {
    commandIdempotencyKey: command.commandIdempotencyKey,
    attemptId: command.attemptId,
    operationId: command.operationId,
    executionId: command.executionId,
    sessionId: command.sessionId,
    planId: command.planId,
    stepId: command.stepId,
    expectedOperationRowVersion: command.expectedOperationRowVersion,
    expectedSafetyGeneration: command.expectedSafetyGeneration,
    workerId: command.workerId,
    startedAt: command.startedAt,
  });

  if (beginResult.isReplay) {
    // If the begin-attempt was already committed (e.g. duplicate caller or prior crashed attempt),
    // do not issue a duplicate external side effect. Return the existing durable state.
    const isTerminal =
      beginResult.operation.status === "SUCCEEDED" ||
      beginResult.operation.status === "FAILED" ||
      beginResult.operation.status === "UNKNOWN";

    const syntheticResult: DispatchResult<TResult> = isTerminal
      ? beginResult.operation.status === "SUCCEEDED"
        ? {
            outcome: "CONFIRMED_SUCCESS",
            providerOperationId: beginResult.operation.providerOperationId,
            result: {} as TResult,
            finishedAt: beginResult.operation.updatedAt,
          }
        : beginResult.operation.status === "FAILED"
          ? {
              outcome: "CONFIRMED_FAILURE",
              providerOperationId: beginResult.operation.providerOperationId,
              errorSummary: "Operation previously failed.",
              isDeterministic: true,
              finishedAt: beginResult.operation.updatedAt,
            }
          : {
              outcome: "INDETERMINATE",
              providerOperationId: beginResult.operation.providerOperationId,
              uncertaintyReason:
                beginResult.operation.uncertaintyReason ??
                "Operation previously marked UNKNOWN.",
              category: "INDETERMINATE_PROVIDER_STATE",
              finishedAt: beginResult.operation.updatedAt,
            }
      : {
          outcome: "INDETERMINATE",
          providerOperationId: beginResult.operation.providerOperationId,
          uncertaintyReason:
            "Operation attempt is already in-flight from a prior dispatch.",
          category: "INDETERMINATE_PROVIDER_STATE",
          finishedAt: beginResult.attempt.startedAt,
        };

    return {
      isReplay: true,
      operation: beginResult.operation,
      attempt: beginResult.attempt,
      dispatchResult: syntheticResult,
    };
  }

  // 3. EXTERNAL CALL: No database transaction is held during adapter dispatch
  const dispatchInput: DispatchInput<TRequest> = {
    operationId: command.operationId,
    operationKind: beginResult.operation.operationKind,
    operationGeneration: command.operationGeneration,
    attemptNumber: beginResult.attempt.attemptNumber,
    idempotencyKey: beginResult.operation.idempotencyKey,
    providerScope: beginResult.operation.providerScope,
    providerIdempotencyKey: beginResult.operation.providerIdempotencyKey,
    request: command.request as TRequest,
    correlation: {
      sessionId: command.sessionId,
      executionId: command.executionId,
      stepId: command.stepId,
    },
  };

  let dispatchResult: DispatchResult<TResult>;
  try {
    dispatchResult = await adapter.dispatch(dispatchInput);
  } catch (error) {
    dispatchResult = normalizeAdapterError(
      error,
      new Date().toISOString(),
    ) as DispatchResult<TResult>;
  }

  // 4. TRANSACTION B: Record factual outcome durably (does not require live authorization)
  const outcomeCommandKey = `outcome:${command.commandIdempotencyKey}`;
  const rowVersionForOutcome = beginResult.operation.rowVersion;

  let outcomeOperation: PersistedExecutionOperation;
  let outcomeAttempt: PersistedExecutionOperationAttempt;

  switch (dispatchResult.outcome) {
    case "CONFIRMED_SUCCESS": {
      const rawMetadata =
        dispatchResult.result ?? dispatchResult.metadata ?? null;
      const cleanMetadata =
        rawMetadata !== null
          ? (JSON.parse(JSON.stringify(rawMetadata)) as JSONObject)
          : null;

      const outcome = await recordOperationSucceeded(db, {
        commandIdempotencyKey: outcomeCommandKey,
        operationId: command.operationId,
        attemptId: command.attemptId,
        expectedOperationRowVersion: rowVersionForOutcome,
        outcome: "SUCCEEDED",
        providerOperationId: dispatchResult.providerOperationId ?? null,
        resultMetadata: cleanMetadata,
        finishedAt: dispatchResult.finishedAt,
      });
      outcomeOperation = outcome.operation;
      outcomeAttempt = outcome.attempt;
      break;
    }

    case "CONFIRMED_FAILURE": {
      const outcome = await recordOperationFailed(db, {
        commandIdempotencyKey: outcomeCommandKey,
        operationId: command.operationId,
        attemptId: command.attemptId,
        expectedOperationRowVersion: rowVersionForOutcome,
        outcome: "FAILED",
        errorSummary: dispatchResult.errorSummary,
        providerOperationId: dispatchResult.providerOperationId ?? null,
        resultMetadata: dispatchResult.metadata ?? null,
        finishedAt: dispatchResult.finishedAt,
      });
      outcomeOperation = outcome.operation;
      outcomeAttempt = outcome.attempt;
      break;
    }

    case "PRE_DISPATCH_FAILURE": {
      const outcome = await recordOperationFailed(db, {
        commandIdempotencyKey: outcomeCommandKey,
        operationId: command.operationId,
        attemptId: command.attemptId,
        expectedOperationRowVersion: rowVersionForOutcome,
        outcome: "FAILED",
        errorSummary: `Pre-dispatch failure: ${dispatchResult.errorSummary}`,
        providerOperationId: null,
        resultMetadata: dispatchResult.metadata ?? null,
        finishedAt: dispatchResult.finishedAt,
      });
      outcomeOperation = outcome.operation;
      outcomeAttempt = outcome.attempt;
      break;
    }

    case "INDETERMINATE":
    default: {
      const outcome = await recordOperationUnknown(db, {
        commandIdempotencyKey: outcomeCommandKey,
        operationId: command.operationId,
        attemptId: command.attemptId,
        expectedOperationRowVersion: rowVersionForOutcome,
        outcome: "UNKNOWN",
        uncertaintyReason: dispatchResult.uncertaintyReason,
        providerOperationId: dispatchResult.providerOperationId ?? null,
        resultMetadata: dispatchResult.metadata ?? null,
        finishedAt: dispatchResult.finishedAt,
      });
      outcomeOperation = outcome.operation;
      outcomeAttempt = outcome.attempt;
      break;
    }
  }

  return {
    isReplay: false,
    operation: outcomeOperation,
    attempt: outcomeAttempt,
    dispatchResult,
  };
}
