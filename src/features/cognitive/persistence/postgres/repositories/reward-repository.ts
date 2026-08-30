import { and, eq } from "drizzle-orm";

import type { PersistedRewardEvent } from "../../contracts/reward-event";
import { PersistenceError } from "../errors/persistence-errors";
import { rewardEvents } from "../schema/learning";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeRewardEventRow } from "../utils/row-mappers";

function rewardContentHash(r: PersistedRewardEvent): string {
  return createCanonicalFingerprint({
    executionId: r.executionId,
    verificationId: r.verificationId,
    rewardRuleId: r.rewardRuleId,
    rewardIdempotencyKey: r.rewardIdempotencyKey,
    signal: r.signal,
    value: r.value,
    reason: r.reason,
  });
}

export class RewardRepository {
  async findRewardById(
    executor: DatabaseExecutor,
    rewardEventId: string,
  ): Promise<PersistedRewardEvent | null> {
    const rows = await executor
      .select()
      .from(rewardEvents)
      .where(eq(rewardEvents.rewardEventId, rewardEventId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeRewardEventRow(rows[0]);
  }

  async findRewardByIdempotencyKey(
    executor: DatabaseExecutor,
    idempotencyKey: string,
  ): Promise<PersistedRewardEvent | null> {
    const rows = await executor
      .select()
      .from(rewardEvents)
      .where(eq(rewardEvents.rewardIdempotencyKey, idempotencyKey))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeRewardEventRow(rows[0]);
  }

  async findRewardByVerificationAndRule(
    executor: DatabaseExecutor,
    verificationId: string,
    rewardRuleId: string,
  ): Promise<PersistedRewardEvent | null> {
    const rows = await executor
      .select()
      .from(rewardEvents)
      .where(
        and(
          eq(rewardEvents.verificationId, verificationId),
          eq(rewardEvents.rewardRuleId, rewardRuleId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeRewardEventRow(rows[0]);
  }

  async appendReward(
    executor: DatabaseExecutor,
    reward: PersistedRewardEvent,
  ): Promise<{ isReplay: boolean; reward: PersistedRewardEvent }> {
    const incomingHash = rewardContentHash(reward);

    const insertedRows = await executor
      .insert(rewardEvents)
      .values({
        rewardEventId: reward.rewardEventId,
        executionId: reward.executionId,
        verificationId: reward.verificationId,
        rewardRuleId: reward.rewardRuleId,
        rewardIdempotencyKey: reward.rewardIdempotencyKey,
        signal: reward.signal,
        value: reward.value.toFixed(4),
        reason: reward.reason,
        createdAt: reward.createdAt,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows.length > 0) {
      return {
        isReplay: false,
        reward: decodeRewardEventRow(insertedRows[0]),
      };
    }

    // Conflict: find existing
    const existing =
      (await this.findRewardById(executor, reward.rewardEventId)) ??
      (await this.findRewardByIdempotencyKey(
        executor,
        reward.rewardIdempotencyKey,
      )) ??
      (await this.findRewardByVerificationAndRule(
        executor,
        reward.verificationId,
        reward.rewardRuleId,
      ));

    if (!existing) {
      throw PersistenceError.invalidPersistedState(
        `Failed to find existing reward "${reward.rewardEventId}".`,
      );
    }

    const existingHash = rewardContentHash(existing);

    if (incomingHash !== existingHash) {
      throw PersistenceError.idempotencyConflict(
        `Reward for verification "${reward.verificationId}" and rule "${reward.rewardRuleId}" already exists with different contents.`,
        {
          rewardEventId: reward.rewardEventId,
          incomingHash,
          existingHash,
        },
      );
    }

    return {
      isReplay: true,
      reward: existing,
    };
  }
}

export const rewardRepository = new RewardRepository();
