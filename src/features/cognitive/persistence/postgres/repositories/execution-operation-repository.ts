import { and, eq } from "drizzle-orm";

import type { PersistedExecutionOperation } from "../../contracts/execution-operation";
import { PersistenceError } from "../errors/persistence-errors";
import { executionOperations } from "../schema/execution";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { decodeExecutionOperationRow } from "../utils/row-mappers";

export class ExecutionOperationRepository {
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
        existing.requestFingerprint === operation.requestFingerprint &&
        existing.operationKind === operation.operationKind
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
}

export const executionOperationRepository = new ExecutionOperationRepository();
