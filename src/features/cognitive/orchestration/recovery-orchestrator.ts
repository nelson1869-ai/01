import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { CooldownResumeCommand } from "../persistence/contracts/cooldown-resume-command";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { safetyRepository } from "../persistence/postgres/repositories/safety-repository";
import { sessionRepository } from "../persistence/postgres/repositories/session-repository";
import { persistCooldownResume } from "../persistence/postgres/transactions/persist-cooldown-resume";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";

export type RecoveryInspectionResult =
  | {
      readonly status: "COOLDOWN_ACTIVE";
      readonly sessionId: string;
      readonly cooldownUntil: string;
      readonly remainingMs: number;
    }
  | {
      readonly status: "COOLDOWN_READY";
      readonly sessionId: string;
      readonly cooldownUntil: string;
      readonly readyAt: string;
    }
  | {
      readonly status: "RESUMED_TO_BUILD_CONTEXT";
      readonly sessionId: string;
      readonly session: PersistedCognitiveSession;
      readonly isReplay: boolean;
    }
  | {
      readonly status: "HUMAN_REVIEW_REQUIRED";
      readonly sessionId: string;
      readonly failureCount: number;
      readonly reason: string;
    }
  | {
      readonly status: "NO_RECOVERY_ACTION";
      readonly sessionId: string;
      readonly phase: string;
      readonly reason: string;
    };

export interface OrchestrateRecoveryParams {
  readonly sessionId: string;
  readonly now: string;
  readonly commandIdempotencyKey?: string;
  readonly expectedSafetyGeneration?: number;
}

export function inspectRecoveryState(
  session: PersistedCognitiveSession,
  now: string,
): RecoveryInspectionResult {
  if (session.phase === "COOLDOWN") {
    if (!session.cooldownUntil) {
      throw PersistenceError.invalidPersistedState(
        `Session "${session.sessionId}" in COOLDOWN phase is missing cooldownUntil.`,
        { sessionId: session.sessionId },
      );
    }

    const nowMs = new Date(now).getTime();
    const cooldownUntilMs = new Date(session.cooldownUntil).getTime();

    if (nowMs < cooldownUntilMs) {
      return {
        status: "COOLDOWN_ACTIVE",
        sessionId: session.sessionId,
        cooldownUntil: session.cooldownUntil,
        remainingMs: cooldownUntilMs - nowMs,
      };
    }

    return {
      status: "COOLDOWN_READY",
      sessionId: session.sessionId,
      cooldownUntil: session.cooldownUntil,
      readyAt: now,
    };
  }

  if (session.phase === "HUMAN_REVIEW") {
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      sessionId: session.sessionId,
      failureCount: session.failureCount,
      reason:
        "Session requires explicit human review and will not automatically resume.",
    };
  }

  return {
    status: "NO_RECOVERY_ACTION",
    sessionId: session.sessionId,
    phase: session.phase,
    reason: `Session in phase "${session.phase}" has no pending cooldown or recovery action.`,
  };
}

export async function orchestrateRecoverySession(
  db: DatabaseClient,
  params: OrchestrateRecoveryParams,
): Promise<RecoveryInspectionResult> {
  const session = await sessionRepository.findSessionById(db, params.sessionId);
  if (!session) {
    throw PersistenceError.notFound(
      `Cognitive session "${params.sessionId}" not found.`,
      { sessionId: params.sessionId },
    );
  }

  const inspection = inspectRecoveryState(session, params.now);

  if (inspection.status !== "COOLDOWN_READY") {
    return inspection;
  }

  const safety = await safetyRepository.findSafetyStateBySessionId(
    db,
    params.sessionId,
  );

  if (!safety) {
    throw PersistenceError.stateConflict(
      `Execution safety state for session "${params.sessionId}" not found.`,
      { sessionId: params.sessionId },
    );
  }

  const resumeCommand: CooldownResumeCommand = {
    commandIdempotencyKey:
      params.commandIdempotencyKey ??
      `cooldown-resume:${session.sessionId}:${session.rowVersion}`,
    sessionId: session.sessionId,
    expectedSessionRowVersion: session.rowVersion,
    expectedSafetyGeneration:
      params.expectedSafetyGeneration ?? safety.generation,
    expectedCooldownUntil: session.cooldownUntil!,
    resumedAt: params.now,
  };

  const resumeResult = await persistCooldownResume(db, resumeCommand);

  return {
    status: "RESUMED_TO_BUILD_CONTEXT",
    sessionId: session.sessionId,
    session: resumeResult.session,
    isReplay: resumeResult.isReplay,
  };
}
