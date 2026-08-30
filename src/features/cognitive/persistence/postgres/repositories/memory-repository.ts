import { and, eq } from "drizzle-orm";

import type { PersistedVerifiedMemory } from "../../contracts/verified-memory";
import { PersistenceError } from "../errors/persistence-errors";
import {
  verifiedMemory,
  verifiedMemoryHeads,
  verifiedMemorySources,
} from "../schema/memory";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeVerifiedMemoryRow } from "../utils/row-mappers";

function memoryContentHash(m: PersistedVerifiedMemory): string {
  return createCanonicalFingerprint({
    kind: m.kind,
    key: m.key,
    version: m.version,
    content: m.content,
    sourceIds: [...m.sourceIds].sort(),
    confidence: m.confidence,
    admissionRuleVersion: m.admissionRuleVersion,
    supersedesMemoryId: m.supersedesMemoryId ?? null,
  });
}

export interface AppendVerifiedMemoryOptions {
  readonly advanceHead?: boolean;
  readonly expectedHeadRowVersion?: number;
}

export class MemoryRepository {
  async findMemoryById(
    executor: DatabaseExecutor,
    memoryId: string,
  ): Promise<PersistedVerifiedMemory | null> {
    const rows = await executor
      .select()
      .from(verifiedMemory)
      .where(eq(verifiedMemory.memoryId, memoryId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const sourceRows = await executor
      .select({ evidenceId: verifiedMemorySources.evidenceId })
      .from(verifiedMemorySources)
      .where(eq(verifiedMemorySources.memoryId, memoryId));

    const sourceIds = sourceRows.map((r) => r.evidenceId);

    return decodeVerifiedMemoryRow(rows[0], sourceIds);
  }

  async findMemoryByKindKeyAndVersion(
    executor: DatabaseExecutor,
    kind: string,
    memoryKey: string,
    memoryVersion: number,
  ): Promise<PersistedVerifiedMemory | null> {
    const rows = await executor
      .select()
      .from(verifiedMemory)
      .where(
        and(
          eq(verifiedMemory.kind, kind),
          eq(verifiedMemory.memoryKey, memoryKey),
          eq(verifiedMemory.memoryVersion, memoryVersion),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const sourceRows = await executor
      .select({ evidenceId: verifiedMemorySources.evidenceId })
      .from(verifiedMemorySources)
      .where(eq(verifiedMemorySources.memoryId, rows[0].memoryId));

    const sourceIds = sourceRows.map((r) => r.evidenceId);

    return decodeVerifiedMemoryRow(rows[0], sourceIds);
  }

  async findMemoryHead(
    executor: DatabaseExecutor,
    kind: string,
    memoryKey: string,
  ): Promise<{
    memoryId: string;
    memoryVersion: number;
    rowVersion: number;
    updatedAt: string;
  } | null> {
    const rows = await executor
      .select()
      .from(verifiedMemoryHeads)
      .where(
        and(
          eq(verifiedMemoryHeads.kind, kind),
          eq(verifiedMemoryHeads.memoryKey, memoryKey),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return {
      memoryId: rows[0].memoryId,
      memoryVersion: rows[0].memoryVersion,
      rowVersion: rows[0].rowVersion,
      updatedAt: rows[0].updatedAt,
    };
  }

  async appendVerifiedMemoryVersion(
    executor: DatabaseExecutor,
    memory: PersistedVerifiedMemory,
    options: AppendVerifiedMemoryOptions = {},
  ): Promise<{
    isReplay: boolean;
    memory: PersistedVerifiedMemory;
    headRowVersion: number;
  }> {
    const incomingHash = memoryContentHash(memory);
    const shouldAdvanceHead = options.advanceHead !== false;

    return await runInTransaction(executor, async (tx) => {
      const insertedRows = await tx
        .insert(verifiedMemory)
        .values({
          memoryId: memory.memoryId,
          kind: memory.kind,
          memoryKey: memory.key,
          memoryVersion: memory.version,
          content: memory.content as Record<string, unknown>,
          confidence: memory.confidence.toFixed(4),
          admissionRuleVersion: memory.admissionRuleVersion,
          supersedesMemoryId: memory.supersedesMemoryId ?? null,
          verifiedAt: memory.verifiedAt,
          createdAt: memory.createdAt,
        })
        .onConflictDoNothing()
        .returning();

      let isReplay = false;
      let persistedMem: PersistedVerifiedMemory;

      if (insertedRows.length > 0) {
        for (const evidenceId of memory.sourceIds) {
          await tx.insert(verifiedMemorySources).values({
            memoryId: memory.memoryId,
            evidenceId,
          });
        }
        persistedMem = decodeVerifiedMemoryRow(
          insertedRows[0],
          memory.sourceIds,
        );
      } else {
        // Conflict
        const existing =
          (await this.findMemoryById(tx, memory.memoryId)) ??
          (await this.findMemoryByKindKeyAndVersion(
            tx,
            memory.kind,
            memory.key,
            memory.version,
          ));

        if (!existing) {
          throw PersistenceError.invalidPersistedState(
            `Failed to find existing verified memory "${memory.memoryId}".`,
          );
        }

        const existingHash = memoryContentHash(existing);

        if (incomingHash !== existingHash) {
          throw PersistenceError.idempotencyConflict(
            `Verified memory for kind "${memory.kind}", key "${memory.key}", version ${memory.version} already exists with different contents.`,
            {
              memoryId: memory.memoryId,
              incomingHash,
              existingHash,
            },
          );
        }

        isReplay = true;
        persistedMem = existing;
      }

      let currentHeadRowVersion = 0;

      if (shouldAdvanceHead) {
        const existingHead = await this.findMemoryHead(
          tx,
          memory.kind,
          memory.key,
        );

        if (!existingHead) {
          // First version head
          const headInserted = await tx
            .insert(verifiedMemoryHeads)
            .values({
              kind: memory.kind,
              memoryKey: memory.key,
              memoryId: persistedMem.memoryId,
              memoryVersion: persistedMem.version,
              rowVersion: 0,
              updatedAt: memory.createdAt,
            })
            .onConflictDoNothing()
            .returning();

          if (headInserted.length === 0) {
            throw PersistenceError.staleWrite(
              `Concurrent creation of memory head for kind "${memory.kind}" and key "${memory.key}".`,
              { kind: memory.kind, memoryKey: memory.key },
            );
          }

          currentHeadRowVersion = 0;
        } else {
          // Existing head update with CAS
          if (
            options.expectedHeadRowVersion !== undefined &&
            existingHead.rowVersion !== options.expectedHeadRowVersion
          ) {
            throw PersistenceError.staleWrite(
              `Memory head for kind "${memory.kind}" and key "${memory.key}" row_version mismatch (expected ${options.expectedHeadRowVersion}, found ${existingHead.rowVersion}).`,
              {
                kind: memory.kind,
                memoryKey: memory.key,
                expected: options.expectedHeadRowVersion,
                actual: existingHead.rowVersion,
              },
            );
          }

          if (persistedMem.version < existingHead.memoryVersion) {
            throw PersistenceError.stateConflict(
              `Cannot advance memory head to older version ${persistedMem.version} (current head version is ${existingHead.memoryVersion}).`,
              {
                kind: memory.kind,
                memoryKey: memory.key,
                targetVersion: persistedMem.version,
                currentHeadVersion: existingHead.memoryVersion,
              },
            );
          }

          if (persistedMem.version === existingHead.memoryVersion) {
            // Already at head version
            currentHeadRowVersion = existingHead.rowVersion;
          } else {
            const updatedRows = await tx
              .update(verifiedMemoryHeads)
              .set({
                memoryId: persistedMem.memoryId,
                memoryVersion: persistedMem.version,
                rowVersion: existingHead.rowVersion + 1,
                updatedAt: memory.createdAt,
              })
              .where(
                and(
                  eq(verifiedMemoryHeads.kind, memory.kind),
                  eq(verifiedMemoryHeads.memoryKey, memory.key),
                  eq(verifiedMemoryHeads.rowVersion, existingHead.rowVersion),
                ),
              )
              .returning();

            if (updatedRows.length === 0) {
              throw PersistenceError.staleWrite(
                `Failed to advance memory head for kind "${memory.kind}" and key "${memory.key}" due to concurrent update.`,
                { kind: memory.kind, memoryKey: memory.key },
              );
            }

            currentHeadRowVersion = updatedRows[0].rowVersion;
          }
        }
      }

      return {
        isReplay,
        memory: persistedMem,
        headRowVersion: currentHeadRowVersion,
      };
    });
  }
}

export const memoryRepository = new MemoryRepository();
