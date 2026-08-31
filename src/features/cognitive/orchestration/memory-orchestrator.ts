import {
  type AdmitVerifiedMemoryCommand,
  admitVerifiedMemoryCommandSchema,
  assertMemoryContentSecurity,
} from "../persistence/contracts/memory-commands";
import type { PersistedVerifiedMemory } from "../persistence/contracts/verified-memory";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { evidenceRepository } from "../persistence/postgres/repositories/evidence-repository";
import { idempotencyRepository } from "../persistence/postgres/repositories/idempotency-repository";
import { memoryRepository } from "../persistence/postgres/repositories/memory-repository";
import { verificationRepository } from "../persistence/postgres/repositories/verification-repository";
import {
  type DatabaseClient,
  runInTransaction,
} from "../persistence/postgres/transactions/transaction-executor";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";

export interface AdmitVerifiedMemoryResult {
  readonly isReplay: boolean;
  readonly memory: PersistedVerifiedMemory;
  readonly headRowVersion: number;
}

export async function admitVerifiedMemory(
  db: DatabaseClient,
  rawCommand: AdmitVerifiedMemoryCommand,
): Promise<AdmitVerifiedMemoryResult> {
  const parsed = admitVerifiedMemoryCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Invalid admit verified memory command.",
      { issues: parsed.error.issues },
    );
  }

  const command = parsed.data;

  // 1. Strict security boundary: reject credentials and working memory traces
  assertMemoryContentSecurity(command.content);

  return await runInTransaction(db, async (tx) => {
    // 2. Load verification and validate admission requirement
    const verification = await verificationRepository.findVerificationById(
      tx,
      command.verificationId,
    );
    if (!verification) {
      throw PersistenceError.notFound(
        `Verification "${command.verificationId}" was not found for memory admission.`,
      );
    }

    // Strict admission requirement: ONLY VERIFIED status may admit verified memory
    if (verification.status !== "VERIFIED") {
      throw PersistenceError.stateConflict(
        `Cannot admit verified memory: verification "${command.verificationId}" has status "${verification.status}". Only VERIFIED execution results can create verified memory.`,
      );
    }

    // 3. Validate execution binding
    if (verification.executionId !== command.executionId) {
      throw PersistenceError.stateConflict(
        `Cross-execution memory admission rejected: verification "${command.verificationId}" belongs to execution "${verification.executionId}", not "${command.executionId}".`,
      );
    }

    // 4. Validate source evidence records exist
    const evidenceRecordsList = await evidenceRepository.findManyEvidenceByIds(
      tx,
      command.sourceIds,
    );
    if (evidenceRecordsList.length !== command.sourceIds.length) {
      const foundIds = new Set(evidenceRecordsList.map((e) => e.evidenceId));
      const missingId = command.sourceIds.find((id) => !foundIds.has(id));
      throw PersistenceError.notFound(
        `Evidence record "${missingId}" was not found for memory provenance.`,
      );
    }

    // 5. Version and head invariant validation
    const existingHead = await memoryRepository.findMemoryHead(
      tx,
      command.kind,
      command.key,
    );

    let supersedesMemoryId: string | null = null;
    if (!existingHead) {
      if (command.version !== 1) {
        throw PersistenceError.stateConflict(
          `Initial version for new memory "${command.kind}:${command.key}" must be 1 (received version ${command.version}).`,
        );
      }
    } else {
      if (command.version < existingHead.memoryVersion) {
        throw PersistenceError.stateConflict(
          `Cannot move memory head backward: attempted version ${command.version}, current head is ${existingHead.memoryVersion}.`,
        );
      }

      if (command.version === existingHead.memoryVersion) {
        // May be an idempotent replay of current head version
        supersedesMemoryId = null;
      } else if (command.version === existingHead.memoryVersion + 1) {
        supersedesMemoryId = existingHead.memoryId;
      } else {
        throw PersistenceError.stateConflict(
          `Version gap rejected: memory "${command.kind}:${command.key}" current head is ${existingHead.memoryVersion}, next version must be ${existingHead.memoryVersion + 1} (received ${command.version}).`,
        );
      }
    }

    // 6. Command idempotency claim
    const sortedSourceIds = [...command.sourceIds].sort();
    const claim = await idempotencyRepository.claimCommand(tx, {
      scope: "admit-verified-memory",
      idempotencyKey: command.commandIdempotencyKey,
      requestHash: createCanonicalFingerprint({
        commandIdempotencyKey: command.commandIdempotencyKey,
        memoryId: command.memoryId,
        executionId: command.executionId,
        verificationId: command.verificationId,
        kind: command.kind,
        key: command.key,
        version: command.version,
        content: command.content,
        sourceIds: sortedSourceIds,
        confidence: command.confidence,
        admissionRuleVersion: command.admissionRuleVersion,
        verifiedAt: command.verifiedAt,
        createdAt: command.createdAt,
      }),
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    });

    if (claim.isReplay) {
      const existing = await memoryRepository.findMemoryById(
        tx,
        command.memoryId,
      );
      if (!existing) {
        throw PersistenceError.invalidPersistedState(
          "Completed memory replay is missing its durable record.",
        );
      }
      return {
        isReplay: true,
        memory: existing,
        headRowVersion: existingHead?.rowVersion ?? 0,
      };
    }

    // 7. Append immutable memory version and conditionally advance head
    const appendResult = await memoryRepository.appendVerifiedMemoryVersion(
      tx,
      {
        memoryId: command.memoryId,
        kind: command.kind,
        key: command.key,
        version: command.version,
        content: command.content,
        sourceIds: sortedSourceIds,
        confidence: command.confidence,
        admissionRuleVersion: command.admissionRuleVersion,
        supersedesMemoryId,
        verificationId: command.verificationId,
        verifiedAt: command.verifiedAt,
        createdAt: command.createdAt,
      },
      {
        advanceHead: true,
        expectedHeadRowVersion: existingHead?.rowVersion,
      },
    );

    await idempotencyRepository.completeCommand(tx, {
      scope: "admit-verified-memory",
      idempotencyKey: command.commandIdempotencyKey,
      resultResourceType: "verified_memory",
      resultResourceId: command.memoryId,
      updatedAt: command.createdAt,
    });

    return {
      isReplay: appendResult.isReplay,
      memory: appendResult.memory,
      headRowVersion: appendResult.headRowVersion,
    };
  });
}
