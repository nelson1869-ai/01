import type { GroundingResult } from "./grounding";
import type { PolicyDecision } from "./policy-decision";
import type { RecoveryFailure } from "./failure-recovery";
import type { AgentContext } from "./types";

export type ExecutionSafetyStatus = "UNAUTHORIZED" | "ALLOWED" | "BLOCKED";

const executionAuthorizationBrand: unique symbol = Symbol(
  "executionAuthorization",
);

export type AllowedExecutionSafetyState = Readonly<{
  status: "ALLOWED";
  generation: number;
  candidateId: string;
  failure: null;
  reason: null;
  blockedAt: null;
  [executionAuthorizationBrand]: string;
}>;

export type BlockedExecutionSafetyState = Readonly<{
  status: "BLOCKED";
  generation: number;
  candidateId: null;
  failure: RecoveryFailure;
  reason: string;
  blockedAt: string;
}>;

export type UnauthorizedExecutionSafetyState = Readonly<{
  status: "UNAUTHORIZED";
  generation: number;
  candidateId: null;
  failure: null;
  reason: string;
  blockedAt: null;
}>;

export type ExecutionSafetyState =
  | UnauthorizedExecutionSafetyState
  | AllowedExecutionSafetyState
  | BlockedExecutionSafetyState;

function nextGeneration(safety: ExecutionSafetyState): number {
  if (
    !Number.isSafeInteger(safety.generation) ||
    safety.generation < 0 ||
    safety.generation >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Execution safety generation is invalid.");
  }

  return safety.generation + 1;
}

export function createInitialExecutionSafetyState(): UnauthorizedExecutionSafetyState {
  return {
    status: "UNAUTHORIZED",
    generation: 0,
    candidateId: null,
    failure: null,
    reason: "Autonomous execution has not been authorized.",
    blockedAt: null,
  };
}

// ============================================================
// BLOCK AUTONOMOUS EXECUTION
// ============================================================
export function blockAutonomousExecution(
  currentSafety: ExecutionSafetyState,
  failure: RecoveryFailure,
  reason: string,
  blockedAt: string,
): BlockedExecutionSafetyState {
  return {
    status: "BLOCKED",
    generation: nextGeneration(currentSafety),
    candidateId: null,
    failure,
    reason,
    blockedAt,
  };
}

export type GroundingAuthorizationDecision =
  | GroundingResult
  | Readonly<Pick<GroundingResult, "candidateId" | "status">>;

export type PolicyAuthorizationDecision =
  | PolicyDecision
  | Readonly<Pick<PolicyDecision, "candidateId" | "outcome">>;

// ============================================================
// RE-ENABLE AUTONOMOUS EXECUTION
// ============================================================
export function allowAutonomousExecution(
  currentSafety: ExecutionSafetyState,
  context: Pick<AgentContext, "phase">,
  grounding: GroundingAuthorizationDecision,
  policy: PolicyAuthorizationDecision,
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
    generation: nextGeneration(currentSafety),
    candidateId: grounding.candidateId,
    failure: null,
    reason: null,
    blockedAt: null,
  };

  // Keep the private candidate binding out of object spread/serialization,
  // and freeze the issued capability so it cannot be retargeted in place.
  Object.defineProperty(authorization, executionAuthorizationBrand, {
    value: `${authorization.generation}:${grounding.candidateId}`,
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
    safety[executionAuthorizationBrand] ===
      `${safety.generation}:${safety.candidateId}`
  );
}
