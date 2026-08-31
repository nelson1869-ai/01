import type { CognitivePhase } from "../domain/types";

export interface DashboardSessionSummary {
  readonly sessionId: string;
  readonly cueId: string;
  readonly cueType: string;
  readonly cueSource: string;
  readonly phase: CognitivePhase;
  readonly failureCount: number;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly currentCandidateId: string | null;
  readonly currentPlanId: string | null;
  readonly currentExecutionId: string | null;
  readonly evaluationGeneration: number;
  readonly updatedAt: string;
}

export interface DashboardExecutionSummary {
  readonly executionId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly status: string;
  readonly currentStepId: string | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface DashboardConversationSummary {
  readonly conversationId: string;
  readonly turnCount: number;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface DashboardLearningSummary {
  readonly skillKey: string;
  readonly confidence: number;
  readonly totalReward: number;
  readonly sampleCount: number;
  readonly updatedAt: string;
}

export interface DashboardMemorySummary {
  readonly memoryId: string;
  readonly kind: string;
  readonly key: string;
  readonly version: number;
  readonly confidence: number;
  readonly verifiedAt: string;
}

export interface DashboardVerificationSummary {
  readonly verificationId: string;
  readonly executionId: string;
  readonly status: string;
  readonly confidence: number;
  readonly reason: string;
  readonly verifiedAt: string;
}

export interface DashboardSnapshot {
  readonly generatedAt: string;
  readonly sessions: readonly DashboardSessionSummary[];
  readonly executions: readonly DashboardExecutionSummary[];
  readonly conversations: readonly DashboardConversationSummary[];
  readonly learning: readonly DashboardLearningSummary[];
  readonly memories: readonly DashboardMemorySummary[];
  readonly verifications: readonly DashboardVerificationSummary[];
}
