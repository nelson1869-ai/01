import type { ExecutionSafetyState } from "../domain/execution-safety";
import {
  type PrepareExecutionCommand,
  prepareExecutionCommandSchema,
} from "../persistence/contracts/prepare-execution-command";
import type { PersistedExecution } from "../persistence/contracts/execution";
import type { PersistedExecutionStepState } from "../persistence/contracts/execution-step-state";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { executionRepository } from "../persistence/postgres/repositories/execution-repository";
import { executionStepRepository } from "../persistence/postgres/repositories/execution-step-repository";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import { planRepository } from "../persistence/postgres/repositories/plan-repository";
import { sessionRepository } from "../persistence/postgres/repositories/session-repository";
import {
  type DatabaseClient,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";
import {
  assertLiveExecutionAuthorization,
  lockAndValidateExecutionAuthorization,
} from "./execution-authorization-guard";

export type PrepareExecutionResult = Readonly<{
  isReplay: boolean;
  execution: PersistedExecution;
  steps: readonly PersistedExecutionStepState[];
}>;

function preparationFingerprint(command: PrepareExecutionCommand): string {
  return createCanonicalFingerprint(command);
}

export async function prepareAuthorizedExecution(
  db: DatabaseClient,
  authorization: ExecutionSafetyState,
  rawCommand: PrepareExecutionCommand,
): Promise<PrepareExecutionResult> {
  const parsed = prepareExecutionCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid execution preparation command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;
  assertLiveExecutionAuthorization(
    authorization,
    command.expectedSafetyGeneration,
  );

  return await runInTransaction(db, async (tx) => {
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "prepare-execution",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash: preparationFingerprint(command),
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    });

    await lockAndValidateExecutionAuthorization(tx, authorization, {
      sessionId: command.sessionId,
      expectedGeneration: command.expectedSafetyGeneration,
    });

    if (claim.isReplay) {
      if (claim.record.status !== "COMPLETED") {
        throw PersistenceError.stateConflict(
          `Execution preparation command "${command.commandIdempotencyKey}" is not complete.`,
        );
      }

      const execution = await executionRepository.findExecutionById(
        tx,
        command.executionId,
      );
      if (
        !execution ||
        execution.sessionId !== command.sessionId ||
        execution.planId !== command.planId
      ) {
        throw PersistenceError.invalidPersistedState(
          "Completed execution preparation replay does not match its durable execution.",
        );
      }

      return {
        isReplay: true,
        execution,
        steps: await executionStepRepository.listSteps(tx, command.executionId),
      };
    }

    const session = await sessionRepository.findSessionByIdForUpdate(
      tx,
      command.sessionId,
    );
    if (!session) {
      throw PersistenceError.notFound(
        `Cognitive session "${command.sessionId}" was not found.`,
      );
    }

    if (
      session.rowVersion !== command.expectedSessionRowVersion ||
      session.phase !== "PLAN" ||
      session.currentCandidateId !== authorization.candidateId ||
      session.currentPlanId !== null ||
      session.currentExecutionId !== null
    ) {
      throw PersistenceError.stateConflict(
        "Session is not in the exact PLAN state required for execution preparation.",
      );
    }

    const plan = await planRepository.findPlanById(tx, command.planId);
    if (!plan) {
      throw PersistenceError.notFound(
        `Action plan "${command.planId}" was not found.`,
      );
    }
    if (plan.candidateId !== authorization.candidateId) {
      throw PersistenceError.stateConflict(
        "Action plan candidate does not match runtime authorization candidate.",
      );
    }

    const execution = await executionRepository.createPendingExecution(tx, {
      executionId: command.executionId,
      sessionId: command.sessionId,
      planId: command.planId,
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      rowVersion: 0,
      safetyGenerationAtStart: null,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    });

    const steps = await executionStepRepository.createPendingSteps(tx, {
      executionId: command.executionId,
      planId: command.planId,
      steps: plan.steps,
      updatedAt: command.createdAt,
    });

    await sessionRepository.transitionSession(tx, {
      sessionId: command.sessionId,
      expectedRowVersion: command.expectedSessionRowVersion,
      expectedPhase: "PLAN",
      expectedCandidateId: authorization.candidateId,
      nextSessionState: {
        phase: "DURABLE_EXECUTION",
        failureCount: session.failureCount,
        retryCount: session.retryCount,
        maxRetries: session.maxRetries,
        cooldownUntil: null,
        currentCandidateId: authorization.candidateId,
        currentPlanId: command.planId,
        currentExecutionId: command.executionId,
        updatedAt: command.createdAt,
      },
    });

    await idempotencyRepository.completeCommand(tx, {
      scope: "prepare-execution",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "execution",
      resultResourceId: command.executionId,
      updatedAt: command.createdAt,
    });

    return { isReplay: false, execution, steps };
  });
}
