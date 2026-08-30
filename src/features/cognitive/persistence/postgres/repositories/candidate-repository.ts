import { and, asc, eq } from "drizzle-orm";

import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import { PersistenceError } from "../errors/persistence-errors";
import { candidateActions, candidateEvidence } from "../schema/decisions";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeCandidateActionRow } from "../utils/row-mappers";

function candidateContentHash(candidate: PersistedCandidateAction): string {
  return createCanonicalFingerprint({
    sessionId: candidate.sessionId,
    cueId: candidate.cueId,
    goal: candidate.goal,
    action: candidate.action,
    confidence: candidate.confidence,
    expectedUtility: candidate.expectedUtility,
    estimatedRisk: candidate.estimatedRisk,
    estimatedCost: candidate.estimatedCost,
    scoreValue: candidate.scoreValue,
    recommendation: candidate.recommendation,
    scoreFormulaVersion: candidate.scoreFormulaVersion,
    evidenceIds: candidate.evidenceIds,
  });
}

export class CandidateRepository {
  async findCandidateById(
    executor: DatabaseExecutor,
    candidateId: string,
  ): Promise<PersistedCandidateAction | null> {
    const actionRows = await executor
      .select()
      .from(candidateActions)
      .where(eq(candidateActions.candidateId, candidateId))
      .limit(1);

    if (actionRows.length === 0) {
      return null;
    }

    const evidenceRows = await executor
      .select({ evidenceId: candidateEvidence.evidenceId })
      .from(candidateEvidence)
      .where(eq(candidateEvidence.candidateId, candidateId))
      .orderBy(asc(candidateEvidence.ordinal));

    const evidenceIds = evidenceRows.map((r) => r.evidenceId);

    return decodeCandidateActionRow(actionRows[0], evidenceIds);
  }

  async findCandidateBySessionAndId(
    executor: DatabaseExecutor,
    sessionId: string,
    candidateId: string,
  ): Promise<PersistedCandidateAction | null> {
    const actionRows = await executor
      .select()
      .from(candidateActions)
      .where(
        and(
          eq(candidateActions.sessionId, sessionId),
          eq(candidateActions.candidateId, candidateId),
        ),
      )
      .limit(1);

    if (actionRows.length === 0) {
      return null;
    }

    const evidenceRows = await executor
      .select({ evidenceId: candidateEvidence.evidenceId })
      .from(candidateEvidence)
      .where(eq(candidateEvidence.candidateId, candidateId))
      .orderBy(asc(candidateEvidence.ordinal));

    const evidenceIds = evidenceRows.map((r) => r.evidenceId);

    return decodeCandidateActionRow(actionRows[0], evidenceIds);
  }

  async appendCandidate(
    executor: DatabaseExecutor,
    candidate: PersistedCandidateAction,
  ): Promise<{ isReplay: boolean; candidate: PersistedCandidateAction }> {
    const incomingHash = candidateContentHash(candidate);

    return await runInTransaction(executor, async (tx) => {
      const insertedRows = await tx
        .insert(candidateActions)
        .values({
          candidateId: candidate.candidateId,
          sessionId: candidate.sessionId,
          cueId: candidate.cueId,
          goal: candidate.goal,
          action: candidate.action,
          confidence: candidate.confidence.toFixed(4),
          expectedUtility: candidate.expectedUtility.toFixed(4),
          estimatedRisk: candidate.estimatedRisk.toFixed(4),
          estimatedCost: candidate.estimatedCost.toFixed(4),
          scoreValue: candidate.scoreValue.toFixed(4),
          recommendation: candidate.recommendation,
          scoreFormulaVersion: candidate.scoreFormulaVersion,
          createdAt: candidate.createdAt,
        })
        .onConflictDoNothing()
        .returning();

      if (insertedRows.length > 0) {
        if (candidate.evidenceIds.length > 0) {
          for (let i = 0; i < candidate.evidenceIds.length; i++) {
            await tx.insert(candidateEvidence).values({
              candidateId: candidate.candidateId,
              evidenceId: candidate.evidenceIds[i],
              ordinal: i,
            });
          }
        }

        return {
          isReplay: false,
          candidate: decodeCandidateActionRow(
            insertedRows[0],
            candidate.evidenceIds,
          ),
        };
      }

      // Candidate exists: inspect
      const existing = await this.findCandidateById(tx, candidate.candidateId);

      if (!existing) {
        throw PersistenceError.invalidPersistedState(
          `Failed to find existing candidate "${candidate.candidateId}".`,
        );
      }

      const existingHash = candidateContentHash(existing);

      if (incomingHash !== existingHash) {
        throw PersistenceError.idempotencyConflict(
          `Candidate action with ID "${candidate.candidateId}" already exists with different contents.`,
          {
            candidateId: candidate.candidateId,
            incomingHash,
            existingHash,
          },
        );
      }

      return {
        isReplay: true,
        candidate: existing,
      };
    });
  }
}

export const candidateRepository = new CandidateRepository();
