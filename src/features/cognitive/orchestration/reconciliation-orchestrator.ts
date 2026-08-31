import type {
  OperationAdapter,
  ReconciliationInput,
  ReconciliationResult,
} from "../adapters/adapter-contract";
import type { PersistedExecutionOperation } from "../persistence/contracts/execution-operation";
import {
  type MarkInFlightOperationUnknownCommand,
  markInFlightOperationUnknownCommandSchema,
  type ReconcileOperationCommand,
  reconcileOperationCommandSchema,
} from "../persistence/contracts/reconciliation-commands";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { executionOperationRepository } from "../persistence/postgres/repositories/execution-operation-repository";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import {
  type DatabaseClient,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";

export interface ReconcileOperationResult<
  TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly isReplay: boolean;
  readonly operation: PersistedExecutionOperation;
  readonly reconciliationResult: ReconciliationResult<TResult>;
}

export async function orchestrateOperationReconciliation(
  db: DatabaseClient,
  rawCommand: ReconcileOperationCommand,
): Promise<{
  readonly isReplay: boolean;
  readonly operation: PersistedExecutionOperation;
}> {
  const parsed = reconcileOperationCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid reconcile operation command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;

  return await runInTransaction(db, async (tx) => {
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "reconcile-operation",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash: createCanonicalFingerprint({
        commandIdempotencyKey: command.commandIdempotencyKey,
        operationId: command.operationId,
        expectedOperationRowVersion: command.expectedOperationRowVersion,
        reconciliationOutcome: command.reconciliationOutcome,
        evidenceSummary: command.evidenceSummary,
        providerOperationId: command.providerOperationId ?? null,
        reconciledAt: command.reconciledAt,
      }),
      createdAt: command.reconciledAt,
      updatedAt: command.reconciledAt,
    });

    if (claim.isReplay) {
      const operation = await executionOperationRepository.findOperationById(
        tx,
        command.operationId,
      );
      if (claim.record.status !== "COMPLETED" || !operation) {
        throw PersistenceError.invalidPersistedState(
          "Completed reconciliation replay is missing its durable operation.",
        );
      }
      return { isReplay: true, operation };
    }

    const updatedOperation =
      await executionOperationRepository.reconcileOperation(tx, {
        operationId: command.operationId,
        expectedRowVersion: command.expectedOperationRowVersion,
        reconciliationOutcome: command.reconciliationOutcome,
        evidenceSummary: command.evidenceSummary,
        providerOperationId: command.providerOperationId,
        reconciledAt: command.reconciledAt,
      });

    await idempotencyRepository.completeCommand(tx, {
      scope: "reconcile-operation",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "execution_operation",
      resultResourceId: command.operationId,
      updatedAt: command.reconciledAt,
    });

    return { isReplay: false, operation: updatedOperation };
  });
}

export async function reconcileOperationWithAdapter<
  TRequest extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  TResult extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
>(
  db: DatabaseClient,
  adapter: OperationAdapter<TRequest, TResult>,
  params: {
    readonly commandIdempotencyKey: string;
    readonly operationId: string;
    readonly expectedOperationRowVersion: number;
    readonly reconciledAt: string;
  },
): Promise<ReconcileOperationResult<TResult>> {
  // 1. Fetch current operation state
  const operation = await executionOperationRepository.findOperationById(
    db,
    params.operationId,
  );

  if (!operation) {
    throw PersistenceError.notFound(
      `Operation "${params.operationId}" was not found for reconciliation.`,
    );
  }

  // 2. Query adapter for reconciliation outside of DB transaction
  const reconciliationInput: ReconciliationInput = {
    operationId: operation.operationId,
    operationKind: operation.operationKind,
    providerScope: operation.providerScope,
    providerIdempotencyKey: operation.providerIdempotencyKey,
    providerOperationId: operation.providerOperationId,
    requestFingerprint: operation.requestFingerprint,
    reconciliationRequestedAt: params.reconciledAt,
  };

  let reconciliationResult: ReconciliationResult<TResult>;
  if (adapter.supportsReconciliation && typeof adapter.reconcile === "function") {
    try {
      reconciliationResult = await adapter.reconcile(reconciliationInput);
    } catch (err) {
      reconciliationResult = {
        outcome: "INDETERMINATE",
        uncertaintyReason: `Adapter reconciliation threw unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        reconciledAt: params.reconciledAt,
      };
    }
  } else {
    reconciliationResult = {
      outcome: "INDETERMINATE",
      uncertaintyReason: `Provider adapter "${adapter.scope}" does not support reconciliation.`,
      reconciledAt: params.reconciledAt,
    };
  }

  // 3. Apply reconciliation outcome in DB transaction
  const command: ReconcileOperationCommand = {
    commandIdempotencyKey: params.commandIdempotencyKey,
    operationId: operation.operationId,
    expectedOperationRowVersion: params.expectedOperationRowVersion,
    reconciliationOutcome: reconciliationResult.outcome,
    evidenceSummary:
      reconciliationResult.outcome === "INDETERMINATE"
        ? reconciliationResult.uncertaintyReason
        : reconciliationResult.evidenceSummary,
    providerOperationId:
      reconciliationResult.outcome !== "INDETERMINATE" &&
      reconciliationResult.outcome !== "CONFIRMED_NOT_APPLIED"
        ? (reconciliationResult.providerOperationId ?? null)
        : null,
    reconciledAt: params.reconciledAt,
  };

  const outcome = await orchestrateOperationReconciliation(db, command);

  return {
    isReplay: outcome.isReplay,
    operation: outcome.operation,
    reconciliationResult,
  };
}

export async function orchestrateMarkInFlightUnknown(
  db: DatabaseClient,
  rawCommand: MarkInFlightOperationUnknownCommand,
): Promise<{
  readonly isReplay: boolean;
  readonly operation: PersistedExecutionOperation;
}> {
  const parsed = markInFlightOperationUnknownCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid mark-in-flight-unknown command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;

  return await runInTransaction(db, async (tx) => {
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "mark-in-flight-unknown",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash: createCanonicalFingerprint({
        commandIdempotencyKey: command.commandIdempotencyKey,
        operationId: command.operationId,
        expectedOperationRowVersion: command.expectedOperationRowVersion,
        uncertaintyReason: command.uncertaintyReason,
        occurredAt: command.occurredAt,
      }),
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
    });

    if (claim.isReplay) {
      const operation = await executionOperationRepository.findOperationById(
        tx,
        command.operationId,
      );
      if (claim.record.status !== "COMPLETED" || !operation) {
        throw PersistenceError.invalidPersistedState(
          "Completed mark-in-flight-unknown replay is missing durable operation.",
        );
      }
      return { isReplay: true, operation };
    }

    const updatedOperation =
      await executionOperationRepository.markInFlightUnknown(tx, {
        operationId: command.operationId,
        expectedRowVersion: command.expectedOperationRowVersion,
        uncertaintyReason: command.uncertaintyReason,
        occurredAt: command.occurredAt,
      });

    await idempotencyRepository.completeCommand(tx, {
      scope: "mark-in-flight-unknown",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "execution_operation",
      resultResourceId: command.operationId,
      updatedAt: command.occurredAt,
    });

    return { isReplay: false, operation: updatedOperation };
  });
}
