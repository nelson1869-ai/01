import type { PersistedRewardEvent } from "../persistence/contracts/reward-event";
import {
  type ApplyVerificationRewardCommand,
  applyVerificationRewardCommandSchema,
} from "../persistence/contracts/reward-commands";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import {
  calculateLearningConfidence,
  learningRepository,
  type PersistedLearningState,
} from "../persistence/postgres/repositories/learning-repository";
import { rewardRepository } from "../persistence/postgres/repositories/reward-repository";
import { verificationRepository } from "../persistence/postgres/repositories/verification-repository";
import {
  type DatabaseClient,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";

export interface ApplyVerificationRewardResult {
  readonly isReplay: boolean;
  readonly reward: PersistedRewardEvent;
  readonly learningState: PersistedLearningState;
}

export async function applyVerificationReward(
  db: DatabaseClient,
  rawCommand: ApplyVerificationRewardCommand,
): Promise<ApplyVerificationRewardResult> {
  const parsed = applyVerificationRewardCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid apply verification reward command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;

  return await runInTransaction(db, async (tx) => {
    // 1. Load verification and validate execution binding
    const verification = await verificationRepository.findVerificationById(
      tx,
      command.verificationId,
    );
    if (!verification) {
      throw PersistenceError.notFound(
        `Verification "${command.verificationId}" was not found for reward event.`,
      );
    }

    if (verification.executionId !== command.executionId) {
      throw PersistenceError.stateConflict(
        `Cross-execution reward binding rejected: verification "${command.verificationId}" belongs to execution "${verification.executionId}", not "${command.executionId}".`,
      );
    }

    // 2. Command idempotency claim
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "apply-verification-reward",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash: createCanonicalFingerprint({
        commandIdempotencyKey: command.commandIdempotencyKey,
        rewardEventId: command.rewardEventId,
        executionId: command.executionId,
        verificationId: command.verificationId,
        rewardRuleId: command.rewardRuleId,
        signal: command.signal,
        value: command.value,
        skillKey: command.skillKey,
        reason: command.reason,
        createdAt: command.createdAt,
      }),
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    });

    if (claim.isReplay) {
      const existingReward = await rewardRepository.findRewardById(
        tx,
        command.rewardEventId,
      );
      const existingLearning = await learningRepository.findLearningState(
        tx,
        command.skillKey,
      );

      if (!existingReward || !existingLearning) {
        throw PersistenceError.invalidPersistedState(
          "Completed reward replay is missing its durable records.",
        );
      }

      return {
        isReplay: true,
        reward: existingReward,
        learningState: existingLearning,
      };
    }

    // 3. Append reward event to immutable ledger
    const appendResult = await rewardRepository.appendReward(tx, {
      rewardEventId: command.rewardEventId,
      executionId: command.executionId,
      verificationId: command.verificationId,
      rewardRuleId: command.rewardRuleId,
      rewardIdempotencyKey: command.commandIdempotencyKey,
      signal: command.signal,
      value: command.value,
      reason: command.reason,
      createdAt: command.createdAt,
    });

    // 4. If reward was already recorded under (verificationId, rewardRuleId), do NOT double-learn
    if (appendResult.isReplay) {
      const currentLearning =
        await learningRepository.getOrInitializeLearningState(
          tx,
          command.skillKey,
          command.createdAt,
        );

      await idempotencyRepository.completeCommand(tx, {
        scope: "apply-verification-reward",
        idempotencyKey: command.commandIdempotencyKey,
        resultResourceType: "reward_event",
        resultResourceId: command.rewardEventId,
        updatedAt: command.createdAt,
      });

      return {
        isReplay: true,
        reward: appendResult.reward,
        learningState: currentLearning,
      };
    }

    // 5. Fresh reward: apply atomic learning state projection
    const currentLearning =
      await learningRepository.getOrInitializeLearningState(
        tx,
        command.skillKey,
        command.createdAt,
      );

    const newTotalReward = currentLearning.totalReward + command.value;
    const newSampleCount = currentLearning.sampleCount + 1;
    const newConfidence = calculateLearningConfidence(
      newTotalReward,
      newSampleCount,
    );

    const updatedLearning = await learningRepository.updateLearningState(
      tx,
      {
        skillKey: command.skillKey,
        confidence: newConfidence,
        totalReward: newTotalReward,
        sampleCount: newSampleCount,
        rowVersion: currentLearning.rowVersion + 1,
        updatedAt: command.createdAt,
      },
      currentLearning.rowVersion,
    );

    await idempotencyRepository.completeCommand(tx, {
      scope: "apply-verification-reward",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "reward_event",
      resultResourceId: command.rewardEventId,
      updatedAt: command.createdAt,
    });

    return {
      isReplay: false,
      reward: appendResult.reward,
      learningState: updatedLearning,
    };
  });
}
