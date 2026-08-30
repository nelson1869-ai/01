import type { FailureAuditEvent } from "./failure-audit";
import type { FailureRecoveryDecision } from "./failure-recovery";
import type { AgentContext } from "./types";

export type CreateFailureAuditInput = Readonly<{
  id: string;
  evidenceIds: readonly string[];
  createdAt: string;
}>;

export function createFailureAuditEvent(
  context: AgentContext,
  decision: FailureRecoveryDecision,
  input: CreateFailureAuditInput,
): FailureAuditEvent {
  return {
    id: input.id,
    sessionId: context.sessionId,

    failure: decision.failure,
    action: decision.action,

    // Record where the failure happened,
    // before recovery changes the phase.
    phase: context.phase,

    failureCount: decision.failureCount,
    retryCount: context.retryCount,

    reason: decision.reason,

    // Durable references only.
    // Do not copy temporary reasoning into the audit record.
    evidenceIds: [...input.evidenceIds],

    createdAt: input.createdAt,
  };
}
