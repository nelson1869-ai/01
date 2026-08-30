import type { FailureRecoveryDecision } from "./failure-recovery";
import type { AgentContext } from "./types";

export function escalateToHuman(
  context: AgentContext,
  decision: FailureRecoveryDecision,
): AgentContext {
  if (decision.action !== "ESCALATE_TO_HUMAN") {
    throw new Error(
      "Human escalation requires an escalation recovery decision.",
    );
  }

  const cue = context.workingMemory.cue;

  return {
    ...context,

    // Autonomous processing stops here.
    phase: "HUMAN_REVIEW",

    // Preserve the failure count that triggered escalation.
    failureCount: decision.failureCount,

    // No cooldown is needed once human review takes control.
    cooldownUntilMs: null,

    // Remove temporary assumptions while preserving the root event.
    workingMemory: cue === undefined ? {} : { cue },
  };
}
