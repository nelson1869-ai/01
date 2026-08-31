import type {
  ResultVerifier,
  ResultVerifierOutput,
} from "../domain/verifier-contract";
import type { PersistedResultVerification } from "../persistence/contracts/result-verification";
import {
  type VerifyExecutionResultCommand,
  verifyExecutionResultCommandSchema,
} from "../persistence/contracts/result-verification-commands";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { executionRepository } from "../persistence/postgres/repositories/execution-repository";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import { observationRepository } from "../persistence/postgres/repositories/observation-repository";
import { verificationRepository } from "../persistence/postgres/repositories/verification-repository";
import {
  type DatabaseClient,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";
import { computeObservationSetDigest } from "../persistence/postgres/utils/observation-digest";

export interface VerifyExecutionResultResult {
  readonly isReplay: boolean;
  readonly verification: PersistedResultVerification;
  readonly verifierOutput: ResultVerifierOutput;
}

export async function verifyExecutionResult(
  db: DatabaseClient,
  verifier: ResultVerifier,
  rawCommand: VerifyExecutionResultCommand,
): Promise<VerifyExecutionResultResult> {
  const parsed = verifyExecutionResultCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid verify execution result command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;

  // 1. Load execution
  const execution = await executionRepository.findExecutionById(
    db,
    command.executionId,
  );
  if (!execution) {
    throw PersistenceError.notFound(
      `Execution "${command.executionId}" was not found for result verification.`,
    );
  }

  // 2. Load and validate referenced observations
  const observations = await observationRepository.findObservationsByIds(
    db,
    command.observationIds,
  );

  if (observations.length !== command.observationIds.length) {
    const loadedIds = new Set(observations.map((o) => o.observationId));
    const missingId = command.observationIds.find((id) => !loadedIds.has(id));
    throw PersistenceError.notFound(
      `Observation "${missingId}" was not found for execution "${command.executionId}".`,
    );
  }

  // 3. Strict Cross-Execution Evidence Binding Guard: Fail closed if any observation belongs to another execution
  for (const obs of observations) {
    if (obs.executionId !== command.executionId) {
      throw PersistenceError.stateConflict(
        `Cross-execution observation binding rejected: observation "${obs.observationId}" belongs to execution "${obs.executionId}", not "${command.executionId}".`,
      );
    }
  }

  // 4. Compute deterministic canonical observation set digest
  const observationSetDigest = computeObservationSetDigest(observations);

  // 5. Check verifier version consistency
  if (command.verifierVersion !== verifier.version) {
    throw PersistenceError.invalidPersistedState(
      `Verifier version mismatch: command specified "${command.verifierVersion}", but verifier instance is "${verifier.version}".`,
    );
  }

  // 6. Execute verifier evaluation OUTSIDE of any database transaction
  const verifierOutput = await verifier.verify({
    execution,
    observations,
    expectedResult: command.expectedResult ?? undefined,
  });

  // 7. Persist verification and observation links atomically in one transaction
  const sortedObservationIds = [...command.observationIds].sort();

  return await runInTransaction(db, async (tx) => {
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "verify-execution-result",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash: createCanonicalFingerprint({
        commandIdempotencyKey: command.commandIdempotencyKey,
        verificationId: command.verificationId,
        executionId: command.executionId,
        observationIds: sortedObservationIds,
        expectedVerificationGeneration: command.expectedVerificationGeneration,
        verifierVersion: command.verifierVersion,
        verifiedAt: command.verifiedAt,
        expectedResult: command.expectedResult ?? null,
      }),
      createdAt: command.verifiedAt,
      updatedAt: command.verifiedAt,
    });

    if (claim.isReplay) {
      const existing = await verificationRepository.findVerificationById(
        tx,
        command.verificationId,
      );
      if (claim.record.status !== "COMPLETED" || !existing) {
        throw PersistenceError.invalidPersistedState(
          "Completed verification replay is missing its durable record.",
        );
      }
      return {
        isReplay: true,
        verification: existing,
        verifierOutput: {
          status: existing.status as ResultVerifierOutput["status"],
          confidence: existing.confidence,
          reason: existing.reason,
          verifierVersion: existing.verifierVersion,
        },
      };
    }

    const appendResult = await verificationRepository.appendVerification(
      tx,
      {
        verificationId: command.verificationId,
        executionId: command.executionId,
        verificationGeneration: command.expectedVerificationGeneration,
        observationSetDigest,
        verifierVersion: command.verifierVersion,
        status: verifierOutput.status,
        confidence: verifierOutput.confidence,
        reason: verifierOutput.reason,
        verifiedAt: command.verifiedAt,
      },
      sortedObservationIds,
    );

    await idempotencyRepository.completeCommand(tx, {
      scope: "verify-execution-result",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "result_verification",
      resultResourceId: command.verificationId,
      updatedAt: command.verifiedAt,
    });

    return {
      isReplay: appendResult.isReplay,
      verification: appendResult.verification,
      verifierOutput,
    };
  });
}
