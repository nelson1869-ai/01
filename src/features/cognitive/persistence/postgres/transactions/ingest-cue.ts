import type { PersistedCognitiveSession } from "../../contracts/cognitive-session";
import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import { assertDataSecurity } from "../../../security/secret-safety";
import { cueRepository } from "../repositories/cue-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "./transaction-executor";

export interface IngestCueInput {
  readonly cue: PersistedCueIngress;
  readonly sessionId: string;
  readonly maxRetries?: number;
}

export interface IngestCueResult {
  readonly isReplay: boolean;
  readonly cue: PersistedCueIngress;
  readonly session: PersistedCognitiveSession;
  readonly safetyState: StoredExecutionSafety;
}

export async function ingestCue(
  executor: DatabaseExecutor,
  input: IngestCueInput,
): Promise<IngestCueResult> {
  assertDataSecurity(input.cue.payload, "cue.payload");

  return await runInTransaction(executor, async (tx) => {
    const cueResult = await cueRepository.insertCue(tx, input.cue);

    if (cueResult.isReplay) {
      const existingSession = await sessionRepository.findSessionByCueId(
        tx,
        cueResult.cue.cueId,
      );

      if (existingSession === null) {
        throw new Error(
          `Data corruption: Replayed cue "${cueResult.cue.cueId}" exists without a cognitive session.`,
        );
      }

      const existingSafety = await safetyRepository.findSafetyStateBySessionId(
        tx,
        existingSession.sessionId,
      );

      if (existingSafety === null) {
        throw new Error(
          `Data corruption: Session "${existingSession.sessionId}" exists without execution safety state.`,
        );
      }

      return {
        isReplay: true,
        cue: cueResult.cue,
        session: existingSession,
        safetyState: existingSafety,
      };
    }

    const session = await sessionRepository.createSession(tx, {
      sessionId: input.sessionId,
      cueId: input.cue.cueId,
      currentCandidateId: null,
      currentPlanId: null,
      currentExecutionId: null,
      phase: "CUE",
      failureCount: 0,
      retryCount: 0,
      maxRetries: input.maxRetries ?? 2,
      evaluationGeneration: 1,
      cooldownUntil: null,
      rowVersion: 0,
      createdAt: input.cue.receivedAt,
      updatedAt: input.cue.receivedAt,
    });

    const safetyState = await safetyRepository.createInitialSafetyState(
      tx,
      input.sessionId,
      input.cue.receivedAt,
    );

    return {
      isReplay: false,
      cue: input.cue,
      session,
      safetyState,
    };
  });
}
