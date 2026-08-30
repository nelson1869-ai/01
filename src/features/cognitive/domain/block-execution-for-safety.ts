import type { ExecutionRecord } from "./execution";

export function blockExecutionForSafety(
  execution: ExecutionRecord,
  reason: string,
  blockedAt: string,
): ExecutionRecord {
  // Only an execution that has not already reached a terminal
  // state may be safety-blocked.
  if (execution.status !== "PENDING" && execution.status !== "RUNNING") {
    throw new Error(
      "Only a pending or running execution can be safety-blocked.",
    );
  }

  return {
    ...execution,

    // Explicit terminal safety state.
    status: "BLOCKED",

    // Preserve startedAt/currentStepId for audit evidence.
    completedAt: blockedAt,

    // Record why execution was stopped.
    error: reason,
  };
}
