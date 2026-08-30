import {
  type AllowedExecutionSafetyState,
  allowAutonomousExecution,
} from "../../../domain/execution-safety";
import {
  type AuthorizationIssuanceCommand,
  authorizationIssuanceCommandSchema,
} from "../../contracts/authorization-issuance-command";
import type { PersistedCognitiveSession } from "../../contracts/cognitive-session";
import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import { PersistenceError } from "../errors/persistence-errors";
import { candidateRepository } from "../repositories/candidate-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { idempotencyRepository } from "../repositories/idempotency-repository";
import { policyRepository } from "../repositories/policy-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import {
  mapPersistedGroundingStatusToDomain,
  mapPersistedPolicyOutcomeToDomain,
  mapStoredSafetyToDomain,
} from "../utils/enum-mappers";
import { type DatabaseClient, runInTransaction } from "./transaction-executor";

export type AuthorizationIssuanceTransactionResult =
  | {
      readonly status: "AUTHORIZED";
      readonly sessionId: string;
      readonly candidateId: string;
      readonly generation: number;
      readonly authorization: AllowedExecutionSafetyState;
      readonly session: PersistedCognitiveSession;
      readonly safetyState: StoredExecutionSafety;
      readonly isReplay: false;
    }
  | {
      readonly status: "ALREADY_ISSUED_NO_CAPABILITY";
      readonly sessionId: string;
      readonly candidateId: string;
      readonly generation: number;
      readonly authorization: null;
      readonly session: PersistedCognitiveSession;
      readonly safetyState: StoredExecutionSafety;
      readonly isReplay: true;
    };

function authorizationIssuanceFingerprint(
  command: AuthorizationIssuanceCommand,
): string {
  return createCanonicalFingerprint({
    sessionId: command.sessionId,
    candidateId: command.candidateId,
    groundingResultId: command.groundingResultId,
    policyDecisionId: command.policyDecisionId,
    expectedSessionRowVersion: command.expectedSessionRowVersion,
    expectedSafetyGeneration: command.expectedSafetyGeneration,
  });
}

export async function persistAuthorizationIssuance(
  db: DatabaseClient,
  rawCommand: AuthorizationIssuanceCommand,
): Promise<AuthorizationIssuanceTransactionResult> {
  const parsed = authorizationIssuanceCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Invalid authorization issuance command: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;
  const requestHash = authorizationIssuanceFingerprint(command);

  return await runInTransaction(db, async (tx) => {
    // 1. Claim command in idempotency ledger
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "authorization-issuance",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash,
      createdAt: command.issuedAt,
      updatedAt: command.issuedAt,
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
          `Idempotency record for authorization command "${command.commandIdempotencyKey}" marked COMPLETED but session or safety state not found.`,
        );
      }

      return {
        status: "ALREADY_ISSUED_NO_CAPABILITY",
        sessionId: command.sessionId,
        candidateId: command.candidateId,
        generation: existingSafety.generation,
        authorization: null,
        session: existingSession,
        safetyState: existingSafety,
        isReplay: true,
      };
    }

    // 2. Lock and validate safety state row FOR UPDATE
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

    // 3. Verify evaluation artifacts have not been previously consumed
    const alreadyConsumed =
      await safetyRepository.hasEvaluationArtifactBeenAuthorized(tx, {
        groundingResultId: command.groundingResultId,
        policyDecisionId: command.policyDecisionId,
      });

    if (alreadyConsumed) {
      throw PersistenceError.stateConflict(
        `Evaluation artifacts (grounding "${command.groundingResultId}" or policy "${command.policyDecisionId}") have already been consumed by an earlier authorization event.`,
        {
          groundingResultId: command.groundingResultId,
          policyDecisionId: command.policyDecisionId,
        },
      );
    }

    // 4. Load and validate cognitive session
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

    if (currentSession.phase !== "POLICY_SAFETY") {
      throw PersistenceError.stateConflict(
        `Cannot issue authorization for session "${command.sessionId}" in phase "${currentSession.phase}" (expected POLICY_SAFETY).`,
        { sessionId: command.sessionId, phase: currentSession.phase },
      );
    }

    if (currentSession.currentCandidateId !== command.candidateId) {
      throw PersistenceError.stateConflict(
        `Session currentCandidateId "${currentSession.currentCandidateId}" does not match command candidateId "${command.candidateId}".`,
        {
          sessionId: command.sessionId,
          sessionCandidateId: currentSession.currentCandidateId,
          commandCandidateId: command.candidateId,
        },
      );
    }

    // 5. Load and validate candidate action
    const candidate = await candidateRepository.findCandidateById(
      tx,
      command.candidateId,
    );

    if (!candidate) {
      throw PersistenceError.notFound(
        `Candidate action "${command.candidateId}" not found.`,
        { candidateId: command.candidateId },
      );
    }

    if (
      candidate.sessionId !== currentSession.sessionId ||
      candidate.cueId !== currentSession.cueId
    ) {
      throw PersistenceError.stateConflict(
        `Candidate action "${command.candidateId}" does not match session "${currentSession.sessionId}" or cue "${currentSession.cueId}".`,
        {
          candidateSessionId: candidate.sessionId,
          sessionSessionId: currentSession.sessionId,
          candidateCueId: candidate.cueId,
          sessionCueId: currentSession.cueId,
        },
      );
    }

    // 6. Load and validate grounding result
    const grounding = await groundingRepository.findGroundingResultById(
      tx,
      command.groundingResultId,
    );

    if (!grounding) {
      throw PersistenceError.notFound(
        `Grounding result "${command.groundingResultId}" not found.`,
        { groundingResultId: command.groundingResultId },
      );
    }

    if (grounding.candidateId !== candidate.candidateId) {
      throw PersistenceError.stateConflict(
        `Grounding result "${command.groundingResultId}" references candidate "${grounding.candidateId}" but expected "${candidate.candidateId}".`,
        {
          groundingCandidateId: grounding.candidateId,
          expectedCandidateId: candidate.candidateId,
        },
      );
    }

    // 7. Load and validate policy decision
    const policy = await policyRepository.findPolicyDecisionById(
      tx,
      command.policyDecisionId,
    );

    if (!policy) {
      throw PersistenceError.notFound(
        `Policy decision "${command.policyDecisionId}" not found.`,
        { policyDecisionId: command.policyDecisionId },
      );
    }

    if (policy.candidateId !== candidate.candidateId) {
      throw PersistenceError.stateConflict(
        `Policy decision "${command.policyDecisionId}" references candidate "${policy.candidateId}" but expected "${candidate.candidateId}".`,
        {
          policyCandidateId: policy.candidateId,
          expectedCandidateId: candidate.candidateId,
        },
      );
    }

    if (policy.groundingResultId !== grounding.groundingResultId) {
      throw PersistenceError.stateConflict(
        `Policy decision "${command.policyDecisionId}" references grounding "${policy.groundingResultId}" but expected "${grounding.groundingResultId}".`,
        {
          policyGroundingResultId: policy.groundingResultId,
          expectedGroundingResultId: grounding.groundingResultId,
        },
      );
    }

    // 8. Temporal consistency check
    const candidateCreatedMs = new Date(candidate.createdAt).getTime();
    const groundingEvaluatedMs = new Date(grounding.evaluatedAt).getTime();
    const policyEvaluatedMs = new Date(policy.evaluatedAt).getTime();

    if (groundingEvaluatedMs < candidateCreatedMs) {
      throw PersistenceError.stateConflict(
        `Grounding result evaluated at ${grounding.evaluatedAt} before candidate creation at ${candidate.createdAt}.`,
      );
    }

    if (policyEvaluatedMs < groundingEvaluatedMs) {
      throw PersistenceError.stateConflict(
        `Policy decision evaluated at ${policy.evaluatedAt} before grounding evaluation at ${grounding.evaluatedAt}.`,
      );
    }

    // 9. Map and verify gate outcomes
    const domainGroundingStatus = mapPersistedGroundingStatusToDomain(
      grounding.status,
    );
    if (domainGroundingStatus !== "VERIFIED") {
      throw PersistenceError.stateConflict(
        `Grounding status "${grounding.status}" does not permit autonomous execution authorization (must be VERIFIED).`,
        { groundingStatus: grounding.status },
      );
    }

    const domainPolicyOutcome = mapPersistedPolicyOutcomeToDomain(
      policy.outcome,
    );
    if (domainPolicyOutcome !== "ALLOW") {
      throw PersistenceError.stateConflict(
        `Policy outcome "${policy.outcome}" does not permit autonomous execution authorization (must be ALLOW).`,
        { policyOutcome: policy.outcome },
      );
    }

    // 10. Derive runtime authorization through domain helper
    const domainSafety = mapStoredSafetyToDomain(currentSafety);
    const runtimeAuth = allowAutonomousExecution(
      domainSafety,
      { phase: currentSession.phase },
      {
        candidateId: candidate.candidateId,
        status: domainGroundingStatus,
      },
      {
        candidateId: candidate.candidateId,
        outcome: domainPolicyOutcome,
      },
    );

    if (runtimeAuth.generation !== command.expectedSafetyGeneration + 1) {
      throw PersistenceError.invalidPersistedState(
        `Derived runtime authorization generation ${runtimeAuth.generation} does not match expected next generation ${command.expectedSafetyGeneration + 1}.`,
      );
    }

    // 11. Persist durable safety state transition
    const updatedSafety = await safetyRepository.transitionSafety(
      tx,
      {
        commandIdempotencyKey: command.safetyEventKey,
        sessionId: command.sessionId,
        expectedGeneration: command.expectedSafetyGeneration,
        nextState: {
          sessionId: command.sessionId,
          generation: command.expectedSafetyGeneration + 1,
          status: "UNAUTHORIZED",
          failure: null,
          reason:
            "Autonomous execution authorized by verified grounding and policy ALLOW.",
          blockedAt: null,
          evaluatedCandidateId: command.candidateId,
          groundingResultId: command.groundingResultId,
          policyDecisionId: command.policyDecisionId,
          updatedAt: command.issuedAt,
        },
      },
      {
        safetyEventId: command.safetyEventId,
        eventType: "AUTHORIZATION_ISSUED",
        occurredAt: command.issuedAt,
      },
    );

    // 12. CAS update cognitive session: POLICY_SAFETY -> PLAN
    const updatedSession = await sessionRepository.transitionSession(tx, {
      sessionId: command.sessionId,
      expectedRowVersion: command.expectedSessionRowVersion,
      expectedPhase: "POLICY_SAFETY",
      expectedCandidateId: command.candidateId,
      nextSessionState: {
        phase: "PLAN",
        failureCount: currentSession.failureCount,
        retryCount: currentSession.retryCount,
        maxRetries: currentSession.maxRetries,
        cooldownUntil: null,
        currentCandidateId: command.candidateId,
        currentPlanId: null,
        currentExecutionId: null,
        updatedAt: command.issuedAt,
      },
    });

    // 13. Complete idempotency record
    await idempotencyRepository.completeCommand(tx, {
      scope: "authorization-issuance",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "execution_safety_state",
      resultResourceId: command.sessionId,
      updatedAt: command.issuedAt,
    });

    return {
      status: "AUTHORIZED",
      sessionId: command.sessionId,
      candidateId: command.candidateId,
      generation: runtimeAuth.generation,
      authorization: runtimeAuth,
      session: updatedSession,
      safetyState: updatedSafety,
      isReplay: false,
    };
  });
}
