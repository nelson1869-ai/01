import {
  decideFailureRecovery,
  type FailureRecoveryDecision,
  type RecoveryFailure,
} from "./failure-recovery";
import { applyFailureRecovery } from "./apply-failure-recovery";
import type { AgentContext } from "./types";

export type FailureRecoveryResult = Readonly<{
  context: AgentContext;
  decision: FailureRecoveryDecision;
}>;

export function recoverFromFailure(
  context: AgentContext,
  failure: RecoveryFailure,
  nowMs: number,
): FailureRecoveryResult {
  const decision = decideFailureRecovery(context, failure);

  const recoveredContext = applyFailureRecovery(context, decision, nowMs);

  return {
    context: recoveredContext,
    decision,
  };
}
