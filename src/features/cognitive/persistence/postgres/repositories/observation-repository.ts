import { and, eq } from "drizzle-orm";

import type { PersistedObservation } from "../../contracts/persisted-observation";
import { PersistenceError } from "../errors/persistence-errors";
import { observations } from "../schema/audit";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeObservationRow } from "../utils/row-mappers";

function observationContentHash(obs: PersistedObservation): string {
  return createCanonicalFingerprint({
    executionId: obs.executionId,
    stepId: obs.stepId ?? null,
    source: obs.source,
    sourceEventId: obs.sourceEventId ?? null,
    summary: obs.summary,
    data: obs.data,
    observedAt: obs.observedAt,
  });
}

export class ObservationRepository {
  async findObservationById(
    executor: DatabaseExecutor,
    observationId: string,
  ): Promise<PersistedObservation | null> {
    const rows = await executor
      .select()
      .from(observations)
      .where(eq(observations.observationId, observationId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeObservationRow(rows[0]);
  }

  async findObservationBySourceEvent(
    executor: DatabaseExecutor,
    executionId: string,
    source: string,
    sourceEventId: string,
  ): Promise<PersistedObservation | null> {
    const rows = await executor
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.executionId, executionId),
          eq(observations.source, source),
          eq(observations.sourceEventId, sourceEventId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeObservationRow(rows[0]);
  }

  async findManyObservationsByExecutionId(
    executor: DatabaseExecutor,
    executionId: string,
  ): Promise<PersistedObservation[]> {
    const rows = await executor
      .select()
      .from(observations)
      .where(eq(observations.executionId, executionId));

    return rows.map((r) => decodeObservationRow(r));
  }

  async appendObservation(
    executor: DatabaseExecutor,
    observation: PersistedObservation,
  ): Promise<{ isReplay: boolean; observation: PersistedObservation }> {
    const incomingHash = observationContentHash(observation);

    const insertedRows = await executor
      .insert(observations)
      .values({
        observationId: observation.observationId,
        executionId: observation.executionId,
        stepId: observation.stepId ?? null,
        source: observation.source,
        sourceEventId: observation.sourceEventId ?? null,
        summary: observation.summary,
        data: observation.data,
        observedAt: observation.observedAt,
        payloadExpiresAt: observation.payloadExpiresAt ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows.length > 0) {
      return {
        isReplay: false,
        observation: decodeObservationRow(insertedRows[0]),
      };
    }

    // Conflict: find existing
    let existing: PersistedObservation | null = null;
    if (observation.sourceEventId) {
      existing = await this.findObservationBySourceEvent(
        executor,
        observation.executionId,
        observation.source,
        observation.sourceEventId,
      );
    }
    if (!existing) {
      existing = await this.findObservationById(
        executor,
        observation.observationId,
      );
    }

    if (!existing) {
      throw PersistenceError.invalidPersistedState(
        `Failed to find existing observation "${observation.observationId}".`,
      );
    }

    const existingHash = observationContentHash(existing);

    if (incomingHash !== existingHash) {
      throw PersistenceError.idempotencyConflict(
        `Observation for execution "${observation.executionId}" already exists with different contents.`,
        {
          observationId: observation.observationId,
          incomingHash,
          existingHash,
        },
      );
    }

    return {
      isReplay: true,
      observation: existing,
    };
  }
}

export const observationRepository = new ObservationRepository();
