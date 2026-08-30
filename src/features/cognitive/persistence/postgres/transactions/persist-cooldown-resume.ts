import { resumeAfterCooldown } from "../../../domain/resume-after-cooldown";
import type { AgentContext } from "../../../domain/types";
import type { PersistedCognitiveSession } from "../../contracts/cognitive-session";
import {
  type CooldownResumeCommand,
  cooldownResumeCommandSchema,
} from "../../contracts/cooldown-resume-command";
import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import { PersistenceError } from "../errors/persistence-errors";
import { cueRepository } from "../repositories/cue-repository";
import { idempotencyRepository } from "../repositories/idempotency-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { mapPersistedCueToDomainCue } from "../utils/row-mappers";
import { type DatabaseClient, runInTransaction } from "./transaction-executor";

export type CooldownResumeTransactionResult = Readonly<{
  isReplay: boolean;
  session: PersistedCognitiveSession;
  safetyState: StoredExecutionSafety;
}>;

function cooldownResumeFingerprint(command: CooldownResumeCommand): string {
  return createCanonicalFingerprint({
    sessionId: command.sessionId,
    expectedSessionRowVersion: command.expectedSessionRowVersion,
    expectedSafetyGeneration: command.expectedSafetyGeneration,
    expectedCooldownUntil: command.expectedCooldownUntil,
  });
}

export async function persistCooldownResume(
  db: DatabaseClient,
  rawCommand: CooldownResumeCommand,
): Promise<CooldownResumeTransactionResult> {
  const parsed = cooldownResumeCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Invalid cooldown resume command: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;
  const requestHash = cooldownResumeFingerprint(command);

  return await runInTransaction(db, async (tx) => {
    // 1. Claim command in idempotency ledger
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "cooldown-resume",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash,
      createdAt: command.resumedAt,
      updatedAt: command.resumedAt,
    });

    if (claim.isReplay && claim.record.status === "COMPLETED") {
      const existingSession = await sessionRepository.findSessionById(
        tx,
        command.sessionId,
      );
      const existingSafety = await safetyRepository.findSafetyStateBySessionId(
        tx,
        command.sessionId,
      );

      if (!existingSession || !existingSafety) {
        throw PersistenceError.invalidPersistedState(
          `Idempotency record for cooldown resume command "${command.commandIdempotencyKey}" marked COMPLETED but session or safety state not found.`,
        );
      }

      return {
        isReplay: true,
        session: existingSession,
        safetyState: existingSafety,
      };
    }

    // 2. Lock and validate safety state
    const currentSafety =
      await safetyRepository.findSafetyStateBySessionIdForUpdate(
        tx,
        command.sessionId,
      );

    if (!currentSafety) {
      throw PersistenceError.stateConflict(
        `Execution safety state for session "${command.sessionId}" does not exist.`,
        { sessionId: command.sessionId },
      );
    }

    if (currentSafety.generation !== command.expectedSafetyGeneration) {
      throw PersistenceError.staleWrite(
        `Execution safety generation mismatch for session "${command.sessionId}" (expected ${command.expectedSafetyGeneration}, found ${currentSafety.generation}).`,
        {
          sessionId: command.sessionId,
          expected: command.expectedSafetyGeneration,
          actual: currentSafety.generation,
        },
      );
    }

    if (currentSafety.status !== "BLOCKED") {
      throw PersistenceError.stateConflict(
        `Cooldown resume requires safety state to be BLOCKED (found ${currentSafety.status}).`,
        {
          sessionId: command.sessionId,
          status: currentSafety.status,
        },
      );
    }

    // 3. Load and validate cognitive session
    const currentSession = await sessionRepository.findSessionById(
      tx,
      command.sessionId,
    );

    if (!currentSession) {
      throw PersistenceError.stateConflict(
        `Cognitive session "${command.sessionId}" does not exist.`,
        { sessionId: command.sessionId },
      );
    }

    if (currentSession.rowVersion !== command.expectedSessionRowVersion) {
      throw PersistenceError.staleWrite(
        `Cognitive session "${command.sessionId}" row_version mismatch (expected ${command.expectedSessionRowVersion}, found ${currentSession.rowVersion}).`,
        {
          sessionId: command.sessionId,
          expected: command.expectedSessionRowVersion,
          actual: currentSession.rowVersion,
        },
      );
    }

    if (currentSession.phase !== "COOLDOWN") {
      throw PersistenceError.stateConflict(
        `Cannot resume session "${command.sessionId}" from phase "${currentSession.phase}" (expected COOLDOWN).`,
        {
          sessionId: command.sessionId,
          phase: currentSession.phase,
        },
      );
    }

    if (currentSession.cooldownUntil !== command.expectedCooldownUntil) {
      throw PersistenceError.staleWrite(
        `Cognitive session "${command.sessionId}" cooldownUntil mismatch (expected ${command.expectedCooldownUntil}, found ${currentSession.cooldownUntil}).`,
        {
          sessionId: command.sessionId,
          expected: command.expectedCooldownUntil,
          actual: currentSession.cooldownUntil,
        },
      );
    }

    // 4. Load root cue
    const cue = await cueRepository.findCueById(tx, currentSession.cueId);
    if (!cue) {
      throw PersistenceError.invalidPersistedState(
        `Root cue "${currentSession.cueId}" for session "${command.sessionId}" was not found in database.`,
        {
          sessionId: command.sessionId,
          cueId: currentSession.cueId,
        },
      );
    }

    const domainCue = mapPersistedCueToDomainCue(cue);

    // 5. Build ephemeral AgentContext and call domain helper resumeAfterCooldown
    const agentContext: AgentContext = {
      sessionId: currentSession.sessionId,
      phase: currentSession.phase,
      failureCount: currentSession.failureCount,
      retryCount: currentSession.retryCount,
      maxRetries: currentSession.maxRetries,
      cooldownUntilMs: currentSession.cooldownUntil
        ? new Date(currentSession.cooldownUntil).getTime()
        : null,
      workingMemory: { cue: domainCue },
      createdAt: currentSession.createdAt,
    };

    const resumedAtMs = new Date(command.resumedAt).getTime();
    let resumedContext: AgentContext;
    try {
      resumedContext = resumeAfterCooldown(agentContext, resumedAtMs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw PersistenceError.stateConflict(
        `Cooldown resume rejected by domain rule: ${message}`,
        { sessionId: command.sessionId, reason: message },
      );
    }

    // 6. CAS update cognitive session
    const updatedSession = await sessionRepository.transitionSession(tx, {
      sessionId: command.sessionId,
      expectedRowVersion: command.expectedSessionRowVersion,
      nextSessionState: {
        phase: resumedContext.phase,
        failureCount: resumedContext.failureCount,
        retryCount: resumedContext.retryCount,
        maxRetries: currentSession.maxRetries,
        cooldownUntil: null,
        currentCandidateId: null,
        currentPlanId: null,
        currentExecutionId: null,
        updatedAt: command.resumedAt,
      },
    });

    // 7. Complete idempotency record
    await idempotencyRepository.completeCommand(tx, {
      scope: "cooldown-resume",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "cognitive_sessions",
      resultResourceId: command.sessionId,
      updatedAt: command.resumedAt,
    });

    return {
      isReplay: false,
      session: updatedSession,
      safetyState: currentSafety,
    };
  });
}
