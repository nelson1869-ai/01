import { desc, eq } from "drizzle-orm";

import type { CognitivePhase } from "../domain/types";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import {
  assistantConversations,
  cognitiveSessions,
  cues,
  executions,
  learningState,
  resultVerifications,
  verifiedMemory,
} from "../persistence/postgres/schema";
import type { DashboardSnapshot } from "./dashboard-contracts";

const DASHBOARD_LIMIT = 12;

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

export async function readDashboardSnapshot(
  db: DatabaseClient,
): Promise<DashboardSnapshot> {
  const [sessionRows, executionRows, conversationRows, learningRows, memoryRows, verificationRows] =
    await Promise.all([
      db
        .select({
          sessionId: cognitiveSessions.sessionId,
          cueId: cognitiveSessions.cueId,
          cueType: cues.cueType,
          cueSource: cues.source,
          phase: cognitiveSessions.phase,
          failureCount: cognitiveSessions.failureCount,
          retryCount: cognitiveSessions.retryCount,
          maxRetries: cognitiveSessions.maxRetries,
          currentCandidateId: cognitiveSessions.currentCandidateId,
          currentPlanId: cognitiveSessions.currentPlanId,
          currentExecutionId: cognitiveSessions.currentExecutionId,
          evaluationGeneration: cognitiveSessions.evaluationGeneration,
          updatedAt: cognitiveSessions.updatedAt,
        })
        .from(cognitiveSessions)
        .innerJoin(cues, eq(cognitiveSessions.cueId, cues.cueId))
        .orderBy(desc(cognitiveSessions.updatedAt))
        .limit(DASHBOARD_LIMIT),
      db.select().from(executions).orderBy(desc(executions.updatedAt)).limit(DASHBOARD_LIMIT),
      db
        .select()
        .from(assistantConversations)
        .orderBy(desc(assistantConversations.updatedAt))
        .limit(8),
      db.select().from(learningState).orderBy(desc(learningState.updatedAt)).limit(8),
      db.select().from(verifiedMemory).orderBy(desc(verifiedMemory.verifiedAt)).limit(8),
      db
        .select()
        .from(resultVerifications)
        .orderBy(desc(resultVerifications.verifiedAt))
        .limit(8),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    sessions: sessionRows.map((row) => ({
      ...row,
      phase: row.phase as CognitivePhase,
      updatedAt: iso(row.updatedAt),
    })),
    executions: executionRows.map((row) => ({
      executionId: row.executionId,
      sessionId: row.sessionId,
      planId: row.planId,
      status: row.status,
      currentStepId: row.currentStepId,
      error: row.error,
      startedAt: optionalIso(row.startedAt),
      completedAt: optionalIso(row.completedAt),
      updatedAt: iso(row.updatedAt),
    })),
    conversations: conversationRows.map((row) => ({
      conversationId: row.conversationId,
      turnCount: row.turnCount,
      updatedAt: iso(row.updatedAt),
      expiresAt: iso(row.expiresAt),
    })),
    learning: learningRows.map((row) => ({
      skillKey: row.skillKey,
      confidence: Number(row.confidence),
      totalReward: Number(row.totalReward),
      sampleCount: row.sampleCount,
      updatedAt: iso(row.updatedAt),
    })),
    memories: memoryRows.map((row) => ({
      memoryId: row.memoryId,
      kind: row.kind,
      key: row.memoryKey,
      version: row.memoryVersion,
      confidence: Number(row.confidence),
      verifiedAt: iso(row.verifiedAt),
    })),
    verifications: verificationRows.map((row) => ({
      verificationId: row.verificationId,
      executionId: row.executionId,
      status: row.status,
      confidence: Number(row.confidence),
      reason: row.reason,
      verifiedAt: iso(row.verifiedAt),
    })),
  };
}
