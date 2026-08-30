import type { FailureStatus } from "./types";

export type RecoveryAction =
  | "RETRY_WITH_FRESH_CONTEXT"
  | "START_COOLDOWN"
  | "ESCALATE_TO_HUMAN";

export type FailureRecoveryDecision = Readonly<{
  failure: FailureStatus;
  action: RecoveryAction;
  retryCount: number;
  reason: string;
}>;
