import type { GroundingResult } from "./grounding";
import type { PolicyDecision } from "./policy-decision";
import type { RecoveryFailure } from "./failure-recovery";
import type { AgentContext } from "./types";

export type ExecutionSafetyStatus = "ALLOWED" | "BLOCKED";

const executionAuthorizationBrand: unique symbol = Symbol(
  "executionAuthorization",
);

export type AllowedExecutionSafetyState = Readonly<{
  status: "ALLOWED";
  candidateId: string;
  failure: null;
  reason: null;
  blockedAt: null;
  [executionAuthorizationBrand]: string;
}>;

export type BlockedExecutionSafetyState = Readonly<{
  status: "BLOCKED";
  candidateId: null;
  failure: RecoveryFailure;
  reason: string;
  blockedAt: string;
}>;

export type ExecutionSafetyState =
  | AllowedExecutionSafetyState
  | BlockedExecutionSafetyState;

// ============================================================
// BLOCK AUTONOMOUS EXECUTION
// ============================================================
export function blockAutonomousExecution(
  failure: RecoveryFailure,
  reason: string,
  blockedAt: string,
): BlockedExecutionSafetyState {
  return {
    status: "BLOCKED",
    candidateId: null,
    failure,
    reason,
    blockedAt,
  };
}

// ============================================================
// RE-ENABLE AUTONOMOUS EXECUTION
// ============================================================
export function allowAutonomousExecution(
  context: AgentContext,
  grounding: GroundingResult,
  policy: PolicyDecision,
): AllowedExecutionSafetyState {
  // Authorization may only be minted at the policy gate. Recovery terminal
  // states and every other phase fail closed.
  if (context.phase !== "POLICY_SAFETY") {
    throw new Error(
      "Autonomous execution can only be authorized during POLICY_SAFETY.",
    );
  }

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

  const authorization = {
    status: "ALLOWED" as const,
    candidateId: grounding.candidateId,
    failure: null,
    reason: null,
    blockedAt: null,
  };

  // Keep the private candidate binding out of object spread/serialization,
  // and freeze the issued capability so it cannot be retargeted in place.
  Object.defineProperty(authorization, executionAuthorizationBrand, {
    value: grounding.candidateId,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(authorization) as AllowedExecutionSafetyState;
}

export function isAllowedExecutionSafetyState(
  safety: ExecutionSafetyState,
): safety is AllowedExecutionSafetyState {
  return (
    safety.status === "ALLOWED" &&
    safety[executionAuthorizationBrand] === safety.candidateId
  );
}
