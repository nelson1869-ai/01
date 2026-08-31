import { and, eq, inArray } from "drizzle-orm";

import { applyFailureRecovery } from "../../../domain/apply-failure-recovery";
import { blockExecutionForSafety } from "../../../domain/block-execution-for-safety";
import type { ExecutionRecord } from "../../../domain/execution";
import {
  blockAutonomousExecution,
  type ExecutionSafetyState,
} from "../../../domain/execution-safety";
import {
  decideFailureRecovery,
  type FailureRecoveryDecision,
} from "../../../domain/failure-recovery";
import type { AgentContext } from "../../../domain/types";
import type { PersistedCognitiveSession } from "../../contracts/cognitive-session";
import type { PersistedExecution } from "../../contracts/execution";
import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import type { PersistedFailureAudit } from "../../contracts/failure-audit";
import {
  type FailureRecoveryCommand,
  failureRecoveryCommandSchema,
} from "../../contracts/failure-recovery-command";
import { PersistenceError } from "../errors/persistence-errors";
import { failureAuditRepository } from "../repositories/failure-audit-repository";
import { idempotencyRepository } from "../repositories/idempotency-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import { executionEvents, executions } from "../schema/execution";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeExecutionRow } from "../utils/row-mappers";
import { type DatabaseClient, runInTransaction } from "./transaction-executor";

export type FailureRecoveryTransactionResult = Readonly<{
  isReplay: boolean;
  decision: FailureRecoveryDecision;
  audit: PersistedFailureAudit;
  safetyState: StoredExecutionSafety;
  session: PersistedCognitiveSession;
  blockedExecution: PersistedExecution | null;
}>;

function failureCommandFingerprint(
  command: FailureRecoveryCommand,
  sortedEvidenceIds: readonly string[],
): string {
  return createCanonicalFingerprint({
    sessionId: command.sessionId,
    expectedSessionRowVersion: command.expectedSessionRowVersion,
    expectedSafetyGeneration: command.expectedSafetyGeneration,
    failure: command.failure,
    reason: command.reason,
    evidenceIds: sortedEvidenceIds,
    candidateId: command.candidateId ?? null,
    planId: command.planId ?? null,
    activeExecution: command.activeExecution
      ? {
          executionId: command.activeExecution.executionId,
          expectedExecutionRowVersion:
            command.activeExecution.expectedExecutionRowVersion,
          expectedStatus: command.activeExecution.expectedStatus,
        }
      : null,
  });
}

export async function persistFailureRecovery(
  db: DatabaseClient,
  rawCommand: FailureRecoveryCommand,
): Promise<FailureRecoveryTransactionResult> {
  const parsed = failureRecoveryCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Invalid failure recovery command: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;
  const sortedEvidenceIds = Array.from(new Set(command.evidenceIds)).sort();
  const requestHash = failureCommandFingerprint(command, sortedEvidenceIds);

  return await runInTransaction(db, async (tx) => {
    // 1. Claim command in idempotency ledger
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "failure-recovery",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    });

    if (claim.isReplay && claim.record.status === "COMPLETED") {
      // Replay path: fetch already committed records
      const existingAudit =
        await failureAuditRepository.findFailureAuditBySessionAndLogicalKey(
          tx,
          command.sessionId,
          command.commandIdempotencyKey,
        );

      if (!existingAudit) {
        throw PersistenceError.invalidPersistedState(
          `Idempotency record for failure command "${command.commandIdempotencyKey}" marked COMPLETED but audit event not found.`,
        );
      }

      const existingSafety = await safetyRepository.findSafetyStateBySessionId(
        tx,
        command.sessionId,
      );

      const existingSession = await sessionRepository.findSessionById(
        tx,
        command.sessionId,
      );

      if (!existingSafety || !existingSession) {
        throw PersistenceError.invalidPersistedState(
          `Failed to rehydrate safety state or session for replay of failure command "${command.commandIdempotencyKey}".`,
        );
      }

      let existingBlockedExecution: PersistedExecution | null = null;
      if (command.activeExecution) {
        const execRows = await tx
          .select()
          .from(executions)
          .where(
            eq(executions.executionId, command.activeExecution.executionId),
          )
          .limit(1);

        if (execRows.length > 0) {
          existingBlockedExecution = decodeExecutionRow(execRows[0]);
        }
      }

      const replayDecision: FailureRecoveryDecision = {
        failure: existingAudit.failure,
        action: existingAudit.recoveryAction,
        failureCount: existingAudit.failureCount,
        retryCount: existingAudit.retryCount,
        reason: existingAudit.reason,
      };

      return {
        isReplay: true,
        decision: replayDecision,
        audit: existingAudit,
        safetyState: existingSafety,
        session: existingSession,
        blockedExecution: existingBlockedExecution,
      };
    }

    // 2. Concurrency checks on session and safety
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
        `Session "${command.sessionId}" row_version mismatch (expected ${command.expectedSessionRowVersion}, found ${currentSession.rowVersion}).`,
        {
          sessionId: command.sessionId,
          expected: command.expectedSessionRowVersion,
          actual: currentSession.rowVersion,
        },
      );
    }

    const currentSafety = await safetyRepository.findSafetyStateBySessionId(
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
        `Safety state for session "${command.sessionId}" generation mismatch (expected ${command.expectedSafetyGeneration}, found ${currentSafety.generation}).`,
        {
          sessionId: command.sessionId,
          expected: command.expectedSafetyGeneration,
          actual: currentSafety.generation,
        },
      );
    }

    // 3. Compute deterministic domain failure recovery outcome using domain helpers
    const agentContext: AgentContext = {
      sessionId: currentSession.sessionId,
      phase: currentSession.phase,
      failureCount: currentSession.failureCount,
      retryCount: currentSession.retryCount,
      maxRetries: currentSession.maxRetries,
      cooldownUntilMs: currentSession.cooldownUntil
        ? new Date(currentSession.cooldownUntil).getTime()
        : null,
      workingMemory: {},
      createdAt: currentSession.createdAt,
    };

    const decision = decideFailureRecovery(agentContext, command.failure);
    const nowMs = new Date(command.createdAt).getTime();
    const recoveredContext = applyFailureRecovery(
      agentContext,
      decision,
      nowMs,
    );

    // Derive next safety domain state using domain helper blockAutonomousExecution
    const currentSafetyDomainState: ExecutionSafetyState =
      currentSafety.status === "BLOCKED"
        ? {
            status: "BLOCKED",
            generation: currentSafety.generation,
            candidateId: null,
            failure: currentSafety.failure ?? command.failure,
            reason: currentSafety.reason,
            blockedAt: currentSafety.blockedAt ?? command.createdAt,
          }
        : {
            status: "UNAUTHORIZED",
            generation: currentSafety.generation,
            candidateId: null,
            failure: null,
            reason: currentSafety.reason,
            blockedAt: null,
          };

    const nextSafetyDomainState = blockAutonomousExecution(
      currentSafetyDomainState,
      command.failure,
      decision.reason,
      command.createdAt,
    );

    // 4. Revoke safety generation (CAS N -> N+1, status BLOCKED) - performs atomic CAS update
    const revokedSafety = await safetyRepository.transitionSafety(
      tx,
      {
        sessionId: command.sessionId,
        expectedGeneration: command.expectedSafetyGeneration,
        nextState: {
          sessionId: command.sessionId,
          generation: nextSafetyDomainState.generation,
          status: nextSafetyDomainState.status,
          failure: nextSafetyDomainState.failure,
          reason: nextSafetyDomainState.reason,
          blockedAt: nextSafetyDomainState.blockedAt,
          evaluatedCandidateId: null,
          groundingResultId: null,
          policyDecisionId: null,
          updatedAt: command.createdAt,
        },
        commandIdempotencyKey: command.safetyEventKey,
      },
      {
        safetyEventId: command.safetyEventId,
        failureAuditEventId: command.auditEventId,
        occurredAt: command.createdAt,
      },
    );

    // 5. Transition cognitive session to recovered state (atomic CAS update)
    const nextCooldownUntil = recoveredContext.cooldownUntilMs
      ? new Date(recoveredContext.cooldownUntilMs).toISOString()
      : null;

    const updatedSession = await sessionRepository.transitionSession(tx, {
      sessionId: command.sessionId,
      expectedRowVersion: command.expectedSessionRowVersion,
      nextSessionState: {
        phase: recoveredContext.phase,
        failureCount: recoveredContext.failureCount,
        retryCount: recoveredContext.retryCount,
        maxRetries: currentSession.maxRetries,
        evaluationGeneration: currentSession.evaluationGeneration + 1,
        cooldownUntil: nextCooldownUntil,
        currentCandidateId: null,
        currentPlanId: null,
        currentExecutionId: null,
        updatedAt: command.createdAt,
      },
    });

    // 6. Append failure audit event + evidence associations
    const auditRecord: PersistedFailureAudit = {
      auditEventId: command.auditEventId,
      sessionId: command.sessionId,
      candidateId: command.candidateId ?? null,
      planId: command.planId ?? null,
      executionId: command.activeExecution?.executionId ?? null,
      stepId: null,
      failure: command.failure,
      recoveryAction: decision.action,
      phase: currentSession.phase,
      failureCount: decision.failureCount,
      retryCount: decision.retryCount,
      fromSafetyGeneration: currentSafety.generation,
      revokedSafetyGeneration: nextSafetyDomainState.generation,
      reason: decision.reason,
      evidenceIds: sortedEvidenceIds,
      logicalFailureKey: command.commandIdempotencyKey,
      createdAt: command.createdAt,
    };

    const auditAppendResult = await failureAuditRepository.appendFailureAudit(
      tx,
      auditRecord,
    );

    // 7. Block active execution if provided, using blockExecutionForSafety domain helper
    let blockedExecution: PersistedExecution | null = null;
    if (command.activeExecution) {
      const execTarget = command.activeExecution;

      const activeExecutionDomainRecord: ExecutionRecord = {
        id: execTarget.executionId,
        planId: command.planId ?? "",
        status: execTarget.expectedStatus,
        currentStepId: null,
        startedAt: null,
        completedAt: null,
        error: null,
      };

      const blockedDomainExecution = blockExecutionForSafety(
        activeExecutionDomainRecord,
        decision.reason,
        command.createdAt,
      );

      const updatedExecRows = await tx
        .update(executions)
        .set({
          status: blockedDomainExecution.status,
          completedAt: blockedDomainExecution.completedAt,
          error: blockedDomainExecution.error,
          rowVersion: execTarget.expectedExecutionRowVersion + 1,
          updatedAt: command.createdAt,
        })
        .where(
          and(
            eq(executions.executionId, execTarget.executionId),
            eq(executions.sessionId, command.sessionId),
            eq(executions.rowVersion, execTarget.expectedExecutionRowVersion),
            inArray(executions.status, ["PENDING", "RUNNING"]),
          ),
        )
        .returning();

      if (updatedExecRows.length === 0) {
        throw PersistenceError.staleWrite(
          `Execution "${execTarget.executionId}" could not be transitioned to BLOCKED from expected row_version ${execTarget.expectedExecutionRowVersion}.`,
          {
            executionId: execTarget.executionId,
            expectedRowVersion: execTarget.expectedExecutionRowVersion,
          },
        );
      }

      await tx.insert(executionEvents).values({
        executionEventId: execTarget.executionEventId,
        executionId: execTarget.executionId,
        transitionSequence: execTarget.expectedExecutionRowVersion + 1,
        fromStatus: execTarget.expectedStatus,
        toStatus: blockedDomainExecution.status,
        stepId: null,
        safetyGeneration: nextSafetyDomainState.generation,
        operationId: null,
        eventKey: execTarget.executionEventKey,
        reason: decision.reason,
        occurredAt: command.createdAt,
      });

      blockedExecution = decodeExecutionRow(updatedExecRows[0]);
    }

    // 8. Complete idempotency record
    await idempotencyRepository.completeCommand(tx, {
      scope: "failure-recovery",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "failure_audit_events",
      resultResourceId: command.auditEventId,
      updatedAt: command.createdAt,
    });

    return {
      isReplay: false,
      decision,
      audit: auditAppendResult.audit,
      safetyState: revokedSafety,
      session: updatedSession,
      blockedExecution,
    };
  });
}
