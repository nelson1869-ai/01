import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  isLegalExecutionTransition,
  nextExecutionTransitionSequence,
} from "../../../domain/execution-lifecycle";
import type { PersistedExecution } from "../../contracts/execution";
import { PersistenceError } from "../errors/persistence-errors";
import { executionEvents, executions } from "../schema/execution";
import { executionSafetyState } from "../schema/safety";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
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

export interface AppendStepTransitionEventParams {
  readonly executionId: string;
  readonly expectedExecutionRowVersion: number;
  readonly stepId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly safetyGeneration: number | null;
  readonly operationId?: string | null;
  readonly executionEventId: string;
  readonly eventKey: string;
  readonly reason: string;
  readonly occurredAt: string;
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

  async findLatestExecutionBySessionId(
    executor: DatabaseExecutor,
    sessionId: string,
  ): Promise<PersistedExecution | null> {
    const rows = await executor
      .select()
      .from(executions)
      .where(eq(executions.sessionId, sessionId))
      .orderBy(desc(executions.createdAt))
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
    // Persistence primitive only: expected generation is concurrency evidence,
    // not permission. Autonomous callers must use startAuthorizedExecution,
    // which validates the live private-branded capability before reaching here.
    return await runInTransaction(executor, async (tx) => {
      if (!isLegalExecutionTransition("PENDING", "RUNNING")) {
        throw PersistenceError.invalidPersistedState(
          "Execution transition table rejected PENDING -> RUNNING.",
        );
      }

      const currentSafety = await tx
        .select()
        .from(executionSafetyState)
        .where(
          and(
            eq(executionSafetyState.sessionId, params.sessionId),
            eq(
              executionSafetyState.generation,
              params.expectedSafetyGeneration,
            ),
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

      const updatedRows = await tx
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

      await tx.insert(executionEvents).values({
        executionEventId: eventId,
        executionId: params.executionId,
        transitionSequence: nextExecutionTransitionSequence(
          params.expectedRowVersion,
        ),
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
    });
  }

  async appendStepTransitionEvent(
    executor: DatabaseExecutor,
    params: AppendStepTransitionEventParams,
  ): Promise<PersistedExecution> {
    return await runInTransaction(executor, async (tx) => {
      const nextSequence = nextExecutionTransitionSequence(
        params.expectedExecutionRowVersion,
      );

      const executionRows = await tx
        .update(executions)
        .set({
          rowVersion: nextSequence,
          updatedAt: params.occurredAt,
        })
        .where(
          and(
            eq(executions.executionId, params.executionId),
            eq(executions.status, "RUNNING"),
            eq(executions.rowVersion, params.expectedExecutionRowVersion),
          ),
        )
        .returning();

      if (executionRows.length === 0) {
        throw PersistenceError.staleWrite(
          `Execution "${params.executionId}" could not reserve event sequence ${nextSequence}.`,
        );
      }

      await tx.insert(executionEvents).values({
        executionEventId: params.executionEventId,
        executionId: params.executionId,
        transitionSequence: nextSequence,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        stepId: params.stepId,
        safetyGeneration: params.safetyGeneration,
        operationId: params.operationId ?? null,
        eventKey: params.eventKey,
        reason: params.reason,
        occurredAt: params.occurredAt,
      });

      return decodeExecutionRow(executionRows[0]);
    });
  }

  async finalizeExecution(
    executor: DatabaseExecutor,
    params: {
      readonly executionId: string;
      readonly expectedRowVersion: number;
      readonly toStatus: "SUCCEEDED" | "FAILED";
      readonly completedAt: string;
      readonly error: string | null;
      readonly executionEventId: string;
      readonly eventKey: string;
      readonly reason: string;
    },
  ): Promise<PersistedExecution> {
    if (!isLegalExecutionTransition("RUNNING", params.toStatus)) {
      throw PersistenceError.stateConflict(
        `Illegal execution transition RUNNING -> ${params.toStatus}.`,
      );
    }

    return await runInTransaction(executor, async (tx) => {
      const nextSequence = nextExecutionTransitionSequence(
        params.expectedRowVersion,
      );
      const executionRows = await tx
        .update(executions)
        .set({
          status: params.toStatus,
          completedAt: params.completedAt,
          error: params.error,
          rowVersion: nextSequence,
          updatedAt: params.completedAt,
        })
        .where(
          and(
            eq(executions.executionId, params.executionId),
            eq(executions.status, "RUNNING"),
            eq(executions.rowVersion, params.expectedRowVersion),
          ),
        )
        .returning();

      if (executionRows.length === 0) {
        throw PersistenceError.staleWrite(
          `Execution "${params.executionId}" could not finalize at row_version ${params.expectedRowVersion}.`,
        );
      }

      await tx.insert(executionEvents).values({
        executionEventId: params.executionEventId,
        executionId: params.executionId,
        transitionSequence: nextSequence,
        fromStatus: "RUNNING",
        toStatus: params.toStatus,
        stepId: null,
        safetyGeneration: null,
        operationId: null,
        eventKey: params.eventKey,
        reason: params.reason,
        occurredAt: params.completedAt,
      });

      return decodeExecutionRow(executionRows[0]);
    });
  }
}

export const executionRepository = new ExecutionRepository();
