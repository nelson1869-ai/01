import { and, eq } from "drizzle-orm";

import { PersistenceError } from "../errors/persistence-errors";
import { idempotencyRecords } from "../schema/idempotency";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import {
  decodeIdempotencyRecordRow,
  type PersistedIdempotencyRecord,
} from "../utils/row-mappers";

export interface ClaimCommandParams {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string | null;
}

export interface CompleteCommandParams {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly resultResourceType?: string | null;
  readonly resultResourceId?: string | null;
  readonly updatedAt: string;
}

export interface FailCommandParams {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly errorCode: string;
  readonly updatedAt: string;
}

export class IdempotencyRepository {
  async findCommand(
    executor: DatabaseExecutor,
    scope: string,
    idempotencyKey: string,
  ): Promise<PersistedIdempotencyRecord | null> {
    const rows = await executor
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.scope, scope),
          eq(idempotencyRecords.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeIdempotencyRecordRow(rows[0]);
  }

  async claimCommand(
    executor: DatabaseExecutor,
    params: ClaimCommandParams,
  ): Promise<{ isReplay: boolean; record: PersistedIdempotencyRecord }> {
    const insertedRows = await executor
      .insert(idempotencyRecords)
      .values({
        scope: params.scope,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        status: "IN_PROGRESS",
        resultResourceType: null,
        resultResourceId: null,
        errorCode: null,
        createdAt: params.createdAt,
        updatedAt: params.updatedAt,
        expiresAt: params.expiresAt ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRows.length > 0) {
      return {
        isReplay: false,
        record: decodeIdempotencyRecordRow(insertedRows[0]),
      };
    }

    // Existing record: verify hash
    const existing = await this.findCommand(
      executor,
      params.scope,
      params.idempotencyKey,
    );

    if (!existing) {
      throw PersistenceError.invalidPersistedState(
        `Failed to claim or find idempotency record for scope "${params.scope}" and key "${params.idempotencyKey}".`,
      );
    }

    if (existing.requestHash !== params.requestHash) {
      throw PersistenceError.idempotencyConflict(
        `Idempotency key "${params.idempotencyKey}" under scope "${params.scope}" was previously used with a different request hash.`,
        {
          scope: params.scope,
          idempotencyKey: params.idempotencyKey,
          incomingHash: params.requestHash,
          existingHash: existing.requestHash,
        },
      );
    }

    return {
      isReplay: true,
      record: existing,
    };
  }

  async completeCommand(
    executor: DatabaseExecutor,
    params: CompleteCommandParams,
  ): Promise<void> {
    const updatedRows = await executor
      .update(idempotencyRecords)
      .set({
        status: "COMPLETED",
        resultResourceType: params.resultResourceType ?? null,
        resultResourceId: params.resultResourceId ?? null,
        updatedAt: params.updatedAt,
      })
      .where(
        and(
          eq(idempotencyRecords.scope, params.scope),
          eq(idempotencyRecords.idempotencyKey, params.idempotencyKey),
        ),
      )
      .returning();

    if (updatedRows.length === 0) {
      throw PersistenceError.invalidPersistedState(
        `Cannot complete non-existent idempotency record for scope "${params.scope}" and key "${params.idempotencyKey}".`,
      );
    }
  }

  async failCommand(
    executor: DatabaseExecutor,
    params: FailCommandParams,
  ): Promise<void> {
    await executor
      .update(idempotencyRecords)
      .set({
        status: "FAILED",
        errorCode: params.errorCode,
        updatedAt: params.updatedAt,
      })
      .where(
        and(
          eq(idempotencyRecords.scope, params.scope),
          eq(idempotencyRecords.idempotencyKey, params.idempotencyKey),
        ),
      );
  }
}

export const idempotencyRepository = new IdempotencyRepository();
