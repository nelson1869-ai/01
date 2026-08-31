import type {
  DispatchResult,
  ReconciliationResult,
} from "../adapters/adapter-contract";
import type { PersistedExecutionOperation } from "../persistence/contracts/execution-operation";
import {
  assertObservationDataSecurity,
  type RecordObservationCommand,
  recordObservationCommandSchema,
} from "../persistence/contracts/observation-commands";
import type { PersistedObservation } from "../persistence/contracts/persisted-observation";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { executionRepository } from "../persistence/postgres/repositories/execution-repository";
import { executionStepRepository } from "../persistence/postgres/repositories/execution-step-repository";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import { observationRepository } from "../persistence/postgres/repositories/observation-repository";
import {
  type DatabaseClient,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";

export async function recordObservation(
  db: DatabaseClient,
  rawCommand: RecordObservationCommand,
): Promise<{
  readonly isReplay: boolean;
  readonly observation: PersistedObservation;
}> {
  const parsed = recordObservationCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid record observation command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;

  // 1. Enforce strict observation security at boundary
  assertObservationDataSecurity(command.data);

  return await runInTransaction(db, async (tx) => {
    // 2. Validate that referenced execution exists
    const execution = await executionRepository.findExecutionById(
      tx,
      command.executionId,
    );
    if (!execution) {
      throw PersistenceError.notFound(
        `Execution "${command.executionId}" was not found for observation "${command.observationId}".`,
      );
    }

    // 3. If step-scoped, validate that referenced step exists for this execution
    if (command.stepId) {
      const step = await executionStepRepository.findStep(
        tx,
        command.executionId,
        command.stepId,
      );
      if (!step) {
        throw PersistenceError.notFound(
          `Step "${command.stepId}" was not found in execution "${command.executionId}" for observation.`,
        );
      }
    }

    // 4. Idempotency claim
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "record-observation",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash: createCanonicalFingerprint({
        commandIdempotencyKey: command.commandIdempotencyKey,
        observationId: command.observationId,
        executionId: command.executionId,
        stepId: command.stepId ?? null,
        source: command.source,
        sourceEventId: command.sourceEventId ?? null,
        summary: command.summary,
        data: command.data,
        observedAt: command.observedAt,
        payloadExpiresAt: command.payloadExpiresAt ?? null,
      }),
      createdAt: command.observedAt,
      updatedAt: command.observedAt,
    });

    if (claim.isReplay) {
      const existing = await observationRepository.findObservationById(
        tx,
        command.observationId,
      );
      if (claim.record.status !== "COMPLETED" || !existing) {
        throw PersistenceError.invalidPersistedState(
          "Completed observation replay is missing its durable record.",
        );
      }
      return { isReplay: true, observation: existing };
    }

    const appendResult = await observationRepository.appendObservation(tx, {
      observationId: command.observationId,
      executionId: command.executionId,
      stepId: command.stepId ?? null,
      source: command.source,
      sourceEventId: command.sourceEventId ?? null,
      summary: command.summary,
      data: command.data,
      observedAt: command.observedAt,
      payloadExpiresAt: command.payloadExpiresAt ?? null,
    });

    await idempotencyRepository.completeCommand(tx, {
      scope: "record-observation",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "observation",
      resultResourceId: command.observationId,
      updatedAt: command.observedAt,
    });

    return { isReplay: appendResult.isReplay, observation: appendResult.observation };
  });
}

export async function recordObservationFromDispatch(
  db: DatabaseClient,
  params: {
    readonly commandIdempotencyKey: string;
    readonly observationId: string;
    readonly executionId: string;
    readonly stepId: string | null;
    readonly operation: PersistedExecutionOperation;
    readonly dispatchResult: DispatchResult;
    readonly observedAt: string;
  },
): Promise<{
  readonly isReplay: boolean;
  readonly observation: PersistedObservation;
}> {
  let summary: string;
  switch (params.dispatchResult.outcome) {
    case "CONFIRMED_SUCCESS":
      summary = `Provider confirmed successful execution of operation "${params.operation.operationId}".`;
      break;
    case "CONFIRMED_FAILURE":
      summary = `Provider confirmed deterministic failure for operation "${params.operation.operationId}": ${params.dispatchResult.errorSummary}`;
      break;
    case "PRE_DISPATCH_FAILURE":
      summary = `Pre-dispatch failure for operation "${params.operation.operationId}": ${params.dispatchResult.errorSummary}`;
      break;
    case "INDETERMINATE":
    default:
      summary = `Provider dispatch indeterminate for operation "${params.operation.operationId}": ${params.dispatchResult.uncertaintyReason}`;
      break;
  }

  const providerOpId =
    "providerOperationId" in params.dispatchResult
      ? params.dispatchResult.providerOperationId
      : null;

  const data = {
    operationId: params.operation.operationId,
    operationKind: params.operation.operationKind,
    outcome: params.dispatchResult.outcome,
    providerOperationId: providerOpId ?? null,
    finishedAt: params.dispatchResult.finishedAt,
  };

  return await recordObservation(db, {
    commandIdempotencyKey: params.commandIdempotencyKey,
    observationId: params.observationId,
    executionId: params.executionId,
    stepId: params.stepId,
    source: "provider-dispatch",
    sourceEventId:
      providerOpId ??
      params.operation.providerOperationId ??
      params.operation.operationId,
    summary,
    data,
    observedAt: params.observedAt,
    payloadExpiresAt: null,
  });
}

export async function recordObservationFromReconciliation(
  db: DatabaseClient,
  params: {
    readonly commandIdempotencyKey: string;
    readonly observationId: string;
    readonly executionId: string;
    readonly stepId: string | null;
    readonly operation: PersistedExecutionOperation;
    readonly reconciliationResult: ReconciliationResult;
    readonly observedAt: string;
  },
): Promise<{
  readonly isReplay: boolean;
  readonly observation: PersistedObservation;
}> {
  let summary: string;
  let providerOpId: string | null = null;

  switch (params.reconciliationResult.outcome) {
    case "CONFIRMED_SUCCEEDED":
      summary = `Provider reconciliation confirmed operation "${params.operation.operationId}" succeeded externally.`;
      providerOpId = params.reconciliationResult.providerOperationId ?? null;
      break;
    case "CONFIRMED_FAILED":
      summary = `Provider reconciliation confirmed operation "${params.operation.operationId}" failed externally.`;
      providerOpId = params.reconciliationResult.providerOperationId ?? null;
      break;
    case "CONFIRMED_NOT_APPLIED":
      summary = `Provider reconciliation confirmed operation "${params.operation.operationId}" was not applied externally.`;
      break;
    case "INDETERMINATE":
    default:
      summary = `Provider reconciliation indeterminate for operation "${params.operation.operationId}": ${params.reconciliationResult.uncertaintyReason}`;
      break;
  }

  const data = {
    operationId: params.operation.operationId,
    operationKind: params.operation.operationKind,
    outcome: params.reconciliationResult.outcome,
    providerOperationId: providerOpId,
    reconciledAt: params.reconciliationResult.reconciledAt,
  };

  return await recordObservation(db, {
    commandIdempotencyKey: params.commandIdempotencyKey,
    observationId: params.observationId,
    executionId: params.executionId,
    stepId: params.stepId,
    source: "provider-reconciliation",
    sourceEventId: providerOpId ?? params.operation.operationId,
    summary,
    data,
    observedAt: params.observedAt,
    payloadExpiresAt: null,
  });
}
