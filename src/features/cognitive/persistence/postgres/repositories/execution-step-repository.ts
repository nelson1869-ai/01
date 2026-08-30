import { and, asc, eq } from "drizzle-orm";

import {
  isLegalExecutionStepTransition,
  selectReadyExecutionSteps,
} from "../../../domain/execution-lifecycle";
import type { ExecutionStatus } from "../../../domain/execution";
import type { PersistedActionPlanStep } from "../../contracts/persisted-action-plan";
import type { PersistedExecutionStepState } from "../../contracts/execution-step-state";
import { PersistenceError } from "../errors/persistence-errors";
import {
  executionStepState,
} from "../schema/execution";
import {
  actionPlanStepDependencies,
  actionPlanSteps,
} from "../schema/planning";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { decodeExecutionStepStateRow } from "../utils/row-mappers";

export interface TransitionExecutionStepParams {
  readonly executionId: string;
  readonly stepId: string;
  readonly expectedRowVersion: number;
  readonly fromStatus: ExecutionStatus;
  readonly toStatus: ExecutionStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
  readonly updatedAt: string;
}

export class ExecutionStepRepository {
  async createPendingSteps(
    executor: DatabaseExecutor,
    params: {
      readonly executionId: string;
      readonly planId: string;
      readonly steps: readonly PersistedActionPlanStep[];
      readonly updatedAt: string;
    },
  ): Promise<readonly PersistedExecutionStepState[]> {
    if (params.steps.length === 0) {
      throw PersistenceError.stateConflict(
        `Execution "${params.executionId}" requires at least one plan step.`,
      );
    }

    const inserted = await executor
      .insert(executionStepState)
      .values(
        params.steps.map((step) => ({
          executionId: params.executionId,
          planId: params.planId,
          stepId: step.stepId,
          status: "PENDING",
          operationGeneration: 1,
          rowVersion: 0,
          startedAt: null,
          completedAt: null,
          error: null,
          updatedAt: params.updatedAt,
        })),
      )
      .returning();

    return inserted.map(decodeExecutionStepStateRow);
  }

  async findStep(
    executor: DatabaseExecutor,
    executionId: string,
    stepId: string,
  ): Promise<PersistedExecutionStepState | null> {
    const rows = await executor
      .select()
      .from(executionStepState)
      .where(
        and(
          eq(executionStepState.executionId, executionId),
          eq(executionStepState.stepId, stepId),
        ),
      )
      .limit(1);

    return rows.length === 0 ? null : decodeExecutionStepStateRow(rows[0]);
  }

  async listSteps(
    executor: DatabaseExecutor,
    executionId: string,
  ): Promise<readonly PersistedExecutionStepState[]> {
    const rows = await executor
      .select()
      .from(executionStepState)
      .where(eq(executionStepState.executionId, executionId))
      .orderBy(asc(executionStepState.stepId));

    return rows.map(decodeExecutionStepStateRow);
  }

  async findReadySteps(
    executor: DatabaseExecutor,
    executionId: string,
    planId: string,
  ): Promise<readonly PersistedExecutionStepState[]> {
    const stateRows = await executor
      .select({
        state: executionStepState,
        ordinal: actionPlanSteps.ordinal,
      })
      .from(executionStepState)
      .innerJoin(
        actionPlanSteps,
        and(
          eq(actionPlanSteps.planId, executionStepState.planId),
          eq(actionPlanSteps.stepId, executionStepState.stepId),
        ),
      )
      .where(
        and(
          eq(executionStepState.executionId, executionId),
          eq(executionStepState.planId, planId),
        ),
      );

    const dependencyRows = await executor
      .select({
        stepId: actionPlanStepDependencies.stepId,
        dependsOnStepId: actionPlanStepDependencies.dependsOnStepId,
      })
      .from(actionPlanStepDependencies)
      .where(eq(actionPlanStepDependencies.planId, planId));

    const decodedStateRows = stateRows.map((row) => ({
      state: decodeExecutionStepStateRow(row.state),
      ordinal: row.ordinal,
    }));

    const readyIds = new Set(
      selectReadyExecutionSteps(
        decodedStateRows.map((row) => ({
          stepId: row.state.stepId,
          ordinal: row.ordinal,
          status: row.state.status,
        })),
        dependencyRows,
      ).map((step) => step.stepId),
    );

    return decodedStateRows
      .filter((row) => readyIds.has(row.state.stepId))
      .sort(
        (left, right) =>
          left.ordinal - right.ordinal ||
          left.state.stepId.localeCompare(right.state.stepId),
      )
      .map((row) => row.state);
  }

  async transitionStep(
    executor: DatabaseExecutor,
    params: TransitionExecutionStepParams,
  ): Promise<PersistedExecutionStepState> {
    if (!isLegalExecutionStepTransition(params.fromStatus, params.toStatus)) {
      throw PersistenceError.stateConflict(
        `Illegal execution-step transition ${params.fromStatus} -> ${params.toStatus}.`,
      );
    }

    const rows = await executor
      .update(executionStepState)
      .set({
        status: params.toStatus,
        startedAt: params.startedAt,
        completedAt: params.completedAt,
        error: params.error,
        rowVersion: params.expectedRowVersion + 1,
        updatedAt: params.updatedAt,
      })
      .where(
        and(
          eq(executionStepState.executionId, params.executionId),
          eq(executionStepState.stepId, params.stepId),
          eq(executionStepState.status, params.fromStatus),
          eq(executionStepState.rowVersion, params.expectedRowVersion),
        ),
      )
      .returning();

    if (rows.length === 0) {
      throw PersistenceError.staleWrite(
        `Execution step "${params.stepId}" could not transition from ${params.fromStatus} at row_version ${params.expectedRowVersion}.`,
        {
          executionId: params.executionId,
          stepId: params.stepId,
          expectedRowVersion: params.expectedRowVersion,
        },
      );
    }

    return decodeExecutionStepStateRow(rows[0]);
  }
}

export const executionStepRepository = new ExecutionStepRepository();
