import type { GroundingResult } from "./grounding";
import type { PolicyDecision } from "./policy-decision";
import type { RecoveryFailure } from "./failure-recovery";

export type ExecutionSafetyStatus = "ALLOWED" | "BLOCKED";

export type ExecutionSafetyState = Readonly<{
  status: ExecutionSafetyStatus;

  // Present when execution was blocked because of a failure.
  failure: RecoveryFailure | null;

  // Explanation for audit/debugging.
  reason: string | null;

  // Timestamp when blocking happened.
  blockedAt: string | null;
}>;

// ============================================================
// BLOCK AUTONOMOUS EXECUTION
// ============================================================
export function blockAutonomousExecution(
  failure: RecoveryFailure,
  reason: string,
  blockedAt: string,
): ExecutionSafetyState {
  return {
    status: "BLOCKED",
    failure,
    reason,
    blockedAt,
  };
}

// ============================================================
// RE-ENABLE AUTONOMOUS EXECUTION
// ============================================================
export function allowAutonomousExecution(
  grounding: GroundingResult,
  policy: PolicyDecision,
): ExecutionSafetyState {
  // Grounding must independently verify the candidate.
  if (grounding.status !== "VERIFIED") {
    throw new Error("Autonomous execution requires verified grounding.");
  }

  // Policy must explicitly permit autonomous execution.
  if (policy.outcome !== "ALLOW") {
    throw new Error("Autonomous execution requires an ALLOW policy decision.");
  }

  // Both safety decisions must refer to the exact same candidate.
  if (grounding.candidateId !== policy.candidateId) {
    throw new Error(
      "Grounding and policy decisions must reference the same candidate.",
    );
  }

  return {
    status: "ALLOWED",
    failure: null,
    reason: null,
    blockedAt: null,
  };
}
