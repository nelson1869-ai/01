import type { ExecutionSafetyState } from "../domain/execution-safety";
import {
  type ReserveExecutionOperationCommand,
  reserveExecutionOperationCommandSchema,
  type StartExecutionCommand,
  startExecutionCommandSchema,
  type StartExecutionStepCommand,
  startExecutionStepCommandSchema,
} from "../persistence/contracts/execution-lifecycle-commands";
import {
  type BeginOperationAttemptCommand,
  beginOperationAttemptCommandSchema,
} from "../persistence/contracts/execution-operation-commands";
import type { PersistedExecution } from "../persistence/contracts/execution";
import type { PersistedExecutionOperation } from "../persistence/contracts/execution-operation";
import type { PersistedExecutionOperationAttempt } from "../persistence/contracts/execution-operation-attempt";
import type { PersistedExecutionStepState } from "../persistence/contracts/execution-step-state";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { executionOperationRepository } from "../persistence/postgres/repositories/execution-operation-repository";
import { executionRepository } from "../persistence/postgres/repositories/execution-repository";
import { executionStepRepository } from "../persistence/postgres/repositories/execution-step-repository";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import {
  type DatabaseClient,
  type DatabaseExecutor,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";
import {
  assertLiveExecutionAuthorization,
  loadAndValidateAuthorizedExecutionContext,
  lockAndValidateExecutionAuthorization,
} from "./execution-authorization-guard";

function parseCommand<T>(
  result: { success: true; data: T } | { success: false; error: { issues: unknown } },
  name: string,
): T {
  if (!result.success) {
    throw PersistenceError.invalidPersistedState(`Invalid ${name} command.`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

async function claimLifecycleCommand(
  executor: DatabaseExecutor,
  params: {
    readonly scope: string;
    readonly key: string;
    readonly command: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
  },
) {
  return await idempotencyRepository.claimCommand(executor, {
    scope: params.scope,
    idempotencyKey: params.key,
    requestHash: createCanonicalFingerprint(params.command),
    createdAt: params.occurredAt,
    updatedAt: params.occurredAt,
  });
}

async function completeLifecycleCommand(
  executor: DatabaseExecutor,
  params: {
    readonly scope: string;
    readonly key: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly occurredAt: string;
  },
): Promise<void> {
  await idempotencyRepository.completeCommand(executor, {
    scope: params.scope,
    idempotencyKey: params.key,
    resultResourceType: params.resourceType,
    resultResourceId: params.resourceId,
    updatedAt: params.occurredAt,
  });
}

export async function findReadyExecutionSteps(
  executor: DatabaseExecutor,
  params: { readonly executionId: string; readonly planId: string },
): Promise<readonly PersistedExecutionStepState[]> {
  return await executionStepRepository.findReadySteps(
    executor,
    params.executionId,
    params.planId,
  );
}

export async function startAuthorizedExecution(
  db: DatabaseClient,
  authorization: ExecutionSafetyState,
  rawCommand: StartExecutionCommand,
): Promise<{ readonly isReplay: boolean; readonly execution: PersistedExecution }> {
  const command = parseCommand(
    startExecutionCommandSchema.safeParse(rawCommand),
    "start execution",
  );
  assertLiveExecutionAuthorization(
    authorization,
    command.expectedSafetyGeneration,
  );

  return await runInTransaction(db, async (tx) => {
    const claim = await claimLifecycleCommand(tx, {
      scope: "start-execution",
      key: command.commandIdempotencyKey,
      command,
      occurredAt: command.startedAt,
    });
    await lockAndValidateExecutionAuthorization(tx, authorization, {
      sessionId: command.sessionId,
      expectedGeneration: command.expectedSafetyGeneration,
    });
    const context = await loadAndValidateAuthorizedExecutionContext(
      tx,
      authorization,
      command,
    );

    if (claim.isReplay) {
      if (claim.record.status !== "COMPLETED") {
        throw PersistenceError.stateConflict("Start-execution replay is incomplete.");
      }
      return { isReplay: true, execution: context.execution };
    }

    if (
      context.execution.status !== "PENDING" ||
      context.execution.rowVersion !== command.expectedExecutionRowVersion
    ) {
      throw PersistenceError.staleWrite(
        "Execution is not the expected PENDING row for authorized start.",
      );
    }

    const execution = await executionRepository.startExecution(tx, {
      executionId: command.executionId,
      sessionId: command.sessionId,
      planId: command.planId,
      expectedRowVersion: command.expectedExecutionRowVersion,
      expectedSafetyGeneration: command.expectedSafetyGeneration,
      startedAt: command.startedAt,
      commandIdempotencyKey: command.eventKey,
      reason: command.reason,
      executionEventId: command.executionEventId,
    });

    await completeLifecycleCommand(tx, {
      scope: "start-execution",
      key: command.commandIdempotencyKey,
      resourceType: "execution",
      resourceId: command.executionId,
      occurredAt: command.startedAt,
    });
    return { isReplay: false, execution };
  });
}

export async function startAuthorizedExecutionStep(
  db: DatabaseClient,
  authorization: ExecutionSafetyState,
  rawCommand: StartExecutionStepCommand,
): Promise<{
  readonly isReplay: boolean;
  readonly execution: PersistedExecution;
  readonly step: PersistedExecutionStepState;
}> {
  const command = parseCommand(
    startExecutionStepCommandSchema.safeParse(rawCommand),
    "start execution step",
  );
  assertLiveExecutionAuthorization(
    authorization,
    command.expectedSafetyGeneration,
  );

  return await runInTransaction(db, async (tx) => {
    const claim = await claimLifecycleCommand(tx, {
      scope: "start-step",
      key: command.commandIdempotencyKey,
      command,
      occurredAt: command.startedAt,
    });
    await lockAndValidateExecutionAuthorization(tx, authorization, {
      sessionId: command.sessionId,
      expectedGeneration: command.expectedSafetyGeneration,
    });
    const context = await loadAndValidateAuthorizedExecutionContext(
      tx,
      authorization,
      command,
    );
    const currentStep = await executionStepRepository.findStep(
      tx,
      command.executionId,
      command.stepId,
    );

    if (!currentStep || currentStep.planId !== command.planId) {
      throw PersistenceError.notFound(
        `Execution step "${command.stepId}" was not found in the authorized plan.`,
      );
    }

    if (claim.isReplay) {
      if (claim.record.status !== "COMPLETED") {
        throw PersistenceError.stateConflict("Start-step replay is incomplete.");
      }
      return {
        isReplay: true,
        execution: context.execution,
        step: currentStep,
      };
    }

    if (
      context.execution.status !== "RUNNING" ||
      context.execution.rowVersion !== command.expectedExecutionRowVersion ||
      currentStep.status !== "PENDING" ||
      currentStep.rowVersion !== command.expectedStepRowVersion
    ) {
      throw PersistenceError.staleWrite(
        "Execution or step is not at the expected version for step start.",
      );
    }

    const readySteps = await findReadyExecutionSteps(tx, command);
    if (!readySteps.some((step) => step.stepId === command.stepId)) {
      throw PersistenceError.stateConflict(
        `Execution step "${command.stepId}" has unsatisfied dependencies.`,
      );
    }

    const step = await executionStepRepository.transitionStep(tx, {
      executionId: command.executionId,
      stepId: command.stepId,
      expectedRowVersion: command.expectedStepRowVersion,
      fromStatus: "PENDING",
      toStatus: "RUNNING",
      startedAt: command.startedAt,
      completedAt: null,
      error: null,
      updatedAt: command.startedAt,
    });
    const execution = await executionRepository.appendStepTransitionEvent(tx, {
      executionId: command.executionId,
      expectedExecutionRowVersion: command.expectedExecutionRowVersion,
      stepId: command.stepId,
      fromStatus: "PENDING",
      toStatus: "RUNNING",
      safetyGeneration: authorization.generation,
      executionEventId: command.executionEventId,
      eventKey: command.eventKey,
      reason: command.reason,
      occurredAt: command.startedAt,
    });

    await completeLifecycleCommand(tx, {
      scope: "start-step",
      key: command.commandIdempotencyKey,
      resourceType: "execution_step_state",
      resourceId: command.stepId,
      occurredAt: command.startedAt,
    });
    return { isReplay: false, execution, step };
  });
}

export async function reserveAuthorizedExecutionOperation(
  db: DatabaseClient,
  authorization: ExecutionSafetyState,
  rawCommand: ReserveExecutionOperationCommand,
): Promise<{ readonly isReplay: boolean; readonly operation: PersistedExecutionOperation }> {
  const command = parseCommand(
    reserveExecutionOperationCommandSchema.safeParse(rawCommand),
    "reserve execution operation",
  );
  assertLiveExecutionAuthorization(
    authorization,
    command.expectedSafetyGeneration,
  );

  return await runInTransaction(db, async (tx) => {
    await lockAndValidateExecutionAuthorization(tx, authorization, {
      sessionId: command.sessionId,
      expectedGeneration: command.expectedSafetyGeneration,
    });
    const context = await loadAndValidateAuthorizedExecutionContext(
      tx,
      authorization,
      command,
    );
    const step = await executionStepRepository.findStep(
      tx,
      command.executionId,
      command.stepId,
    );

    if (
      context.execution.status !== "RUNNING" ||
      !step ||
      step.planId !== command.planId ||
      step.status !== "RUNNING" ||
      step.rowVersion !== command.expectedStepRowVersion ||
      step.operationGeneration !== command.operationGeneration
    ) {
      throw PersistenceError.stateConflict(
        "Operation reservation is not bound to the current RUNNING step generation.",
      );
    }

    return await executionOperationRepository.reserveExecutionOperation(tx, {
      operationId: command.operationId,
      executionId: command.executionId,
      stepId: command.stepId,
      operationGeneration: command.operationGeneration,
      operationKind: command.operationKind,
      idempotencyKey: command.commandIdempotencyKey,
      requestFingerprint: command.requestFingerprint,
      status: "PENDING",
      attemptCount: 0,
      providerScope: command.providerScope,
      providerIdempotencyKey: command.providerIdempotencyKey,
      providerOperationId: null,
      uncertaintyReason: null,
      reconciliationStatus: "NOT_REQUIRED",
      reconciliationOutcome: null,
      rowVersion: 0,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    });
  });
}

export async function beginAuthorizedOperationAttempt(
  db: DatabaseClient,
  authorization: ExecutionSafetyState,
  rawCommand: BeginOperationAttemptCommand,
): Promise<{
  readonly isReplay: boolean;
  readonly operation: PersistedExecutionOperation;
  readonly attempt: PersistedExecutionOperationAttempt;
}> {
  const command = parseCommand(
    beginOperationAttemptCommandSchema.safeParse(rawCommand),
    "begin operation attempt",
  );
  assertLiveExecutionAuthorization(
    authorization,
    command.expectedSafetyGeneration,
  );

  return await runInTransaction(db, async (tx) => {
    const claim = await claimLifecycleCommand(tx, {
      scope: "begin-operation-attempt",
      key: command.commandIdempotencyKey,
      command,
      occurredAt: command.startedAt,
    });
    await lockAndValidateExecutionAuthorization(tx, authorization, {
      sessionId: command.sessionId,
      expectedGeneration: command.expectedSafetyGeneration,
    });
    const context = await loadAndValidateAuthorizedExecutionContext(
      tx,
      authorization,
      command,
    );
    const step = await executionStepRepository.findStep(
      tx,
      command.executionId,
      command.stepId,
    );
    const operation = await executionOperationRepository.findOperationById(
      tx,
      command.operationId,
    );

    if (!step || !operation) {
      throw PersistenceError.notFound(
        "Execution step or reserved operation was not found.",
      );
    }

    if (claim.isReplay) {
      const attempt = await executionOperationRepository.findAttemptById(
        tx,
        command.attemptId,
      );
      if (claim.record.status !== "COMPLETED" || !attempt) {
        throw PersistenceError.invalidPersistedState(
          "Completed begin-attempt replay is missing its attempt.",
        );
      }
      return { isReplay: true, operation, attempt };
    }

    if (
      context.execution.status !== "RUNNING" ||
      step.status !== "RUNNING" ||
      step.planId !== command.planId ||
      operation.executionId !== command.executionId ||
      operation.stepId !== command.stepId ||
      operation.operationGeneration !== step.operationGeneration ||
      operation.status !== "PENDING" ||
      operation.rowVersion !== command.expectedOperationRowVersion
    ) {
      throw PersistenceError.stateConflict(
        "Operation attempt cannot begin from the current execution/step/operation state.",
      );
    }

    const result = await executionOperationRepository.beginAttempt(tx, {
      operationId: command.operationId,
      expectedRowVersion: command.expectedOperationRowVersion,
      attemptId: command.attemptId,
      workerId: command.workerId,
      startedAt: command.startedAt,
    });
    await completeLifecycleCommand(tx, {
      scope: "begin-operation-attempt",
      key: command.commandIdempotencyKey,
      resourceType: "execution_operation_attempt",
      resourceId: command.attemptId,
      occurredAt: command.startedAt,
    });
    return { isReplay: false, ...result };
  });
}
