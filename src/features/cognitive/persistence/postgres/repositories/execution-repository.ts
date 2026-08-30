import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { PersistedExecution } from "../../contracts/execution";
import { PersistenceError } from "../errors/persistence-errors";
import { executionEvents, executions } from "../schema/execution";
import { executionSafetyState } from "../schema/safety";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { decodeExecutionRow } from "../utils/row-mappers";

export interface StartExecutionParams {
  readonly executionId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly expectedRowVersion: number;
  readonly expectedSafetyGeneration: number;
  readonly startedAt: string;
  readonly commandIdempotencyKey: string;
  readonly reason: string;
  readonly executionEventId?: string;
}

export class ExecutionRepository {
  async findExecutionById(
    executor: DatabaseExecutor,
    executionId: string,
  ): Promise<PersistedExecution | null> {
    const rows = await executor
      .select()
      .from(executions)
      .where(eq(executions.executionId, executionId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeExecutionRow(rows[0]);
  }

  async createPendingExecution(
    executor: DatabaseExecutor,
    execution: PersistedExecution,
  ): Promise<PersistedExecution> {
    if (execution.status !== "PENDING") {
      throw PersistenceError.stateConflict(
        `Initial execution must have status PENDING, received "${execution.status}".`,
        { executionId: execution.executionId, status: execution.status },
      );
    }

    const insertedRows = await executor
      .insert(executions)
      .values({
        executionId: execution.executionId,
        sessionId: execution.sessionId,
        planId: execution.planId,
        status: "PENDING",
        currentStepId: execution.currentStepId ?? null,
        startedAt: null,
        completedAt: null,
        error: null,
        safetyGenerationAtStart: null,
        rowVersion: 0,
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
      })
      .returning();

    return decodeExecutionRow(insertedRows[0]);
  }

  async startExecution(
    executor: DatabaseExecutor,
    params: StartExecutionParams,
  ): Promise<PersistedExecution> {
    const currentSafety = await executor
      .select()
      .from(executionSafetyState)
      .where(
        and(
          eq(executionSafetyState.sessionId, params.sessionId),
          eq(executionSafetyState.generation, params.expectedSafetyGeneration),
          eq(executionSafetyState.durableStatus, "UNAUTHORIZED"),
        ),
      )
      .limit(1);

    if (currentSafety.length === 0) {
      throw PersistenceError.stateConflict(
        `Cannot start execution "${params.executionId}": Authoritative safety generation for session "${params.sessionId}" is not ${params.expectedSafetyGeneration} (UNAUTHORIZED).`,
        {
          executionId: params.executionId,
          sessionId: params.sessionId,
          expectedSafetyGeneration: params.expectedSafetyGeneration,
        },
      );
    }

    const updatedRows = await executor
      .update(executions)
      .set({
        status: "RUNNING",
        startedAt: params.startedAt,
        safetyGenerationAtStart: params.expectedSafetyGeneration,
        rowVersion: params.expectedRowVersion + 1,
        updatedAt: params.startedAt,
      })
      .where(
        and(
          eq(executions.executionId, params.executionId),
          eq(executions.sessionId, params.sessionId),
          eq(executions.status, "PENDING"),
          eq(executions.rowVersion, params.expectedRowVersion),
        ),
      )
      .returning();

    if (updatedRows.length === 0) {
      throw PersistenceError.staleWrite(
        `Execution "${params.executionId}" could not be transitioned to RUNNING at expected row_version ${params.expectedRowVersion}.`,
        {
          executionId: params.executionId,
          expectedRowVersion: params.expectedRowVersion,
        },
      );
    }

    const eventId = params.executionEventId ?? randomUUID();

    await executor.insert(executionEvents).values({
      executionEventId: eventId,
      executionId: params.executionId,
      transitionSequence: params.expectedRowVersion + 1,
      fromStatus: "PENDING",
      toStatus: "RUNNING",
      stepId: null,
      safetyGeneration: params.expectedSafetyGeneration,
      operationId: null,
      eventKey: params.commandIdempotencyKey,
      reason: params.reason,
      occurredAt: params.startedAt,
    });

    return decodeExecutionRow(updatedRows[0]);
  }
}

export const executionRepository = new ExecutionRepository();
