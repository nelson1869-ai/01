import type { AgentContext, FailureStatus } from "./types";

export type RecoveryFailure = Exclude<
  FailureStatus,
  "COOLDOWN_ACTIVE" | "ESCALATED_TO_HUMAN"
>;

export type RecoveryAction =
  | "RETRY_WITH_FRESH_CONTEXT"
  | "START_COOLDOWN"
  | "ESCALATE_TO_HUMAN";

export type FailureRecoveryDecision = Readonly<{
  failure: RecoveryFailure;
  action: RecoveryAction;
  failureCount: number;
  retryCount: number;
  reason: string;
}>;

export function decideFailureRecovery(
  context: AgentContext,
  failure: RecoveryFailure,
): FailureRecoveryDecision {
  const failureCount = context.failureCount + 1;
  const hasRetryBudget = context.retryCount < context.maxRetries;

  // Policy violations always fail closed.
  if (failure === "POLICY_VIOLATION") {
    return {
      failure,
      action: "ESCALATE_TO_HUMAN",
      failureCount,
      retryCount: context.retryCount,
      reason: "Policy violation detected. Autonomous retry is not allowed.",
    };
  }

  // Failure #1 → retry using fresh temporary context.
  if (failureCount === 1 && hasRetryBudget) {
    return {
      failure,
      action: "RETRY_WITH_FRESH_CONTEXT",
      failureCount,
      retryCount: context.retryCount,
      reason: "First failure. Retry with fresh grounded context.",
    };
  }

  // Failure #2 → cooldown only if another retry remains available.
  if (failureCount === 2 && hasRetryBudget) {
    return {
      failure,
      action: "START_COOLDOWN",
      failureCount,
      retryCount: context.retryCount,
      reason: "Repeated failure. Start cooldown before another retry.",
    };
  }

  // Failure #3+, or no retry budget → human control.
  return {
    failure,
    action: "ESCALATE_TO_HUMAN",
    failureCount,
    retryCount: context.retryCount,
    reason: hasRetryBudget
      ? "Failure threshold reached. Human review is required."
      : "Retry budget exhausted. Human review is required.",
  };
}
