import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";

import {
  persistedAssistantConversationSchema,
  persistedAssistantTurnSchema,
  type AssistantTurnKind,
  type AssistantTurnStatus,
  type PersistedAssistantConversation,
  type PersistedAssistantTurn,
} from "../../contracts/assistant-conversation";
import { PersistenceError } from "../errors/persistence-errors";
import { assistantConversations, assistantTurns } from "../schema/assistant";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";

const CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function decodeConversation(row: typeof assistantConversations.$inferSelect) {
  return persistedAssistantConversationSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  });
}

function decodeTurn(row: typeof assistantTurns.$inferSelect) {
  return persistedAssistantTurnSchema.parse({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
  });
}

export interface CompleteAssistantTurnInput {
  readonly turnId: string;
  readonly kind: AssistantTurnKind;
  readonly status: Exclude<AssistantTurnStatus, "PROCESSING">;
  readonly assistantMessage: string;
  readonly decisionSummary: readonly string[];
  readonly cueId?: string | null;
  readonly sessionId?: string | null;
  readonly executionId?: string | null;
  readonly verificationId?: string | null;
  readonly completedAt: string;
}

export class AssistantConversationRepository {
  async createConversation(
    executor: DatabaseExecutor,
    conversationId: string,
    now: string,
  ): Promise<PersistedAssistantConversation> {
    const expiresAt = new Date(Date.parse(now) + CONVERSATION_RETENTION_MS).toISOString();
    const rows = await executor
      .insert(assistantConversations)
      .values({ conversationId, turnCount: 0, rowVersion: 0, createdAt: now, updatedAt: now, expiresAt })
      .returning();
    return decodeConversation(rows[0]);
  }

  async findConversationById(
    executor: DatabaseExecutor,
    conversationId: string,
  ): Promise<PersistedAssistantConversation | null> {
    const rows = await executor
      .select()
      .from(assistantConversations)
      .where(eq(assistantConversations.conversationId, conversationId))
      .limit(1);
    return rows.length === 0 ? null : decodeConversation(rows[0]);
  }

  async pruneExpiredConversations(
    executor: DatabaseExecutor,
    now: string,
    limit = 100,
  ): Promise<number> {
    const expired = await executor
      .select({ conversationId: assistantConversations.conversationId })
      .from(assistantConversations)
      .where(lt(assistantConversations.expiresAt, now))
      .orderBy(asc(assistantConversations.expiresAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    if (expired.length === 0) return 0;
    const deleted = await executor
      .delete(assistantConversations)
      .where(inArray(assistantConversations.conversationId, expired.map((row) => row.conversationId)))
      .returning({ conversationId: assistantConversations.conversationId });
    return deleted.length;
  }

  async beginTurn(
    executor: DatabaseExecutor,
    input: {
      readonly turnId: string;
      readonly conversationId: string;
      readonly userMessage: string;
      readonly createdAt: string;
    },
  ): Promise<PersistedAssistantTurn> {
    return await runInTransaction(executor, async (tx) => {
      const conversations = await tx
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.conversationId, input.conversationId))
        .for("update")
        .limit(1);
      if (conversations.length === 0 || Date.parse(conversations[0].expiresAt) <= Date.parse(input.createdAt)) {
        throw PersistenceError.notFound(`Assistant conversation "${input.conversationId}" was not found or has expired.`);
      }

      const conversation = decodeConversation(conversations[0]);
      const ordinal = conversation.turnCount + 1;
      const rows = await tx
        .insert(assistantTurns)
        .values({
          turnId: input.turnId,
          conversationId: input.conversationId,
          ordinal,
          userMessage: input.userMessage,
          status: "PROCESSING",
          decisionSummary: [],
          createdAt: input.createdAt,
        })
        .returning();

      await tx
        .update(assistantConversations)
        .set({ turnCount: ordinal, rowVersion: conversation.rowVersion + 1, updatedAt: input.createdAt })
        .where(
          and(
            eq(assistantConversations.conversationId, input.conversationId),
            eq(assistantConversations.rowVersion, conversation.rowVersion),
          ),
        );
      return decodeTurn(rows[0]);
    });
  }

  async completeTurn(
    executor: DatabaseExecutor,
    input: CompleteAssistantTurnInput,
  ): Promise<PersistedAssistantTurn> {
    const rows = await executor
      .update(assistantTurns)
      .set({
        kind: input.kind,
        status: input.status,
        assistantMessage: input.assistantMessage,
        decisionSummary: [...input.decisionSummary],
        cueId: input.cueId ?? null,
        sessionId: input.sessionId ?? null,
        executionId: input.executionId ?? null,
        verificationId: input.verificationId ?? null,
        completedAt: input.completedAt,
      })
      .where(and(eq(assistantTurns.turnId, input.turnId), eq(assistantTurns.status, "PROCESSING")))
      .returning();
    if (rows.length === 0) {
      throw PersistenceError.staleWrite(`Assistant turn "${input.turnId}" is no longer processing.`);
    }
    return decodeTurn(rows[0]);
  }

  async findRecentCompletedTurns(
    executor: DatabaseExecutor,
    conversationId: string,
    limit: number,
  ): Promise<PersistedAssistantTurn[]> {
    const rows = await executor
      .select()
      .from(assistantTurns)
      .where(and(eq(assistantTurns.conversationId, conversationId), ne(assistantTurns.status, "PROCESSING")))
      .orderBy(desc(assistantTurns.ordinal))
      .limit(Math.min(Math.max(limit, 1), 12));
    return rows
      .map(decodeTurn)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async findAllTurnsForConversation(
    executor: DatabaseExecutor,
    conversationId: string,
  ): Promise<PersistedAssistantTurn[]> {
    const rows = await executor
      .select()
      .from(assistantTurns)
      .where(eq(assistantTurns.conversationId, conversationId))
      .orderBy(asc(assistantTurns.ordinal));
    return rows.map(decodeTurn);
  }
}

export const assistantConversationRepository = new AssistantConversationRepository();
