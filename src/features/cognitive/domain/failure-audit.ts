import type { RecoveryAction, RecoveryFailure } from "./failure-recovery";
import type { CognitivePhase } from "./types";

export type FailureAuditEvent = Readonly<{
  id: string;
  sessionId: string;

  failure: RecoveryFailure;
  action: RecoveryAction;

  phase: CognitivePhase;

  failureCount: number;
  retryCount: number;

  reason: string;

  // References to durable evidence.
  // We avoid storing temporary reasoning or guesses here.
  evidenceIds: readonly string[];

  createdAt: string;
}>;
