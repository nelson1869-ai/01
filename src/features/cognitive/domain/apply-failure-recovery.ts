import type { FailureRecoveryDecision } from "./failure-recovery";
import { applyFreshContextRetry } from "./fresh-context-retry";
import { startFailureCooldown } from "./cooldown";
import { escalateToHuman } from "./human-escalation";
import type { AgentContext } from "./types";

export function applyFailureRecovery(
  context: AgentContext,
  decision: FailureRecoveryDecision,
  nowMs: number,
): AgentContext {
  switch (decision.action) {
    case "RETRY_WITH_FRESH_CONTEXT":
      return applyFreshContextRetry(context, decision);

    case "START_COOLDOWN":
      return startFailureCooldown(context, decision, nowMs);

    case "ESCALATE_TO_HUMAN":
      return escalateToHuman(context, decision);
  }
}
