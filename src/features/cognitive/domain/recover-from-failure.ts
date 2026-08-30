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

import {
  blockAutonomousExecution,
  type ExecutionSafetyState,
} from "./execution-safety";

import type { FailureAuditEvent } from "./failure-audit";
import type { AgentContext } from "./types";

export type FailureRecoveryResult = Readonly<{
  context: AgentContext;
  decision: FailureRecoveryDecision;
  audit: FailureAuditEvent;
  executionSafety: ExecutionSafetyState;
}>;

export function recoverFromFailure(
  context: AgentContext,
  currentExecutionSafety: ExecutionSafetyState,
  failure: RecoveryFailure,
  nowMs: number,
  auditInput: CreateFailureAuditInput,
): FailureRecoveryResult {
  // ============================================================
  // 1. DECIDE RECOVERY
  // ============================================================
  const decision = decideFailureRecovery(context, failure);

  // ============================================================
  // 2. PRESERVE AUDIT EVIDENCE
  // ============================================================
  // Capture failure information before temporary memory is cleared.
  const audit = createFailureAuditEvent(context, decision, auditInput);

  // ============================================================
  // 3. BLOCK AUTONOMOUS EXECUTION
  // ============================================================
  // Failure means no more tool/action execution is allowed
  // until the system passes through a safe recovery path.
  const executionSafety = blockAutonomousExecution(
    currentExecutionSafety,
    failure,
    decision.reason,
    auditInput.createdAt,
  );

  // ============================================================
  // 4. APPLY RECOVERY
  // ============================================================
  const recoveredContext = applyFailureRecovery(context, decision, nowMs);

  // ============================================================
  // 5. RETURN RESULT
  // ============================================================
  return {
    context: recoveredContext,
    decision,
    audit,
    executionSafety,
  };
}
