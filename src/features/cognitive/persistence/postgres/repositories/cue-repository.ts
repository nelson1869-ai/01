import { and, eq } from "drizzle-orm";

import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import { PersistenceError } from "../errors/persistence-errors";
import { cues } from "../schema/ingress";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { computeCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeCueRow } from "../utils/row-mappers";

export class CueRepository {
  async findCueById(
    executor: DatabaseExecutor,
    cueId: string,
  ): Promise<PersistedCueIngress | null> {
    const rows = await executor
      .select()
      .from(cues)
      .where(eq(cues.cueId, cueId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeCueRow(rows[0]);
  }

  async findCueByExternalIdentity(
    executor: DatabaseExecutor,
    source: string,
    externalEventId: string,
  ): Promise<PersistedCueIngress | null> {
    const rows = await executor
      .select()
      .from(cues)
      .where(
        and(eq(cues.source, source), eq(cues.externalEventId, externalEventId)),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeCueRow(rows[0]);
  }

  async insertCue(
    executor: DatabaseExecutor,
    cue: PersistedCueIngress,
  ): Promise<{ isReplay: boolean; cue: PersistedCueIngress }> {
    const payloadHash = computeCanonicalFingerprint(cue.payload);

    const insertedRows = await executor
      .insert(cues)
      .values({
        cueId: cue.cueId,
        source: cue.source,
        externalEventId: cue.externalEventId,
        cueType: cue.type,
        occurredAt: cue.occurredAt,
        receivedAt: cue.receivedAt,
        payload: cue.payload,
        payloadHash,
      })
      .onConflictDoNothing({ target: [cues.source, cues.externalEventId] })
      .returning();

    if (insertedRows.length > 0) {
      return { isReplay: false, cue: decodeCueRow(insertedRows[0]) };
    }

    const existing = await this.findCueByExternalIdentity(
      executor,
      cue.source,
      cue.externalEventId,
    );

    if (existing !== null) {
      const existingFingerprint = computeCanonicalFingerprint(existing.payload);
      if (existingFingerprint === payloadHash && existing.type === cue.type) {
        return { isReplay: true, cue: existing };
      }

      throw PersistenceError.idempotencyConflict(
        `Cue with source "${cue.source}" and external event "${cue.externalEventId}" already exists with different payload or type.`,
        {
          source: cue.source,
          externalEventId: cue.externalEventId,
          existingCueId: existing.cueId,
        },
      );
    }

    throw PersistenceError.staleWrite(
      `Cue with source "${cue.source}" and external event "${cue.externalEventId}" conflicted but could not be retrieved.`,
      { source: cue.source, externalEventId: cue.externalEventId },
    );
  }
}

export const cueRepository = new CueRepository();
