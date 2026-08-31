import {
  type CompleteExecutionStepCommand,
  completeExecutionStepCommandSchema,
  type FailExecutionStepCommand,
  failExecutionStepCommandSchema,
  type FinalizeExecutionFailureCommand,
  finalizeExecutionFailureCommandSchema,
  type FinalizeExecutionSuccessCommand,
  finalizeExecutionSuccessCommandSchema,
} from "../persistence/contracts/execution-completion-commands";
import {
  type RecordOperationFailedCommand,
  recordOperationFailedCommandSchema,
  type RecordOperationSucceededCommand,
  recordOperationSucceededCommandSchema,
  type RecordOperationUnknownCommand,
  recordOperationUnknownCommandSchema,
} from "../persistence/contracts/execution-operation-commands";
import type { PersistedExecution } from "../persistence/contracts/execution";
import type { PersistedExecutionOperation } from "../persistence/contracts/execution-operation";
import type { PersistedExecutionOperationAttempt } from "../persistence/contracts/execution-operation-attempt";
import type { PersistedExecutionStepState } from "../persistence/contracts/execution-step-state";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import {
  executionOperationRepository,
  type OperationOutcome,
} from "../persistence/postgres/repositories/execution-operation-repository";
import { executionRepository } from "../persistence/postgres/repositories/execution-repository";
import { executionStepRepository } from "../persistence/postgres/repositories/execution-step-repository";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import {
  type DatabaseClient,
  type DatabaseExecutor,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";

function invalidCommand(name: string, issues: unknown): never {
  throw PersistenceError.invalidPersistedState(`Invalid ${name} command.`, {
    issues,
  });
}

async function claimCommand(
  executor: DatabaseExecutor,
  scope: string,
  key: string,
  command: unknown,
  occurredAt: string,
) {
  return await idempotencyRepository.claimCommand(executor, {
    scope,
    idempotencyKey: key,
    requestHash: createCanonicalFingerprint(command),
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

async function completeCommand(
  executor: DatabaseExecutor,
  scope: string,
  key: string,
  resourceType: string,
  resourceId: string,
  occurredAt: string,
): Promise<void> {
  await idempotencyRepository.completeCommand(executor, {
    scope,
    idempotencyKey: key,
    resultResourceType: resourceType,
    resultResourceId: resourceId,
    updatedAt: occurredAt,
  });
}

type OperationOutcomeCommand =
  | RecordOperationSucceededCommand
  | RecordOperationFailedCommand
  | RecordOperationUnknownCommand;

async function persistOperationOutcome(
  db: DatabaseClient,
  command: OperationOutcomeCommand,
  outcome: OperationOutcome,
  summary: string | null,
): Promise<{
  readonly isReplay: boolean;
  readonly operation: PersistedExecutionOperation;
  readonly attempt: PersistedExecutionOperationAttempt;
}> {
  return await runInTransaction(db, async (tx) => {
    const claim = await claimCommand(
      tx,
      "record-operation-outcome",
      command.commandIdempotencyKey,
      {
        commandIdempotencyKey: command.commandIdempotencyKey,
        operationId: command.operationId,
        attemptId: command.attemptId,
        expectedOperationRowVersion: command.expectedOperationRowVersion,
        outcome: command.outcome,
        finishedAt: command.finishedAt,
        providerOperationId: command.providerOperationId ?? null,
        resultMetadata: command.resultMetadata ?? null,
        summary: summary ?? null,
      },
      command.finishedAt,
    );

    if (claim.isReplay) {
      const operation = await executionOperationRepository.findOperationById(
        tx,
        command.operationId,
      );
      const attempt = await executionOperationRepository.findAttemptById(
        tx,
        command.attemptId,
      );
      if (claim.record.status !== "COMPLETED" || !operation || !attempt) {
        throw PersistenceError.invalidPersistedState(
          "Completed operation-outcome replay is missing durable state.",
        );
      }
      return { isReplay: true, operation, attempt };
    }

    const result = await executionOperationRepository.recordOutcome(tx, {
      operationId: command.operationId,
      attemptId: command.attemptId,
      expectedRowVersion: command.expectedOperationRowVersion,
      outcome,
      summary,
      providerOperationId: command.providerOperationId,
      resultMetadata: command.resultMetadata,
      finishedAt: command.finishedAt,
    });
    await completeCommand(
      tx,
      "record-operation-outcome",
      command.commandIdempotencyKey,
      "execution_operation",
      command.operationId,
      command.finishedAt,
    );
    return { isReplay: false, ...result };
  });
}

export async function recordOperationSucceeded(
  db: DatabaseClient,
  rawCommand: RecordOperationSucceededCommand,
) {
  const parsed = recordOperationSucceededCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return invalidCommand("record operation succeeded", parsed.error.issues);
  }
  return await persistOperationOutcome(db, parsed.data, "SUCCEEDED", null);
}

export async function recordOperationFailed(
  db: DatabaseClient,
  rawCommand: RecordOperationFailedCommand,
) {
  const parsed = recordOperationFailedCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return invalidCommand("record operation failed", parsed.error.issues);
  }
  return await persistOperationOutcome(
    db,
    parsed.data,
    "FAILED",
    parsed.data.errorSummary,
  );
}

export async function recordOperationUnknown(
  db: DatabaseClient,
  rawCommand: RecordOperationUnknownCommand,
) {
  const parsed = recordOperationUnknownCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return invalidCommand("record operation unknown", parsed.error.issues);
  }
  return await persistOperationOutcome(
    db,
    parsed.data,
    "UNKNOWN",
    parsed.data.uncertaintyReason,
  );
}

type StepOutcomeResult = Readonly<{
  isReplay: boolean;
  execution: PersistedExecution;
  step: PersistedExecutionStepState;
  operation: PersistedExecutionOperation;
}>;

async function persistStepOutcome(
  db: DatabaseClient,
  params: {
    readonly command: CompleteExecutionStepCommand | FailExecutionStepCommand;
    readonly outcome: "SUCCEEDED" | "FAILED";
    readonly summary: string;
  },
): Promise<StepOutcomeResult> {
  const { command } = params;
  return await runInTransaction(db, async (tx) => {
    const scope = params.outcome === "SUCCEEDED" ? "complete-step" : "fail-step";
    const claim = await claimCommand(
      tx,
      scope,
      command.commandIdempotencyKey,
      command,
      command.completedAt,
    );
    const execution = await executionRepository.findExecutionById(
      tx,
      command.executionId,
    );
    const step = await executionStepRepository.findStep(
      tx,
      command.executionId,
      command.stepId,
    );
    const operation =
      await executionOperationRepository.findOperationByLogicalIdentity(
        tx,
        command.executionId,
        command.stepId,
        command.operationGeneration,
      );

    if (!execution || !step || !operation) {
      throw PersistenceError.notFound(
        "Execution, step, or required current-generation operation was not found.",
      );
    }

    if (claim.isReplay) {
      if (claim.record.status !== "COMPLETED") {
        throw PersistenceError.stateConflict("Step-outcome replay is incomplete.");
      }
      return { isReplay: true, execution, step, operation };
    }

    if (
      execution.status !== "RUNNING" ||
      execution.planId !== command.planId ||
      execution.rowVersion !== command.expectedExecutionRowVersion ||
      step.planId !== command.planId ||
      step.status !== "RUNNING" ||
      step.rowVersion !== command.expectedStepRowVersion ||
      step.operationGeneration !== command.operationGeneration ||
      operation.status !== params.outcome
    ) {
      throw PersistenceError.stateConflict(
        `Step cannot become ${params.outcome} from the current durable operation state.`,
      );
    }

    const updatedStep = await executionStepRepository.transitionStep(tx, {
      executionId: command.executionId,
      stepId: command.stepId,
      expectedRowVersion: command.expectedStepRowVersion,
      fromStatus: "RUNNING",
      toStatus: params.outcome,
      startedAt: step.startedAt,
      completedAt: command.completedAt,
      error: params.outcome === "FAILED" ? params.summary : null,
      updatedAt: command.completedAt,
    });
    const updatedExecution = await executionRepository.appendStepTransitionEvent(
      tx,
      {
        executionId: command.executionId,
        expectedExecutionRowVersion: command.expectedExecutionRowVersion,
        stepId: command.stepId,
        fromStatus: "RUNNING",
        toStatus: params.outcome,
        safetyGeneration: null,
        operationId: operation.operationId,
        executionEventId: command.executionEventId,
        eventKey: command.eventKey,
        reason: params.summary,
        occurredAt: command.completedAt,
      },
    );
    await completeCommand(
      tx,
      scope,
      command.commandIdempotencyKey,
      "execution_step_state",
      command.stepId,
      command.completedAt,
    );
    return {
      isReplay: false,
      execution: updatedExecution,
      step: updatedStep,
      operation,
    };
  });
}

export async function completeExecutionStep(
  db: DatabaseClient,
  rawCommand: CompleteExecutionStepCommand,
): Promise<StepOutcomeResult> {
  const parsed = completeExecutionStepCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return invalidCommand("complete execution step", parsed.error.issues);
  }
  return await persistStepOutcome(db, {
    command: parsed.data,
    outcome: "SUCCEEDED",
    summary: parsed.data.reason,
  });
}

export async function failExecutionStep(
  db: DatabaseClient,
  rawCommand: FailExecutionStepCommand,
): Promise<StepOutcomeResult> {
  const parsed = failExecutionStepCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return invalidCommand("fail execution step", parsed.error.issues);
  }
  return await persistStepOutcome(db, {
    command: parsed.data,
    outcome: "FAILED",
    summary: parsed.data.errorSummary,
  });
}

async function finalizeExecution(
  db: DatabaseClient,
  params: {
    readonly command:
      | FinalizeExecutionSuccessCommand
      | FinalizeExecutionFailureCommand;
    readonly outcome: "SUCCEEDED" | "FAILED";
    readonly summary: string;
  },
): Promise<{ readonly isReplay: boolean; readonly execution: PersistedExecution }> {
  const { command } = params;
  return await runInTransaction(db, async (tx) => {
    const scope =
      params.outcome === "SUCCEEDED"
        ? "finalize-execution-success"
        : "finalize-execution-failure";
    const claim = await claimCommand(
      tx,
      scope,
      command.commandIdempotencyKey,
      command,
      command.completedAt,
    );
    const execution = await executionRepository.findExecutionById(
      tx,
      command.executionId,
    );
    if (!execution) {
      throw PersistenceError.notFound(
        `Execution "${command.executionId}" was not found.`,
      );
    }

    if (claim.isReplay) {
      if (claim.record.status !== "COMPLETED") {
        throw PersistenceError.stateConflict(
          "Execution-finalization replay is incomplete.",
        );
      }
      return { isReplay: true, execution };
    }

    const steps = await executionStepRepository.listSteps(tx, command.executionId);
    const readyToFinalize =
      params.outcome === "SUCCEEDED"
        ? steps.length > 0 && steps.every((step) => step.status === "SUCCEEDED")
        : steps.some((step) => step.status === "FAILED");

    if (
      execution.status !== "RUNNING" ||
      execution.rowVersion !== command.expectedExecutionRowVersion ||
      !readyToFinalize
    ) {
      throw PersistenceError.stateConflict(
        `Execution is not ready to finalize as ${params.outcome}.`,
      );
    }

    const updated = await executionRepository.finalizeExecution(tx, {
      executionId: command.executionId,
      expectedRowVersion: command.expectedExecutionRowVersion,
      toStatus: params.outcome,
      completedAt: command.completedAt,
      error: params.outcome === "FAILED" ? params.summary : null,
      executionEventId: command.executionEventId,
      eventKey: command.eventKey,
      reason: params.summary,
    });
    await completeCommand(
      tx,
      scope,
      command.commandIdempotencyKey,
      "execution",
      command.executionId,
      command.completedAt,
    );
    return { isReplay: false, execution: updated };
  });
}

export async function finalizeExecutionIfComplete(
  db: DatabaseClient,
  rawCommand: FinalizeExecutionSuccessCommand,
) {
  const parsed = finalizeExecutionSuccessCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return invalidCommand("finalize execution success", parsed.error.issues);
  }
  return await finalizeExecution(db, {
    command: parsed.data,
    outcome: "SUCCEEDED",
    summary: parsed.data.reason,
  });
}

export async function finalizeExecutionFailure(
  db: DatabaseClient,
  rawCommand: FinalizeExecutionFailureCommand,
) {
  const parsed = finalizeExecutionFailureCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    return invalidCommand("finalize execution failure", parsed.error.issues);
  }
  return await finalizeExecution(db, {
    command: parsed.data,
    outcome: "FAILED",
    summary: parsed.data.errorSummary,
  });
}
