import { and, eq, inArray } from "drizzle-orm";

import type { PersistedEvidence } from "../../contracts/persisted-evidence";
import { PersistenceError } from "../errors/persistence-errors";
import { evidenceRecords } from "../schema/decisions";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeEvidenceRow } from "../utils/row-mappers";

function evidenceContentHash(evidence: PersistedEvidence): string {
  return createCanonicalFingerprint({
    source: evidence.source,
    sourceId: evidence.sourceId,
    claim: evidence.claim,
    observedAt: evidence.observedAt,
    providerMetadata: evidence.providerMetadata ?? null,
  });
}

export class EvidenceRepository {
  async findEvidenceById(
    executor: DatabaseExecutor,
    evidenceId: string,
  ): Promise<PersistedEvidence | null> {
    const rows = await executor
      .select()
      .from(evidenceRecords)
      .where(eq(evidenceRecords.evidenceId, evidenceId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeEvidenceRow(rows[0]);
  }

  async findEvidenceBySourceAndSourceId(
    executor: DatabaseExecutor,
    source: string,
    sourceId: string,
  ): Promise<PersistedEvidence | null> {
    const rows = await executor
      .select()
      .from(evidenceRecords)
      .where(
        and(
          eq(evidenceRecords.source, source),
          eq(evidenceRecords.sourceId, sourceId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeEvidenceRow(rows[0]);
  }

  async findManyEvidenceByIds(
    executor: DatabaseExecutor,
    evidenceIds: readonly string[],
  ): Promise<PersistedEvidence[]> {
    if (evidenceIds.length === 0) {
      return [];
    }

    const rows = await executor
      .select()
      .from(evidenceRecords)
      .where(inArray(evidenceRecords.evidenceId, evidenceIds as string[]));

    return rows.map((r) => decodeEvidenceRow(r));
  }

  async appendEvidence(
    executor: DatabaseExecutor,
    evidence: PersistedEvidence,
  ): Promise<{ isReplay: boolean; evidence: PersistedEvidence }> {
    const incomingHash = evidenceContentHash(evidence);

    const insertedRows = await executor
      .insert(evidenceRecords)
      .values({
        evidenceId: evidence.evidenceId,
        source: evidence.source,
        sourceId: evidence.sourceId,
        claim: evidence.claim,
        observedAt: evidence.observedAt,
        createdAt: evidence.createdAt,
        providerMetadata: evidence.providerMetadata ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows.length > 0) {
      return {
        isReplay: false,
        evidence: decodeEvidenceRow(insertedRows[0]),
      };
    }

    // Conflict encountered: check existing row
    const existing = await this.findEvidenceById(executor, evidence.evidenceId);

    if (!existing) {
      throw PersistenceError.invalidPersistedState(
        `Failed to insert or find existing evidence with ID "${evidence.evidenceId}".`,
      );
    }

    const existingHash = evidenceContentHash(existing);

    if (incomingHash !== existingHash) {
      throw PersistenceError.idempotencyConflict(
        `Evidence with ID "${evidence.evidenceId}" already exists with different contents.`,
        {
          evidenceId: evidence.evidenceId,
          incomingHash,
          existingHash,
        },
      );
    }

    return {
      isReplay: true,
      evidence: existing,
    };
  }
}

export const evidenceRepository = new EvidenceRepository();
