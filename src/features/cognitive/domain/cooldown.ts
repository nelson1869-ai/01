import type { FailureRecoveryDecision } from "./failure-recovery";
import type { AgentContext } from "./types";

export const FAILURE_COOLDOWN_MS = 4 * 60 * 1000;

export function startFailureCooldown(
  context: AgentContext,
  decision: FailureRecoveryDecision,
  nowMs: number,
): AgentContext {
  if (decision.action !== "START_COOLDOWN") {
    throw new Error("Failure cooldown requires a cooldown recovery decision.");
  }

  const cue = context.workingMemory.cue;

  return {
    ...context,
    phase: "COOLDOWN",
    failureCount: decision.failureCount,
    cooldownUntilMs: nowMs + FAILURE_COOLDOWN_MS,

    // Remove temporary assumptions, but keep the original event.
    workingMemory: cue === undefined ? {} : { cue },
  };
}
