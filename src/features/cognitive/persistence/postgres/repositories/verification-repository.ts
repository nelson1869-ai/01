import { and, asc, eq } from "drizzle-orm";

import type { PersistedResultVerification } from "../../contracts/result-verification";
import { PersistenceError } from "../errors/persistence-errors";
import {
  resultVerificationObservations,
  resultVerifications,
} from "../schema/audit";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeResultVerificationRow } from "../utils/row-mappers";

function verificationContentHash(
  v: PersistedResultVerification,
  observationIds: readonly string[],
): string {
  return createCanonicalFingerprint({
    executionId: v.executionId,
    verificationGeneration: v.verificationGeneration,
    observationSetDigest: v.observationSetDigest,
    verifierVersion: v.verifierVersion,
    status: v.status,
    confidence: v.confidence,
    reason: v.reason,
    observationIds: [...observationIds].sort(),
  });
}

export class VerificationRepository {
  async findVerificationById(
    executor: DatabaseExecutor,
    verificationId: string,
  ): Promise<PersistedResultVerification | null> {
    const rows = await executor
      .select()
      .from(resultVerifications)
      .where(eq(resultVerifications.verificationId, verificationId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeResultVerificationRow(rows[0]);
  }

  async findVerificationByExecutionAndGeneration(
    executor: DatabaseExecutor,
    executionId: string,
    verificationGeneration: number,
  ): Promise<PersistedResultVerification | null> {
    const rows = await executor
      .select()
      .from(resultVerifications)
      .where(
        and(
          eq(resultVerifications.executionId, executionId),
          eq(
            resultVerifications.verificationGeneration,
            verificationGeneration,
          ),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeResultVerificationRow(rows[0]);
  }

  async findVerificationByDigestAndVersion(
    executor: DatabaseExecutor,
    executionId: string,
    observationSetDigest: string,
    verifierVersion: string,
  ): Promise<PersistedResultVerification | null> {
    const rows = await executor
      .select()
      .from(resultVerifications)
      .where(
        and(
          eq(resultVerifications.executionId, executionId),
          eq(resultVerifications.observationSetDigest, observationSetDigest),
          eq(resultVerifications.verifierVersion, verifierVersion),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeResultVerificationRow(rows[0]);
  }

  async findObservationIdsForVerification(
    executor: DatabaseExecutor,
    verificationId: string,
  ): Promise<string[]> {
    const rows = await executor
      .select({
        observationId: resultVerificationObservations.observationId,
      })
      .from(resultVerificationObservations)
      .where(eq(resultVerificationObservations.verificationId, verificationId))
      .orderBy(asc(resultVerificationObservations.ordinal));

    return rows.map((r) => r.observationId);
  }

  async appendVerification(
    executor: DatabaseExecutor,
    verification: PersistedResultVerification,
    observationIds: readonly string[] = [],
  ): Promise<{
    isReplay: boolean;
    verification: PersistedResultVerification;
  }> {
    const incomingHash = verificationContentHash(verification, observationIds);

    return await runInTransaction(executor, async (tx) => {
      const insertedRows = await tx
        .insert(resultVerifications)
        .values({
          verificationId: verification.verificationId,
          executionId: verification.executionId,
          verificationGeneration: verification.verificationGeneration,
          observationSetDigest: verification.observationSetDigest,
          verifierVersion: verification.verifierVersion,
          status: verification.status,
          confidence: verification.confidence.toFixed(4),
          reason: verification.reason,
          verifiedAt: verification.verifiedAt,
        })
        .onConflictDoNothing()
        .returning();

      if (insertedRows.length > 0) {
        for (let i = 0; i < observationIds.length; i++) {
          await tx.insert(resultVerificationObservations).values({
            verificationId: verification.verificationId,
            observationId: observationIds[i],
            ordinal: i,
          });
        }

        return {
          isReplay: false,
          verification: decodeResultVerificationRow(insertedRows[0]),
        };
      }

      // Conflict: find existing
      const existing =
        (await this.findVerificationById(tx, verification.verificationId)) ??
        (await this.findVerificationByExecutionAndGeneration(
          tx,
          verification.executionId,
          verification.verificationGeneration,
        )) ??
        (await this.findVerificationByDigestAndVersion(
          tx,
          verification.executionId,
          verification.observationSetDigest,
          verification.verifierVersion,
        ));

      if (!existing) {
        throw PersistenceError.invalidPersistedState(
          `Failed to find existing result verification "${verification.verificationId}".`,
        );
      }

      const existingObsIds = await this.findObservationIdsForVerification(
        tx,
        existing.verificationId,
      );
      const existingHash = verificationContentHash(existing, existingObsIds);

      if (incomingHash !== existingHash) {
        throw PersistenceError.idempotencyConflict(
          `Result verification for execution "${verification.executionId}" and generation ${verification.verificationGeneration} already exists with different contents.`,
          {
            verificationId: verification.verificationId,
            incomingHash,
            existingHash,
          },
        );
      }

      return {
        isReplay: true,
        verification: existing,
      };
    });
  }
}

export const verificationRepository = new VerificationRepository();
