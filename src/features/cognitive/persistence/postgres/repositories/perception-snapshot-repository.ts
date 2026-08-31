import { and, eq } from "drizzle-orm";

import type { AuthoritativePerceptionSnapshot } from "../../contracts/authoritative-perception-snapshot";
import { authoritativePerceptionSnapshots } from "../schema/ingress";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { decodePerceptionSnapshotRow } from "../utils/row-mappers";

export class PerceptionSnapshotRepository {
  async findBySessionAndGeneration(
    executor: DatabaseExecutor,
    sessionId: string,
    generation: number,
  ): Promise<AuthoritativePerceptionSnapshot | null> {
    const rows = await executor
      .select()
      .from(authoritativePerceptionSnapshots)
      .where(
        and(
          eq(authoritativePerceptionSnapshots.sessionId, sessionId),
          eq(authoritativePerceptionSnapshots.evaluationGeneration, generation),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodePerceptionSnapshotRow(rows[0]);
  }

  async saveSnapshot(
    executor: DatabaseExecutor,
    snapshot: AuthoritativePerceptionSnapshot,
  ): Promise<AuthoritativePerceptionSnapshot> {
    const insertedRows = await executor
      .insert(authoritativePerceptionSnapshots)
      .values({
        snapshotId: snapshot.snapshotId,
        sessionId: snapshot.sessionId,
        cueId: snapshot.cueId,
        evaluationGeneration: snapshot.evaluationGeneration,
        summary: snapshot.summary,
        structuredFacts: snapshot.structuredFacts as Record<string, unknown>,
        targetSpec: snapshot.targetSpec as Record<string, unknown> | null,
        perceivedAt: snapshot.perceivedAt,
        createdAt: snapshot.createdAt,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows.length > 0) {
      return decodePerceptionSnapshotRow(insertedRows[0]);
    }

    const existing = await this.findBySessionAndGeneration(
      executor,
      snapshot.sessionId,
      snapshot.evaluationGeneration,
    );

    if (!existing) {
      throw new Error(
        `Failed to save or find perception snapshot for session "${snapshot.sessionId}" generation ${snapshot.evaluationGeneration}.`,
      );
    }

    return existing;
  }
}

export const perceptionSnapshotRepository = new PerceptionSnapshotRepository();
