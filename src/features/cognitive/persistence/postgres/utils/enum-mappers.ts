import type {
  ExecutionSafetyState,
  UnauthorizedExecutionSafetyState,
  BlockedExecutionSafetyState,
} from "../../../domain/execution-safety";
import type { GroundingStatus } from "../../../domain/grounding";
import type { PolicyOutcome } from "../../../domain/policy-decision";
import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";

export function mapPersistedGroundingStatusToDomain(
  status: PersistedGroundingResult["status"],
): GroundingStatus {
  switch (status) {
    case "VERIFIED":
      return "VERIFIED";
    case "CONTRADICTED":
      return "CONFLICTING_EVIDENCE";
    case "UNVERIFIED":
      return "INSUFFICIENT_EVIDENCE";
    default: {
      const _exhaustive: never = status;
      throw new Error(
        `Unknown persisted grounding status: ${String(_exhaustive)}`,
      );
    }
  }
}

export function mapPersistedPolicyOutcomeToDomain(
  outcome: PersistedPolicyDecision["outcome"],
): PolicyOutcome {
  switch (outcome) {
    case "ALLOW":
      return "ALLOW";
    case "REQUIRE_HUMAN_CONFIRMATION":
      return "REQUIRE_APPROVAL";
    case "DENY":
      return "DENY";
    default: {
      const _exhaustive: never = outcome;
      throw new Error(
        `Unknown persisted policy outcome: ${String(_exhaustive)}`,
      );
    }
  }
}

export function mapStoredSafetyToDomain(
  safety: StoredExecutionSafety,
): ExecutionSafetyState {
  if (safety.status === "BLOCKED") {
    if (!safety.failure || !safety.blockedAt) {
      throw new Error(
        `Stored safety state is BLOCKED but missing failure or blockedAt.`,
      );
    }
    const blocked: BlockedExecutionSafetyState = {
      status: "BLOCKED",
      generation: safety.generation,
      candidateId: null,
      failure: safety.failure,
      reason: safety.reason,
      blockedAt: safety.blockedAt,
    };
    return blocked;
  }

  const unauthorized: UnauthorizedExecutionSafetyState = {
    status: "UNAUTHORIZED",
    generation: safety.generation,
    candidateId: null,
    failure: null,
    reason: safety.reason,
    blockedAt: null,
  };
  return unauthorized;
}
