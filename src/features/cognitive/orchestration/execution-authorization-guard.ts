import {
  isAllowedExecutionSafetyState,
  type AllowedExecutionSafetyState,
  type ExecutionSafetyState,
} from "../domain/execution-safety";
import type { StoredExecutionSafety } from "../persistence/contracts/execution-safety";
import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedExecution } from "../persistence/contracts/execution";
import type { PersistedActionPlan } from "../persistence/contracts/persisted-action-plan";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { executionRepository } from "../persistence/postgres/repositories/execution-repository";
import { planRepository } from "../persistence/postgres/repositories/plan-repository";
import { safetyRepository } from "../persistence/postgres/repositories/safety-repository";
import { sessionRepository } from "../persistence/postgres/repositories/session-repository";
import type { DatabaseExecutor } from "../persistence/postgres/transactions/transaction-executor";

export function assertLiveExecutionAuthorization(
  authorization: ExecutionSafetyState,
  expectedGeneration: number,
): asserts authorization is AllowedExecutionSafetyState {
  if (!isAllowedExecutionSafetyState(authorization)) {
    throw PersistenceError.stateConflict(
      "A real private-branded runtime authorization is required.",
    );
  }

  if (authorization.generation !== expectedGeneration) {
    throw PersistenceError.staleWrite(
      `Runtime authorization generation ${authorization.generation} does not match expected generation ${expectedGeneration}.`,
    );
  }
}

export async function lockAndValidateExecutionAuthorization(
  executor: DatabaseExecutor,
  authorization: AllowedExecutionSafetyState,
  params: {
    readonly sessionId: string;
    readonly expectedGeneration: number;
  },
): Promise<StoredExecutionSafety> {
  const safety = await safetyRepository.findSafetyStateBySessionIdForUpdate(
    executor,
    params.sessionId,
  );

  if (!safety) {
    throw PersistenceError.notFound(
      `Execution safety state for session "${params.sessionId}" was not found.`,
    );
  }

  if (
    safety.status !== "UNAUTHORIZED" ||
    safety.generation !== params.expectedGeneration ||
    safety.generation !== authorization.generation ||
    safety.evaluatedCandidateId !== authorization.candidateId ||
    safety.groundingResultId === null ||
    safety.policyDecisionId === null
  ) {
    throw PersistenceError.stateConflict(
      "Runtime authorization does not match current fail-closed durable safety generation and evaluation provenance.",
      {
        sessionId: params.sessionId,
        expectedGeneration: params.expectedGeneration,
        durableGeneration: safety.generation,
        durableStatus: safety.status,
      },
    );
  }

  return safety;
}

export async function loadAndValidateAuthorizedExecutionContext(
  executor: DatabaseExecutor,
  authorization: AllowedExecutionSafetyState,
  params: {
    readonly sessionId: string;
    readonly planId: string;
    readonly executionId: string;
  },
): Promise<{
  readonly session: PersistedCognitiveSession;
  readonly plan: PersistedActionPlan;
  readonly execution: PersistedExecution;
}> {
  // A PostgreSQL transaction owns one client; keep its queries ordered rather
  // than attempting concurrent client.query calls on the same connection.
  const session = await sessionRepository.findSessionById(
    executor,
    params.sessionId,
  );
  const plan = await planRepository.findPlanById(executor, params.planId);
  const execution = await executionRepository.findExecutionById(
    executor,
    params.executionId,
  );

  if (!session || !plan || !execution) {
    throw PersistenceError.notFound(
      "Authorized execution context is incomplete in durable storage.",
    );
  }

  if (
    (session.phase !== "DURABLE_EXECUTION" && session.phase !== "ACT") ||
    session.currentCandidateId !== authorization.candidateId ||
    session.currentPlanId !== params.planId ||
    session.currentExecutionId !== params.executionId ||
    plan.candidateId !== authorization.candidateId ||
    execution.sessionId !== params.sessionId ||
    execution.planId !== params.planId
  ) {
    throw PersistenceError.stateConflict(
      "Candidate, plan, session, and execution bindings do not match the live authorization.",
    );
  }

  return { session, plan, execution };
}
