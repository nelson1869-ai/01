import { randomUUID } from "node:crypto";

import { and, eq, or } from "drizzle-orm";

import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import type { SafetyTransitionCommand } from "../../contracts/transition-commands";
import { PersistenceError } from "../errors/persistence-errors";
import { executionSafetyEvents, executionSafetyState } from "../schema/safety";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { decodeExecutionSafetyRow } from "../utils/row-mappers";

export interface SafetyTransitionOptions {
  readonly eventType?: string;
  readonly occurredAt?: string;
  readonly safetyEventId?: string;
  readonly failureAuditEventId?: string | null;
}

export class SafetyRepository {
  async findSafetyStateBySessionId(
    executor: DatabaseExecutor,
    sessionId: string,
  ): Promise<StoredExecutionSafety | null> {
    const rows = await executor
      .select()
      .from(executionSafetyState)
      .where(eq(executionSafetyState.sessionId, sessionId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeExecutionSafetyRow(rows[0]);
  }

  async findSafetyStateBySessionIdForUpdate(
    executor: DatabaseExecutor,
    sessionId: string,
  ): Promise<StoredExecutionSafety | null> {
    const rows = await executor
      .select()
      .from(executionSafetyState)
      .where(eq(executionSafetyState.sessionId, sessionId))
      .for("update")
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    return decodeExecutionSafetyRow(rows[0]);
  }

  async hasEvaluationArtifactBeenAuthorized(
    executor: DatabaseExecutor,
    params: { groundingResultId: string; policyDecisionId: string },
  ): Promise<boolean> {
    const rows = await executor
      .select({ safetyEventId: executionSafetyEvents.safetyEventId })
      .from(executionSafetyEvents)
      .where(
        and(
          eq(executionSafetyEvents.eventType, "AUTHORIZATION_ISSUED"),
          or(
            eq(
              executionSafetyEvents.groundingResultId,
              params.groundingResultId,
            ),
            eq(executionSafetyEvents.policyDecisionId, params.policyDecisionId),
          ),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  async createInitialSafetyState(
    executor: DatabaseExecutor,
    sessionId: string,
    updatedAt: string,
  ): Promise<StoredExecutionSafety> {
    const insertedRows = await executor
      .insert(executionSafetyState)
      .values({
        sessionId,
        generation: 0,
        durableStatus: "UNAUTHORIZED",
        failureCode: null,
        reason: "Initial safety state on cue ingestion.",
        blockedAt: null,
        evaluatedCandidateId: null,
        groundingResultId: null,
        policyDecisionId: null,
        updatedAt,
      })
      .returning();

    return decodeExecutionSafetyRow(insertedRows[0]);
  }

  async transitionSafety(
    executor: DatabaseExecutor,
    command: SafetyTransitionCommand,
    options?: SafetyTransitionOptions,
  ): Promise<StoredExecutionSafety> {
    const nextStatus = command.nextState.status;
    const failureCode =
      command.nextState.status === "BLOCKED" ? command.nextState.failure : null;
    const blockedAt =
      command.nextState.status === "BLOCKED"
        ? command.nextState.blockedAt
        : null;

    const updatedRows = await executor
      .update(executionSafetyState)
      .set({
        generation: command.expectedGeneration + 1,
        durableStatus: nextStatus,
        failureCode,
        reason: command.nextState.reason,
        blockedAt,
        evaluatedCandidateId: command.nextState.evaluatedCandidateId,
        groundingResultId: command.nextState.groundingResultId,
        policyDecisionId: command.nextState.policyDecisionId,
        updatedAt: command.nextState.updatedAt,
      })
      .where(
        and(
          eq(executionSafetyState.sessionId, command.sessionId),
          eq(executionSafetyState.generation, command.expectedGeneration),
        ),
      )
      .returning();

    if (updatedRows.length === 0) {
      throw PersistenceError.staleWrite(
        `Execution safety state for session "${command.sessionId}" could not be advanced from generation ${command.expectedGeneration}.`,
        {
          sessionId: command.sessionId,
          expectedGeneration: command.expectedGeneration,
        },
      );
    }

    const eventId = options?.safetyEventId ?? randomUUID();
    const eventType =
      options?.eventType ??
      (command.nextState.status === "BLOCKED"
        ? "SAFETY_REVOCATION"
        : "SAFETY_TRANSITION");

    await executor.insert(executionSafetyEvents).values({
      safetyEventId: eventId,
      sessionId: command.sessionId,
      fromGeneration: command.expectedGeneration,
      toGeneration: command.expectedGeneration + 1,
      eventType,
      candidateId: command.nextState.evaluatedCandidateId,
      groundingResultId: command.nextState.groundingResultId,
      policyDecisionId: command.nextState.policyDecisionId,
      failureAuditEventId: options?.failureAuditEventId ?? null,
      eventKey: command.commandIdempotencyKey,
      reason: command.nextState.reason,
      occurredAt: options?.occurredAt ?? command.nextState.updatedAt,
    });

    return decodeExecutionSafetyRow(updatedRows[0]);
  }
}

export const safetyRepository = new SafetyRepository();
