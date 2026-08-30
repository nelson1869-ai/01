import { and, eq } from "drizzle-orm";

import { isLegalExecutionOperationTransition } from "../../../domain/execution-lifecycle";
import type { PersistedExecutionOperation } from "../../contracts/execution-operation";
import type { PersistedExecutionOperationAttempt } from "../../contracts/execution-operation-attempt";
import { PersistenceError } from "../errors/persistence-errors";
import {
  executionOperationAttempts,
  executionOperations,
} from "../schema/execution";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import {
  decodeExecutionOperationAttemptRow,
  decodeExecutionOperationRow,
} from "../utils/row-mappers";

export type OperationOutcome = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export class ExecutionOperationRepository {
  async findOperationById(
    executor: DatabaseExecutor,
    operationId: string,
  ): Promise<PersistedExecutionOperation | null> {
    const rows = await executor
      .select()
      .from(executionOperations)
      .where(eq(executionOperations.operationId, operationId))
      .limit(1);

    return rows.length === 0 ? null : decodeExecutionOperationRow(rows[0]);
  }

  async findOperationByIdempotencyKey(
    executor: DatabaseExecutor,
    idempotencyKey: string,
  ): Promise<PersistedExecutionOperation | null> {
    const rows = await executor
      .select()
      .from(executionOperations)
      .where(eq(executionOperations.operationIdempotencyKey, idempotencyKey))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeExecutionOperationRow(rows[0]);
  }

  async findOperationByLogicalIdentity(
    executor: DatabaseExecutor,
    executionId: string,
    stepId: string,
    operationGeneration: number,
  ): Promise<PersistedExecutionOperation | null> {
    const rows = await executor
      .select()
      .from(executionOperations)
      .where(
        and(
          eq(executionOperations.executionId, executionId),
          eq(executionOperations.stepId, stepId),
          eq(
            executionOperations.operationGeneration,
            operationGeneration,
          ),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeExecutionOperationRow(rows[0]);
  }

  async reserveExecutionOperation(
    executor: DatabaseExecutor,
    operation: PersistedExecutionOperation,
  ): Promise<{
    isReplay: boolean;
    operation: PersistedExecutionOperation;
  }> {
    const insertedRows = await executor
      .insert(executionOperations)
      .values({
        operationId: operation.operationId,
        executionId: operation.executionId,
        stepId: operation.stepId,
        operationGeneration: operation.operationGeneration,
        operationKind: operation.operationKind,
        operationIdempotencyKey: operation.idempotencyKey,
        requestFingerprint: operation.requestFingerprint,
        status: operation.status,
        attemptCount: operation.attemptCount,
        providerScope: operation.providerScope,
        providerIdempotencyKey: operation.providerIdempotencyKey,
        providerOperationId: operation.providerOperationId,
        uncertaintyReason: operation.uncertaintyReason,
        reconciliationStatus: operation.reconciliationStatus,
        reconciliationOutcome: operation.reconciliationOutcome,
        rowVersion: operation.rowVersion,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows.length > 0) {
      return {
        isReplay: false,
        operation: decodeExecutionOperationRow(insertedRows[0]),
      };
    }

    const existing =
      (await this.findOperationByIdempotencyKey(
        executor,
        operation.idempotencyKey,
      )) ??
      (await this.findOperationByLogicalIdentity(
        executor,
        operation.executionId,
        operation.stepId,
        operation.operationGeneration,
      ));

    if (existing !== null) {
      if (
        existing.operationId === operation.operationId &&
        existing.requestFingerprint === operation.requestFingerprint &&
        existing.operationKind === operation.operationKind &&
        existing.executionId === operation.executionId &&
        existing.stepId === operation.stepId &&
        existing.operationGeneration === operation.operationGeneration &&
        existing.idempotencyKey === operation.idempotencyKey &&
        existing.providerScope === operation.providerScope &&
        existing.providerIdempotencyKey === operation.providerIdempotencyKey
      ) {
        return { isReplay: true, operation: existing };
      }

      throw PersistenceError.idempotencyConflict(
        `Execution operation with idempotency key "${operation.idempotencyKey}" already exists with different request fingerprint or kind.`,
        {
          idempotencyKey: operation.idempotencyKey,
          existingOperationId: existing.operationId,
        },
      );
    }

    throw PersistenceError.staleWrite(
      `Execution operation with idempotency key "${operation.idempotencyKey}" conflicted but could not be retrieved.`,
      { idempotencyKey: operation.idempotencyKey },
    );
  }

  async findAttemptById(
    executor: DatabaseExecutor,
    attemptId: string,
  ): Promise<PersistedExecutionOperationAttempt | null> {
    const rows = await executor
      .select()
      .from(executionOperationAttempts)
      .where(eq(executionOperationAttempts.attemptId, attemptId))
      .limit(1);

    return rows.length === 0
      ? null
      : decodeExecutionOperationAttemptRow(rows[0]);
  }

  async beginAttempt(
    executor: DatabaseExecutor,
    params: {
      readonly operationId: string;
      readonly expectedRowVersion: number;
      readonly attemptId: string;
      readonly workerId: string | null;
      readonly startedAt: string;
    },
  ): Promise<{
    operation: PersistedExecutionOperation;
    attempt: PersistedExecutionOperationAttempt;
  }> {
    if (!isLegalExecutionOperationTransition("PENDING", "IN_FLIGHT")) {
      throw PersistenceError.invalidPersistedState(
        "Operation transition table rejected PENDING -> IN_FLIGHT.",
      );
    }

    const operationRows = await executor
      .update(executionOperations)
      .set({
        status: "IN_FLIGHT",
        attemptCount: 1,
        rowVersion: params.expectedRowVersion + 1,
        updatedAt: params.startedAt,
      })
      .where(
        and(
          eq(executionOperations.operationId, params.operationId),
          eq(executionOperations.status, "PENDING"),
          eq(executionOperations.attemptCount, 0),
          eq(executionOperations.rowVersion, params.expectedRowVersion),
        ),
      )
      .returning();

    if (operationRows.length === 0) {
      throw PersistenceError.staleWrite(
        `Operation "${params.operationId}" could not begin attempt at row_version ${params.expectedRowVersion}.`,
      );
    }

    const attemptRows = await executor
      .insert(executionOperationAttempts)
      .values({
        attemptId: params.attemptId,
        operationId: params.operationId,
        attemptNumber: 1,
        status: "IN_FLIGHT",
        workerId: params.workerId,
        startedAt: params.startedAt,
        finishedAt: null,
        errorSummary: null,
        providerMetadata: null,
      })
      .returning();

    return {
      operation: decodeExecutionOperationRow(operationRows[0]),
      attempt: decodeExecutionOperationAttemptRow(attemptRows[0]),
    };
  }

  async recordOutcome(
    executor: DatabaseExecutor,
    params: {
      readonly operationId: string;
      readonly attemptId: string;
      readonly expectedRowVersion: number;
      readonly outcome: OperationOutcome;
      readonly summary: string | null;
      readonly finishedAt: string;
    },
  ): Promise<{
    operation: PersistedExecutionOperation;
    attempt: PersistedExecutionOperationAttempt;
  }> {
    if (!isLegalExecutionOperationTransition("IN_FLIGHT", params.outcome)) {
      throw PersistenceError.stateConflict(
        `Illegal operation transition IN_FLIGHT -> ${params.outcome}.`,
      );
    }

    const operationRows = await executor
      .update(executionOperations)
      .set({
        status: params.outcome,
        uncertaintyReason:
          params.outcome === "UNKNOWN" ? params.summary : null,
        reconciliationStatus:
          params.outcome === "UNKNOWN" ? "REQUIRED" : "NOT_REQUIRED",
        reconciliationOutcome: null,
        rowVersion: params.expectedRowVersion + 1,
        updatedAt: params.finishedAt,
      })
      .where(
        and(
          eq(executionOperations.operationId, params.operationId),
          eq(executionOperations.status, "IN_FLIGHT"),
          eq(executionOperations.rowVersion, params.expectedRowVersion),
        ),
      )
      .returning();

    if (operationRows.length === 0) {
      throw PersistenceError.staleWrite(
        `Operation "${params.operationId}" could not record ${params.outcome} at row_version ${params.expectedRowVersion}.`,
      );
    }

    const attemptRows = await executor
      .update(executionOperationAttempts)
      .set({
        status: params.outcome,
        finishedAt: params.finishedAt,
        errorSummary:
          params.outcome === "FAILED" || params.outcome === "UNKNOWN"
            ? params.summary
            : null,
      })
      .where(
        and(
          eq(executionOperationAttempts.attemptId, params.attemptId),
          eq(executionOperationAttempts.operationId, params.operationId),
          eq(executionOperationAttempts.attemptNumber, 1),
          eq(executionOperationAttempts.status, "IN_FLIGHT"),
        ),
      )
      .returning();

    if (attemptRows.length === 0) {
      throw PersistenceError.staleWrite(
        `Active attempt "${params.attemptId}" could not record ${params.outcome}.`,
      );
    }

    return {
      operation: decodeExecutionOperationRow(operationRows[0]),
      attempt: decodeExecutionOperationAttemptRow(attemptRows[0]),
    };
  }
}

export const executionOperationRepository = new ExecutionOperationRepository();
