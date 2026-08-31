import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";

import type { CognitivePhase } from "../../../domain/types";
import type { PersistedCognitiveSession } from "../../contracts/cognitive-session";
import { PersistenceError } from "../errors/persistence-errors";
import { cognitiveSessions } from "../schema/cognitive";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { decodeCognitiveSessionRow } from "../utils/row-mappers";

export interface SessionTransitionParams {
  readonly sessionId: string;
  readonly expectedRowVersion: number;
  readonly expectedPhase?: CognitivePhase;
  readonly expectedCandidateId?: string | null;
  readonly nextSessionState: {
    readonly phase: CognitivePhase;
    readonly failureCount: number;
    readonly retryCount: number;
    readonly maxRetries: number;
    readonly evaluationGeneration?: number;
    readonly cooldownUntil: string | null;
    readonly currentCandidateId?: string | null;
    readonly currentPlanId?: string | null;
    readonly currentExecutionId?: string | null;
    readonly updatedAt: string;
  };
}

export class SessionRepository {
  async findSessionById(
    executor: DatabaseExecutor,
    sessionId: string,
  ): Promise<PersistedCognitiveSession | null> {
    const rows = await executor
      .select()
      .from(cognitiveSessions)
      .where(eq(cognitiveSessions.sessionId, sessionId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeCognitiveSessionRow(rows[0]);
  }

  async findSessionByIdForUpdate(
    executor: DatabaseExecutor,
    sessionId: string,
  ): Promise<PersistedCognitiveSession | null> {
    const rows = await executor
      .select()
      .from(cognitiveSessions)
      .where(eq(cognitiveSessions.sessionId, sessionId))
      .for("update")
      .limit(1);

    return rows.length === 0 ? null : decodeCognitiveSessionRow(rows[0]);
  }

  async findSessionByCueId(
    executor: DatabaseExecutor,
    cueId: string,
  ): Promise<PersistedCognitiveSession | null> {
    const rows = await executor
      .select()
      .from(cognitiveSessions)
      .where(eq(cognitiveSessions.cueId, cueId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeCognitiveSessionRow(rows[0]);
  }

  async findCooldownSessionsReadyToResume(
    executor: DatabaseExecutor,
    now: string,
    limit = 50,
  ): Promise<PersistedCognitiveSession[]> {
    const rows = await executor
      .select()
      .from(cognitiveSessions)
      .where(
        and(
          eq(cognitiveSessions.phase, "COOLDOWN"),
          isNotNull(cognitiveSessions.cooldownUntil),
          lte(cognitiveSessions.cooldownUntil, now),
        ),
      )
      .orderBy(
        asc(cognitiveSessions.cooldownUntil),
        asc(cognitiveSessions.sessionId),
      )
      .limit(limit);

    return rows.map((r) => decodeCognitiveSessionRow(r));
  }

  async findSessionsByPhase(
    executor: DatabaseExecutor,
    phase: CognitivePhase,
    limit = 50,
  ): Promise<PersistedCognitiveSession[]> {
    const rows = await executor
      .select()
      .from(cognitiveSessions)
      .where(eq(cognitiveSessions.phase, phase))
      .orderBy(
        asc(cognitiveSessions.updatedAt),
        asc(cognitiveSessions.sessionId),
      )
      .limit(limit);

    return rows.map((r) => decodeCognitiveSessionRow(r));
  }

  async createSession(
    executor: DatabaseExecutor,
    session: PersistedCognitiveSession,
  ): Promise<PersistedCognitiveSession> {
    const insertedRows = await executor
      .insert(cognitiveSessions)
      .values({
        sessionId: session.sessionId,
        cueId: session.cueId,
        phase: session.phase,
        failureCount: session.failureCount,
        retryCount: session.retryCount,
        maxRetries: session.maxRetries,
        evaluationGeneration: session.evaluationGeneration,
        cooldownUntil: session.cooldownUntil,
        currentCandidateId: session.currentCandidateId,
        currentPlanId: session.currentPlanId,
        currentExecutionId: session.currentExecutionId,
        rowVersion: session.rowVersion,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .returning();

    return decodeCognitiveSessionRow(insertedRows[0]);
  }

  async transitionSession(
    executor: DatabaseExecutor,
    params: SessionTransitionParams,
  ): Promise<PersistedCognitiveSession> {
    const conditions = [
      eq(cognitiveSessions.sessionId, params.sessionId),
      eq(cognitiveSessions.rowVersion, params.expectedRowVersion),
    ];

    if (params.expectedPhase) {
      conditions.push(eq(cognitiveSessions.phase, params.expectedPhase));
    }

    if (params.expectedCandidateId !== undefined) {
      if (params.expectedCandidateId === null) {
        conditions.push(isNull(cognitiveSessions.currentCandidateId));
      } else {
        conditions.push(
          eq(cognitiveSessions.currentCandidateId, params.expectedCandidateId),
        );
      }
    }

    const updateValues: Record<string, unknown> = {
      phase: params.nextSessionState.phase,
      failureCount: params.nextSessionState.failureCount,
      retryCount: params.nextSessionState.retryCount,
      maxRetries: params.nextSessionState.maxRetries,
      cooldownUntil: params.nextSessionState.cooldownUntil ?? null,
      currentCandidateId: params.nextSessionState.currentCandidateId ?? null,
      currentPlanId: params.nextSessionState.currentPlanId ?? null,
      currentExecutionId: params.nextSessionState.currentExecutionId ?? null,
      rowVersion: params.expectedRowVersion + 1,
      updatedAt: params.nextSessionState.updatedAt,
    };

    if (params.nextSessionState.evaluationGeneration !== undefined) {
      updateValues.evaluationGeneration =
        params.nextSessionState.evaluationGeneration;
    }

    const updatedRows = await executor
      .update(cognitiveSessions)
      .set(updateValues)
      .where(and(...conditions))
      .returning();

    if (updatedRows.length === 0) {
      throw PersistenceError.staleWrite(
        `Cognitive session "${params.sessionId}" could not be updated at expected row_version ${params.expectedRowVersion}.`,
        {
          sessionId: params.sessionId,
          expectedRowVersion: params.expectedRowVersion,
        },
      );
    }

    return decodeCognitiveSessionRow(updatedRows[0]);
  }
}

export const sessionRepository = new SessionRepository();
