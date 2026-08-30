import {
  createFailureAuditEvent,
  type CreateFailureAuditInput,
} from "./create-failure-audit";

import {
  decideFailureRecovery,
  type FailureRecoveryDecision,
  type RecoveryFailure,
} from "./failure-recovery";

import { applyFailureRecovery } from "./apply-failure-recovery";
import type { FailureAuditEvent } from "./failure-audit";
import type { AgentContext } from "./types";

export type FailureRecoveryResult = Readonly<{
  context: AgentContext;
  decision: FailureRecoveryDecision;
  audit: FailureAuditEvent;
}>;

export function recoverFromFailure(
  context: AgentContext,
  failure: RecoveryFailure,
  nowMs: number,
  auditInput: CreateFailureAuditInput,
): FailureRecoveryResult {
  // ============================================================
  // 1. DECIDE RECOVERY
  // ============================================================
  // Determine whether the system should:
  // - retry with fresh context
  // - enter cooldown
  // - escalate to human
  const decision = decideFailureRecovery(context, failure);

  // ============================================================
  // 2. PRESERVE AUDIT EVIDENCE
  // ============================================================
  // Important:
  // Create the audit record BEFORE recovery clears temporary
  // working-memory assumptions.
  const audit = createFailureAuditEvent(context, decision, auditInput);

  // ============================================================
  // 3. APPLY RECOVERY
  // ============================================================
  const recoveredContext = applyFailureRecovery(context, decision, nowMs);

  // ============================================================
  // 4. RETURN RESULT
  // ============================================================
  return {
    context: recoveredContext,
    decision,
    audit,
  };
}
