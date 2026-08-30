import { blockExecutionForSafety } from "./block-execution-for-safety";

import {
  recoverFromFailure,
  type FailureRecoveryResult,
} from "./recover-from-failure";

import type { CreateFailureAuditInput } from "./create-failure-audit";
import type { ExecutionSafetyState } from "./execution-safety";
import type { ExecutionRecord } from "./execution";
import type { RecoveryFailure } from "./failure-recovery";
import type { AgentContext } from "./types";

export type ExecutionFailureRecoveryResult = Readonly<{
  recovery: FailureRecoveryResult;
  execution: ExecutionRecord;
}>;

export function recoverExecutionFromFailure(
  context: AgentContext,
  execution: ExecutionRecord,
  currentExecutionSafety: ExecutionSafetyState,
  failure: RecoveryFailure,
  nowMs: number,
  auditInput: CreateFailureAuditInput,
): ExecutionFailureRecoveryResult {
  // ============================================================
  // 1. RECOVER COGNITIVE STATE
  // ============================================================
  // This also:
  // - creates the failure audit
  // - blocks autonomous execution permission
  // - chooses retry / cooldown / human review
  const recovery = recoverFromFailure(
    context,
    currentExecutionSafety,
    failure,
    nowMs,
    auditInput,
  );

  // ============================================================
  // 2. STOP THE ACTIVE EXECUTION RECORD
  // ============================================================
  const blockedExecution = blockExecutionForSafety(
    execution,
    recovery.decision.reason,
    auditInput.createdAt,
  );

  // ============================================================
  // 3. RETURN BOTH STATES
  // ============================================================
  return {
    recovery,
    execution: blockedExecution,
  };
}
