import { and, eq } from "drizzle-orm";

import type { PersistedFailureAudit } from "../../contracts/failure-audit";
import { PersistenceError } from "../errors/persistence-errors";
import {
  failureAuditEvents,
  failureAuditEvidence,
} from "../schema/audit";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeFailureAuditRow } from "../utils/row-mappers";

function auditContentHash(audit: PersistedFailureAudit): string {
  return createCanonicalFingerprint({
    sessionId: audit.sessionId,
    candidateId: audit.candidateId ?? null,
    planId: audit.planId ?? null,
    executionId: audit.executionId ?? null,
    stepId: audit.stepId ?? null,
    failure: audit.failure,
    recoveryAction: audit.recoveryAction,
    phase: audit.phase,
    failureCount: audit.failureCount,
    retryCount: audit.retryCount,
    fromSafetyGeneration: audit.fromSafetyGeneration,
    revokedSafetyGeneration: audit.revokedSafetyGeneration,
    reason: audit.reason,
    logicalFailureKey: audit.logicalFailureKey,
    evidenceIds: [...audit.evidenceIds].sort(),
  });
}

export class FailureAuditRepository {
  async findFailureAuditById(
    executor: DatabaseExecutor,
    auditEventId: string,
  ): Promise<PersistedFailureAudit | null> {
    const rows = await executor
      .select()
      .from(failureAuditEvents)
      .where(eq(failureAuditEvents.auditEventId, auditEventId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const evRows = await executor
      .select({ evidenceId: failureAuditEvidence.evidenceId })
      .from(failureAuditEvidence)
      .where(eq(failureAuditEvidence.auditEventId, auditEventId));

    const evidenceIds = evRows.map((r) => r.evidenceId);

    return decodeFailureAuditRow(rows[0], evidenceIds);
  }

  async findFailureAuditBySessionAndLogicalKey(
    executor: DatabaseExecutor,
    sessionId: string,
    logicalFailureKey: string,
  ): Promise<PersistedFailureAudit | null> {
    const rows = await executor
      .select()
      .from(failureAuditEvents)
      .where(
        and(
          eq(failureAuditEvents.sessionId, sessionId),
          eq(failureAuditEvents.logicalFailureKey, logicalFailureKey),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const evRows = await executor
      .select({ evidenceId: failureAuditEvidence.evidenceId })
      .from(failureAuditEvidence)
      .where(
        eq(
          failureAuditEvidence.auditEventId,
          rows[0].auditEventId,
        ),
      );

    const evidenceIds = evRows.map((r) => r.evidenceId);

    return decodeFailureAuditRow(rows[0], evidenceIds);
  }

  async findFailureAuditBySessionAndRevokedGeneration(
    executor: DatabaseExecutor,
    sessionId: string,
    revokedSafetyGeneration: number,
  ): Promise<PersistedFailureAudit | null> {
    const rows = await executor
      .select()
      .from(failureAuditEvents)
      .where(
        and(
          eq(failureAuditEvents.sessionId, sessionId),
          eq(
            failureAuditEvents.revokedSafetyGeneration,
            revokedSafetyGeneration,
          ),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const evRows = await executor
      .select({ evidenceId: failureAuditEvidence.evidenceId })
      .from(failureAuditEvidence)
      .where(
        eq(
          failureAuditEvidence.auditEventId,
          rows[0].auditEventId,
        ),
      );

    const evidenceIds = evRows.map((r) => r.evidenceId);

    return decodeFailureAuditRow(rows[0], evidenceIds);
  }

  async appendFailureAudit(
    executor: DatabaseExecutor,
    audit: PersistedFailureAudit,
  ): Promise<{ isReplay: boolean; audit: PersistedFailureAudit }> {
    const incomingHash = auditContentHash(audit);

    return await runInTransaction(executor, async (tx) => {
      const insertedRows = await tx
        .insert(failureAuditEvents)
        .values({
          auditEventId: audit.auditEventId,
          logicalFailureKey: audit.logicalFailureKey,
          sessionId: audit.sessionId,
          candidateId: audit.candidateId ?? null,
          planId: audit.planId ?? null,
          executionId: audit.executionId ?? null,
          stepId: audit.stepId ?? null,
          failureCode: audit.failure,
          originalPhase: audit.phase,
          failureCount: audit.failureCount,
          retryCount: audit.retryCount,
          fromSafetyGeneration: audit.fromSafetyGeneration,
          revokedSafetyGeneration: audit.revokedSafetyGeneration,
          recoveryAction: audit.recoveryAction,
          reason: audit.reason,
          createdAt: audit.createdAt,
        })
        .onConflictDoNothing()
        .returning();

      if (insertedRows.length > 0) {
        if (audit.evidenceIds.length > 0) {
          for (const evidenceId of audit.evidenceIds) {
            await tx.insert(failureAuditEvidence).values({
              auditEventId: audit.auditEventId,
              evidenceId,
            });
          }
        }

        return {
          isReplay: false,
          audit: decodeFailureAuditRow(insertedRows[0], audit.evidenceIds),
        };
      }

      // Conflict: find existing
      const existing =
        (await this.findFailureAuditById(tx, audit.auditEventId)) ??
        (await this.findFailureAuditBySessionAndLogicalKey(
          tx,
          audit.sessionId,
          audit.logicalFailureKey,
        )) ??
        (await this.findFailureAuditBySessionAndRevokedGeneration(
          tx,
          audit.sessionId,
          audit.revokedSafetyGeneration,
        ));

      if (!existing) {
        throw PersistenceError.invalidPersistedState(
          `Failed to find existing failure audit "${audit.auditEventId}".`,
        );
      }

      if (existing.logicalFailureKey !== audit.logicalFailureKey) {
        throw PersistenceError.stateConflict(
          `Failure audit for session "${audit.sessionId}" generation ${audit.revokedSafetyGeneration} already exists under a different key "${existing.logicalFailureKey}".`,
          {
            sessionId: audit.sessionId,
            existingLogicalKey: existing.logicalFailureKey,
            incomingLogicalKey: audit.logicalFailureKey,
          },
        );
      }

      const existingHash = auditContentHash(existing);

      if (incomingHash !== existingHash) {
        throw PersistenceError.idempotencyConflict(
          `Failure audit for session "${audit.sessionId}" and key "${audit.logicalFailureKey}" already exists with different contents.`,
          {
            auditEventId: audit.auditEventId,
            incomingHash,
            existingHash,
          },
        );
      }

      return {
        isReplay: true,
        audit: existing,
      };
    });
  }
}

export const failureAuditRepository = new FailureAuditRepository();
