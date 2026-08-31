import { and, eq, sql } from "drizzle-orm";

import { PersistenceError } from "../errors/persistence-errors";
import { learningState, rewardEvents } from "../schema/learning";
import type { DatabaseExecutor } from "../transactions/transaction-executor";

export interface PersistedLearningState {
  readonly skillKey: string;
  readonly confidence: number;
  readonly totalReward: number;
  readonly sampleCount: number;
  readonly rowVersion: number;
  readonly updatedAt: string;
}

export function calculateLearningConfidence(
  totalReward: number,
  sampleCount: number,
): number {
  if (sampleCount <= 0) {
    return 0.5;
  }
  // Deterministic bounded logistic curve:
  // c = 1 / (1 + exp(-totalReward / 20))
  // Clamped in [0.0001, 0.9999] and rounded to 4 decimals
  const raw = 1 / (1 + Math.exp(-totalReward / 20));
  const clamped = Math.min(0.9999, Math.max(0.0001, raw));
  return Number(clamped.toFixed(4));
}

function decodeLearningStateRow(row: {
  skillKey: string;
  confidence: string;
  totalReward: string;
  sampleCount: number;
  rowVersion: number;
  updatedAt: string;
}): PersistedLearningState {
  return {
    skillKey: row.skillKey,
    confidence: Number(row.confidence),
    totalReward: Number(row.totalReward),
    sampleCount: Number(row.sampleCount),
    rowVersion: Number(row.rowVersion),
    updatedAt: row.updatedAt,
  };
}

export class LearningRepository {
  async findLearningState(
    executor: DatabaseExecutor,
    skillKey: string,
  ): Promise<PersistedLearningState | null> {
    const rows = await executor
      .select()
      .from(learningState)
      .where(eq(learningState.skillKey, skillKey))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeLearningStateRow(rows[0]);
  }

  async getOrInitializeLearningState(
    executor: DatabaseExecutor,
    skillKey: string,
    now: string = new Date().toISOString(),
  ): Promise<PersistedLearningState> {
    const existing = await this.findLearningState(executor, skillKey);
    if (existing) {
      return existing;
    }

    const insertedRows = await executor
      .insert(learningState)
      .values({
        skillKey,
        confidence: "0.5000",
        totalReward: "0.0000",
        sampleCount: 0,
        rowVersion: 0,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows.length > 0) {
      return decodeLearningStateRow(insertedRows[0]);
    }

    const reloaded = await this.findLearningState(executor, skillKey);
    if (!reloaded) {
      throw PersistenceError.invalidPersistedState(
        `Failed to initialize or find learning state for skill "${skillKey}".`,
      );
    }
    return reloaded;
  }

  async updateLearningState(
    executor: DatabaseExecutor,
    state: PersistedLearningState,
    expectedRowVersion: number,
  ): Promise<PersistedLearningState> {
    const updatedRows = await executor
      .update(learningState)
      .set({
        confidence: state.confidence.toFixed(4),
        totalReward: state.totalReward.toFixed(4),
        sampleCount: state.sampleCount,
        rowVersion: expectedRowVersion + 1,
        updatedAt: state.updatedAt,
      })
      .where(
        and(
          eq(learningState.skillKey, state.skillKey),
          eq(learningState.rowVersion, expectedRowVersion),
        ),
      )
      .returning();

    if (updatedRows.length === 0) {
      throw PersistenceError.staleWrite(
        `Failed to update learning state for skill "${state.skillKey}" (expected row_version ${expectedRowVersion}).`,
        {
          skillKey: state.skillKey,
          expectedRowVersion,
        },
      );
    }

    return decodeLearningStateRow(updatedRows[0]);
  }

  async rebuildLearningStateFromRewards(
    executor: DatabaseExecutor,
    skillKey: string,
    now: string = new Date().toISOString(),
  ): Promise<PersistedLearningState> {
    const rows = await executor
      .select()
      .from(rewardEvents)
      .where(eq(rewardEvents.skillKey, skillKey));

    let rawTotal = 0;
    for (const r of rows) {
      rawTotal += Number(r.value);
    }
    const rawCount = rows.length;
    const confidence = calculateLearningConfidence(rawTotal, rawCount);

    const upsertedRows = await executor
      .insert(learningState)
      .values({
        skillKey,
        confidence: confidence.toFixed(4),
        totalReward: rawTotal.toFixed(4),
        sampleCount: rawCount,
        rowVersion: 0,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: learningState.skillKey,
        set: {
          confidence: confidence.toFixed(4),
          totalReward: rawTotal.toFixed(4),
          sampleCount: rawCount,
          rowVersion: sql`${learningState.rowVersion} + 1`,
          updatedAt: now,
        },
      })
      .returning();

    return decodeLearningStateRow(upsertedRows[0]);
  }
}

export const learningRepository = new LearningRepository();
