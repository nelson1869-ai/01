import { and, asc, eq } from "drizzle-orm";

import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import { PersistenceError } from "../errors/persistence-errors";
import { groundingResultEvidence, groundingResults } from "../schema/decisions";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeGroundingResultRow } from "../utils/row-mappers";

function groundingContentHash(grounding: PersistedGroundingResult): string {
  return createCanonicalFingerprint({
    candidateId: grounding.candidateId,
    evaluationKey: grounding.evaluationKey,
    status: grounding.status,
    confidence: grounding.confidence,
    reason: grounding.reason,
    evaluatorVersion: grounding.evaluatorVersion,
    evidenceIds: grounding.evidenceIds,
  });
}

export class GroundingRepository {
  async findGroundingResultById(
    executor: DatabaseExecutor,
    groundingResultId: string,
  ): Promise<PersistedGroundingResult | null> {
    const resultRows = await executor
      .select()
      .from(groundingResults)
      .where(eq(groundingResults.groundingResultId, groundingResultId))
      .limit(1);

    if (resultRows.length === 0) {
      return null;
    }

    const evidenceRows = await executor
      .select({ evidenceId: groundingResultEvidence.evidenceId })
      .from(groundingResultEvidence)
      .where(eq(groundingResultEvidence.groundingResultId, groundingResultId))
      .orderBy(asc(groundingResultEvidence.ordinal));

    const evidenceIds = evidenceRows.map((r) => r.evidenceId);

    return decodeGroundingResultRow(resultRows[0], evidenceIds);
  }

  async findGroundingResultByCandidateId(
    executor: DatabaseExecutor,
    candidateId: string,
  ): Promise<PersistedGroundingResult | null> {
    const resultRows = await executor
      .select()
      .from(groundingResults)
      .where(eq(groundingResults.candidateId, candidateId))
      .limit(1);

    if (resultRows.length === 0) {
      return null;
    }

    const evidenceRows = await executor
      .select({ evidenceId: groundingResultEvidence.evidenceId })
      .from(groundingResultEvidence)
      .where(
        eq(
          groundingResultEvidence.groundingResultId,
          resultRows[0].groundingResultId,
        ),
      )
      .orderBy(asc(groundingResultEvidence.ordinal));

    const evidenceIds = evidenceRows.map((r) => r.evidenceId);

    return decodeGroundingResultRow(resultRows[0], evidenceIds);
  }

  async findGroundingResultByCandidateAndKey(
    executor: DatabaseExecutor,
    candidateId: string,
    evaluationKey: string,
  ): Promise<PersistedGroundingResult | null> {
    const resultRows = await executor
      .select()
      .from(groundingResults)
      .where(
        and(
          eq(groundingResults.candidateId, candidateId),
          eq(groundingResults.evaluationKey, evaluationKey),
        ),
      )
      .limit(1);

    if (resultRows.length === 0) {
      return null;
    }

    const evidenceRows = await executor
      .select({ evidenceId: groundingResultEvidence.evidenceId })
      .from(groundingResultEvidence)
      .where(
        eq(
          groundingResultEvidence.groundingResultId,
          resultRows[0].groundingResultId,
        ),
      )
      .orderBy(asc(groundingResultEvidence.ordinal));

    const evidenceIds = evidenceRows.map((r) => r.evidenceId);

    return decodeGroundingResultRow(resultRows[0], evidenceIds);
  }

  async appendGroundingResult(
    executor: DatabaseExecutor,
    grounding: PersistedGroundingResult,
  ): Promise<{ isReplay: boolean; grounding: PersistedGroundingResult }> {
    const incomingHash = groundingContentHash(grounding);

    return await runInTransaction(executor, async (tx) => {
      const insertedRows = await tx
        .insert(groundingResults)
        .values({
          groundingResultId: grounding.groundingResultId,
          candidateId: grounding.candidateId,
          evaluationKey: grounding.evaluationKey,
          status: grounding.status,
          confidence: grounding.confidence.toFixed(4),
          reason: grounding.reason,
          evaluatorVersion: grounding.evaluatorVersion,
          evaluatedAt: grounding.evaluatedAt,
        })
        .onConflictDoNothing()
        .returning();

      if (insertedRows.length > 0) {
        if (grounding.evidenceIds.length > 0) {
          for (let i = 0; i < grounding.evidenceIds.length; i++) {
            await tx.insert(groundingResultEvidence).values({
              groundingResultId: grounding.groundingResultId,
              evidenceId: grounding.evidenceIds[i],
              ordinal: i,
            });
          }
        }

        return {
          isReplay: false,
          grounding: decodeGroundingResultRow(
            insertedRows[0],
            grounding.evidenceIds,
          ),
        };
      }

      // Conflict: find existing
      const existing =
        (await this.findGroundingResultById(tx, grounding.groundingResultId)) ??
        (await this.findGroundingResultByCandidateAndKey(
          tx,
          grounding.candidateId,
          grounding.evaluationKey,
        ));

      if (!existing) {
        throw PersistenceError.invalidPersistedState(
          `Failed to find existing grounding result "${grounding.groundingResultId}".`,
        );
      }

      const existingHash = groundingContentHash(existing);

      if (incomingHash !== existingHash) {
        throw PersistenceError.idempotencyConflict(
          `Grounding result for candidate "${grounding.candidateId}" and key "${grounding.evaluationKey}" already exists with different contents.`,
          {
            groundingResultId: grounding.groundingResultId,
            incomingHash,
            existingHash,
          },
        );
      }

      return {
        isReplay: true,
        grounding: existing,
      };
    });
  }
}

export const groundingRepository = new GroundingRepository();
